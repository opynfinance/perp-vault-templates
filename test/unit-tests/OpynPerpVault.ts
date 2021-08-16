import { ethers } from 'hardhat';
import { utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { MockAction, MockERC20, OpynPerpVault, MockWETH, MockStakedao, MockCurve } from '../../typechain';

enum VaultState {
  Emergency,
  Locked,
  Unlocked
}

describe('OpynPerpVault Tests', function () {
  let action1: MockAction;
  let action2: MockAction;
  // asset used by this action: in this case, weth
  let weth: MockWETH;
  let usdc: MockERC20;
  let sdecrv: MockStakedao;
  let curve: MockCurve;
  let ecrv: MockERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;

  this.beforeAll('Set accounts', async () => {
    accounts = await ethers.getSigners();
    const [_owner, _feeRecipient, _depositor1, _depositor2, _depositor3] = accounts;

    owner = _owner;
    feeRecipient = _feeRecipient;

    depositor1 = _depositor1;
    depositor2 = _depositor2;
    depositor3 = _depositor3;
  });

  this.beforeAll('Deploy Mock contracts', async () => {
    const MockWETHContract = await ethers.getContractFactory('MockWETH');
    weth = (await MockWETHContract.deploy()) as MockWETH;
    await weth.init('WETH', 'WETH', 18);

    const ERC20 = await ethers.getContractFactory('MockERC20');
    usdc = (await ERC20.deploy()) as MockERC20;
    await usdc.init('USDC', 'USDC', 6);

    ecrv = (await ERC20.deploy()) as MockERC20;
    await ecrv.init('ecrv', 'ecrv', 18);

    const Curve = await ethers.getContractFactory('MockCurve');
    curve = (await Curve.deploy(ecrv.address)) as MockCurve;

    const StakeDao = await ethers.getContractFactory('MockStakedao');
    sdecrv = (await StakeDao.deploy()) as MockStakedao;
    await sdecrv.init('ecrv', 'ecrv', 18, ecrv.address);
  });

  this.beforeAll('Deploy vault and mock actions', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy(
      sdecrv.address,
      curve.address,
      feeRecipient.address,
      'OpynPerpShortVault share',
      'sOPS'
    )) as OpynPerpVault;

    // deploy 2 mock actions
    const MockActionContract = await ethers.getContractFactory('MockAction');
    action1 = await MockActionContract.deploy(vault.address, sdecrv.address) as MockAction;
    action2 = await MockActionContract.deploy(vault.address, sdecrv.address) as MockAction;
  });

  describe('init', async () => {
    it('should revert when trying to call setActions with duplicated actions', async() => {
      await expect(
        vault
        .connect(owner)
        .setActions(
          [action1.address, action2.address, action2.address]
        )
      ).to.be.revertedWith('O5');
      
      await expect(
        vault
        .connect(owner)
        .setActions(
          [action1.address, action2.address, action1.address]
        )
      ).to.be.revertedWith('O5');
      
    })

    it('should revert when trying to set action address 0', async() => {
      await expect(
        vault
        .connect(owner)
        .setActions(
          ['0x0000000000000000000000000000000000000000']
        )
      ).to.be.revertedWith('O4');
    })

    it('should not be able to deposit, withdraw, rollover or closePosition before actions are set', async() => {
      await expect(vault.connect(depositor1).depositETH('1', { value: '1' })).to.be.revertedWith('O1');
      await expect(vault.connect(depositor1).withdrawETH('1', '1')).to.be.revertedWith('O1');
      await expect(vault.connect(owner).rollOver([4000, 5000])).to.be.revertedWith('O1');
      await expect(vault.connect(owner).closePositions()).to.be.revertedWith('O1');
    })
    
    it('should init the contract successfully', async () => {
      await vault
        .connect(owner)
        .setActions(
          [action1.address, action2.address]
        );
      // init state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalStakedaoAsset()).isZero(), 'total asset should be zero').to.be.true;
      expect((await vault.totalETHControlled()).isZero(), 'total ETH controlled should be 0').to.be.true;
    });

    it('should set fee reserve', async () => {
      await expect(
        vault.connect(owner).setWithdrawReserve(6000)
      ).to.be.revertedWith('O16');

      await vault.connect(owner).setWithdrawReserve(1000);
      expect((await vault.withdrawReserve()).toNumber() == 1000).to.be.true;
    });

    it('should revert an addrress other than curve tries to send ETH to the vault', async () => {
      // Note that anyone can still force send ETH
      await expect(
        depositor1.sendTransaction({ to: vault.address, value: utils.parseUnits('1') })
      ).to.be.revertedWith('O19');
    });

    it('should fail to set actions once the contract is already initialized', async () => {
      await expect(vault
        .connect(owner)
        .setActions(
          [action1.address, action2.address, action1.address]
        )).to.be.revertedWith('O3');
    });
  });

  describe('genesis: before first cycle start', async () => {
    const depositAmount = utils.parseUnits('10');

    it('should revert if calling depositETH with no value', async () => {
      await expect(vault.connect(depositor1).depositETH(depositAmount)).to.be.revertedWith('O6');
    });
    it('p1 deposits ETH', async () => {

      const shares1Before = await vault.balanceOf(depositor1.address)
      const expectedShares = await vault.getSharesByDepositAmount(depositAmount)
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultBalanceBefore = await sdecrv.balanceOf(vault.address);

      // depositor 1 deposit 10 eth
      await vault.connect(depositor1).depositETH(depositAmount, { value: depositAmount });

      const vaultTotalAfter = await vault.totalStakedaoAsset();
      const vaultBalanceAfter = await sdecrv.balanceOf(vault.address);

      expect(vaultTotalAfter.eq(vaultTotalBefore.add(depositAmount)), 'total stakedao asset should update').to.be.true;
      expect((await vault.totalETHControlled()).eq(vaultTotalAfter), 'total eth controlled should update').to.be.true;
      expect(vaultBalanceAfter.eq(vaultBalanceBefore.add(depositAmount)), 'actual stakedao balance should update').to.be.true;

      const shares1After = await vault.balanceOf(depositor1.address)
      expect(shares1After.sub(shares1Before).eq(expectedShares)).to.be.true
      expect(expectedShares).to.be.equal(depositAmount);
    });

    it('p1 deposits more ETH', async () => {
      const shares1Before = await vault.balanceOf(depositor1.address)
      const expectedShares = await vault.getSharesByDepositAmount(depositAmount)
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultBalanceBefore = await sdecrv.balanceOf(vault.address);

      // depositor 1 deposit 10 eth
      await vault.connect(depositor1).depositETH(depositAmount, { value: depositAmount });

      const vaultTotalAfter = await vault.totalStakedaoAsset();
      const vaultBalanceAfter = await sdecrv.balanceOf(vault.address);

      expect(vaultTotalAfter.eq(vaultTotalBefore.add(depositAmount)), 'total stakedao asset should update').to.be.true;
      expect((await vault.totalETHControlled()).eq(vaultTotalAfter), 'total eth controlled should update').to.be.true;
      expect(vaultBalanceAfter.eq(vaultBalanceBefore.add(depositAmount)), 'actual stakedao balance should update').to.be.true;

      const shares1After = await vault.balanceOf(depositor1.address)
      expect(shares1After.sub(shares1Before).eq(expectedShares)).to.be.true
      expect(expectedShares).to.be.equal(depositAmount);
    });

    it('p2 deposits', async() => {
      const shares2Before = await vault.balanceOf(depositor2.address)
      const expectedShares = await vault.getSharesByDepositAmount(depositAmount)
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultBalanceBefore = await sdecrv.balanceOf(vault.address);

      // depositor 2 deposit 10 eth
      await vault.connect(depositor2).depositETH(depositAmount, { value: depositAmount });

      const vaultTotalAfter = await vault.totalStakedaoAsset();
      const vaultBalanceAfter = await sdecrv.balanceOf(vault.address);

      expect(vaultTotalAfter.eq(vaultTotalBefore.add(depositAmount)), 'total stakedao asset should update').to.be.true;
      expect((await vault.totalETHControlled()).eq(vaultTotalAfter), 'total eth controlled should update').to.be.true;
      expect(vaultBalanceAfter.eq(vaultBalanceBefore.add(depositAmount)), 'actual stakedao balance should update').to.be.true;

      const shares2After = await vault.balanceOf(depositor2.address)
      expect(shares2After.sub(shares2Before).eq(expectedShares)).to.be.true
      expect(expectedShares).to.be.equal(depositAmount);
    })

    it('p3 should not be able to withdraw if they havent deposited', async () => {
      // depositor 3 withdraws 10 eth
      await expect(vault.connect(depositor3).withdrawETH(depositAmount, depositAmount)).to.be.revertedWith('ERC20: burn amount exceeds balance');
    });

    it('p1 should be able to withdraw ETH', async () => {
      const shares1Before = await vault.balanceOf(depositor1.address);
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultBalanceBefore = await sdecrv.balanceOf(vault.address);

      // depositor 1 withdraws 10 eth
      await vault.connect(depositor1).withdrawETH(depositAmount, depositAmount);

      const shares1After = await vault.balanceOf(depositor1.address)
      const vaultTotalAfter = await vault.totalStakedaoAsset();
      const vaultBalanceAfter = await sdecrv.balanceOf(vault.address);

      expect(shares1Before.sub(shares1After)).to.be.equal(depositAmount);
      expect(vaultBalanceBefore.sub(vaultBalanceAfter)).to.be.equal(depositAmount);
      expect(vaultTotalBefore.sub(vaultTotalAfter)).to.be.equal(depositAmount);
      expect((await vault.totalETHControlled()).eq(vaultTotalAfter), 'total eth controlled should update').to.be.true;
    });

    it('should revert when calling closePosition', async () => {
      await expect(vault.connect(owner).closePositions()).to.be.revertedWith('O11');
    });

    it('should revert if rollover is called with total percentage > 100', async () => {
      // max percentage sum should be 90% (9000) because 10% is set for reserve
      await expect(vault.connect(owner).rollOver([5000, 5000])).to.be.revertedWith(
        'O14'
      );
    });

    it('should revert if rollover is called with invalid percentage array', async () => {
      await expect(vault.connect(owner).rollOver([5000])).to.be.revertedWith('O12');
    });

    it('should rollover to the next round', async () => {
      const vaultBalanceBefore = await sdecrv.balanceOf(vault.address);
      const action1BalanceBefore = await sdecrv.balanceOf(action1.address);
      const action2BalanceBefore = await sdecrv.balanceOf(action2.address);
      const totalValueBefore = await vault.totalStakedaoAsset();

      // Distribution:
      // 40% - action1
      // 50% - action2
      await vault.connect(owner).rollOver([4000, 5000]);

      const vaultBalanceAfter = await sdecrv.balanceOf(vault.address);
      const action1BalanceAfter = await sdecrv.balanceOf(action1.address);
      const action2BalanceAfter = await sdecrv.balanceOf(action2.address);
      const totalValueAfter =  await vault.totalStakedaoAsset();

      expect(action1BalanceAfter.sub(action1BalanceBefore).eq(vaultBalanceBefore.mul(4).div(10))).to
        .be.true;
      expect(action2BalanceAfter.sub(action2BalanceBefore).eq(vaultBalanceBefore.mul(5).div(10))).to
        .be.true;

      expect(vaultBalanceAfter.eq(vaultBalanceBefore.div(10))).to.be.true;

      expect(totalValueAfter.eq(totalValueBefore), 'total value should stay uneffected').to.be.true;
      expect((await vault.totalETHControlled()).eq(totalValueAfter), 'total eth controlled should update').to.be.true;

      expect((await vault.state()) === VaultState.Locked).to.be.true;
    });

    it('should revert when trying to call rollover again', async () => {
      await expect(vault.connect(owner).rollOver([7000, 2000])).to.be.revertedWith('O13');
    });

    // it('should revert when trying to withdraw full amount', async () => {
    //   const depositor1Shares = await vault.balanceOf(depositor1.address);
    //   await expect(vault.connect(depositor1).withdraw(depositor1Shares.div(2))).to.be.revertedWith(
    //     'NOT_ENOUGH_BALANCE'
    //   );
    // });
    // it('should be able to withdraw reserved amount of asset (ETH)', async () => {
    //   const depositor1Shares = await vault.balanceOf(depositor1.address);
    //   // withdraw 10%
    //   const withdrawShareAmount = depositor1Shares.div(10);
    //   const expectedAmount = await vault.getWithdrawAmountByShares(withdrawShareAmount);

    //   const vaultBalanceBefore = await weth.balanceOf(vault.address);
    //   const totalSupplyBefore = await vault.totalSupply();
    //   const ethBalanceBefore = await depositor1.getBalance();

    //   const feeRecipientBalanceBefore = await weth.balanceOf(feeRecipient.address);

    //   // withdraw eth, (set gas price to 0 so gas won't mess with eth balances)
    //   await vault.connect(depositor1).withdrawETH(withdrawShareAmount, { gasPrice: 0 });

    //   const vaultBalanceAfter = await weth.balanceOf(vault.address);
    //   const totalSupplyAfter = await vault.totalSupply();
    //   const ethBalanceAfter = await depositor1.getBalance();

    //   const feeRecipientBalanceAfter = await weth.balanceOf(feeRecipient.address);
    //   const feeCollected = feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore);

    //   expect(ethBalanceAfter.sub(ethBalanceBefore).eq(expectedAmount)).to.be.true;
    //   expect(vaultBalanceBefore.sub(vaultBalanceAfter).eq(expectedAmount.add(feeCollected))).to.be
    //     .true;
    //   expect(totalSupplyBefore.sub(totalSupplyAfter).eq(withdrawShareAmount)).to.be.true;
    // });

    // it('should be able to withdraw reserved amount of asset (WETH)', async () => {
    //   const depositor2Shares = await vault.balanceOf(depositor2.address);
    //   // withdraw 10%
    //   const withdrawShareAmount = depositor2Shares.div(10);
    //   const expectedAmount = await vault.getWithdrawAmountByShares(withdrawShareAmount);

    //   const vaultBalanceBefore = await weth.balanceOf(vault.address);
    //   const totalSupplyBefore = await vault.totalSupply();
    //   const wethBalanceBefore = await weth.balanceOf(depositor2.address);

    //   const feeRecipientBalanceBefore = await weth.balanceOf(feeRecipient.address);

    //   // withdraw weth
    //   await vault.connect(depositor2).withdraw(withdrawShareAmount);

    //   const vaultBalanceAfter = await weth.balanceOf(vault.address);
    //   const totalSupplyAfter = await vault.totalSupply();
    //   const wethBalanceAfter = await weth.balanceOf(depositor2.address);

    //   const feeRecipientBalanceAfter = await weth.balanceOf(feeRecipient.address);
    //   const feeCollected = feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore);

    //   expect(wethBalanceAfter.sub(wethBalanceBefore).eq(expectedAmount)).to.be.true;
    //   expect(vaultBalanceBefore.sub(vaultBalanceAfter).eq(expectedAmount.add(feeCollected))).to.be
    //     .true;
    //   expect(totalSupplyBefore.sub(totalSupplyAfter).eq(withdrawShareAmount)).to.be.true;
    // });
    // it('should revert if calling resumeFrom pause when vault is normal', async () => {
    //   await expect(vault.connect(owner).resumeFromPause()).to.be.revertedWith(
    //     '!Emergency'
    //   );
    // });
    // it('should be able to set vault to emergency state', async () => {
    //   const stateBefore = await vault.state()
    //   await vault.connect(owner).emergencyPause();
    //   expect((await vault.state()) === VaultState.Emergency).to.be.true;

    //   await expect(
    //     vault.connect(depositor1).depositETH({ value: utils.parseUnits('1') })
    //   ).to.be.revertedWith('Emergency');

    //   await vault.connect(owner).resumeFromPause();
    //   expect((await vault.state()) === stateBefore).to.be.true;
    // });
  });
  // describe('close position', async () => {
  //   before('pretent that action1 made money', async () => {
  //     // mint 1 weth and send it to action1
  //     await weth.connect(random).deposit({ value: utils.parseUnits('1') });
  //     await weth.connect(random).transfer(action1.address, utils.parseUnits('1'));
  //   });

  //   it('should be able to close position', async () => {
  //     const totalAssetBefore = await vault.totalAsset();
  //     const vaultBalanceBefore = await weth.balanceOf(vault.address);

  //     const action1BalanceBefore = await weth.balanceOf(action1.address);
  //     const action2BalanceBefore = await weth.balanceOf(action2.address);
  //     await vault.connect(owner).closePositions();

  //     const totalAssetAfter = await vault.totalAsset();
  //     const vaultBalanceAfter = await weth.balanceOf(vault.address);
  //     const action1BalanceAfter = await weth.balanceOf(action1.address);
  //     const action2BalanceAfter = await weth.balanceOf(action2.address);

  //     expect(totalAssetBefore.eq(totalAssetAfter)).to.be.true;
  //     expect(
  //       vaultBalanceAfter
  //         .sub(vaultBalanceBefore)
  //         .eq(
  //           action2BalanceBefore
  //             .sub(action2BalanceAfter)
  //             .add(action1BalanceBefore.sub(action1BalanceAfter))
  //         )
  //     ).to.be.true;
  //   });
  //   it('should revert if calling closePositions again', async () => {
  //     await expect(vault.connect(owner).closePositions()).to.be.revertedWith('!Locked');
  //   });
  // });
});
