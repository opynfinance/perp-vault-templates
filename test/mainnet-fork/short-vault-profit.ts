import {ethers, network} from 'hardhat';
import {utils} from 'ethers';
import {SignerWithAddress} from '@nomiclabs/hardhat-ethers/signers';
import {expect} from 'chai';
import {
  MockERC20,
  OpynPerpVault,
  IWETH,
  ShortOTokenActionWithSwap,
  IOtokenFactory,
  IOToken,
  StakedaoEcrvPricer,
  IOracle,
  IWhitelist,
  MockPricer
} from '../../typechain';
import * as fs from 'fs';
import {getOrder} from '../utils/orders';

const mnemonic = fs.existsSync('.secret')
  ? fs
      .readFileSync('.secret')
      .toString()
      .trim()
  : 'test test test test test test test test test test test junk';

enum VaultState {
  Emergency,
  Locked,
  Unlocked,
}

enum ActionState {
  Activated,
  Committed,
  Idle,
}

describe('Mainnet Fork Tests', function() {
  let counterpartyWallet = ethers.Wallet.fromMnemonic(
    mnemonic,
    "m/44'/60'/0'/0/30"
  );
  let action1: ShortOTokenActionWithSwap;
  // asset used by this action: in this case, weth
  let weth: IWETH;
  let usdc: MockERC20;
  let ecrv: MockERC20;
  let stakeDaoLP: MockERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  let sdecrvPricer: StakedaoEcrvPricer;
  let wethPricer: MockPricer;
  let oracle: IOracle;
  let provider: typeof ethers.provider;

  /**
   *
   * CONSTANTS
   *
   */
  const day = 86400;
  const controllerAddress = '0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72';
  const whitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const swapAddress = '0x4572f2554421Bd64Bef1c22c8a81840E8D496BeA';
  const oracleAddress = '0x789cD7AB3742e23Ce0952F6Bc3Eb3A73A0E08833';
  const opynOwner = '0x638E5DA0EEbbA58c67567bcEb4Ab2dc8D34853FB';
  const otokenFactoryAddress = '0x7C06792Af1632E77cb27a558Dc0885338F4Bdf8E';
  const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const stakeDaoTokenAddress = '0xa2761B0539374EB7AF2155f76eb09864af075250';
  const curveAddress = '0xc5424B857f758E906013F3555Dad202e4bdB4567';
  const ecrvAddress = '0xA3D87FffcE63B53E0d54fAa1cc983B7eB0b74A9c';
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddess = '0x5934807cC0654d46755eBd2848840b616256C6Ef'

  /**
   *
   * Setup
   *
   */

  this.beforeAll('Set accounts', async () => {
    accounts = await ethers.getSigners();

    const [
      _owner,
      _feeRecipient,
      _depositor1,
      _depositor2,
      _depositor3,
    ] = accounts;

    await network.provider.send("hardhat_setBalance", [
      opynOwner,
      "0x1000000000000000000000000000000",
    ]);

    owner = _owner;
    feeRecipient = _feeRecipient;

    depositor1 = _depositor1;
    depositor2 = _depositor2;
    depositor3 = _depositor3;
  });

  this.beforeAll('Connect to mainnet contracts', async () => {
    weth = (await ethers.getContractAt('IWETH', wethAddress)) as IWETH;
    usdc = (await ethers.getContractAt('MockERC20', usdcAddress)) as MockERC20;
    ecrv = (await ethers.getContractAt('MockERC20', ecrvAddress)) as MockERC20;
    stakeDaoLP = (await ethers.getContractAt(
      'MockERC20',
      stakeDaoTokenAddress
    )) as MockERC20;
    otokenFactory = (await ethers.getContractAt(
      'IOtokenFactory',
      otokenFactoryAddress
    )) as IOtokenFactory;
    oracle = (await ethers.getContractAt('IOracle', oracleAddress)) as IOracle;
  });

  this.beforeAll('Deploy vault and sell ETH calls action', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy(
      stakeDaoTokenAddress,
      curveAddress,
      feeRecipient.address,
      'OpynPerpShortVault share',
      'sOPS',
    )) as OpynPerpVault;

    // deploy the short action contract
    const ShortActionContract = await ethers.getContractFactory(
      'ShortOTokenActionWithSwap'
    );
    action1 = (await ShortActionContract.deploy(
      vault.address,
      stakeDaoTokenAddress,
      swapAddress,
      whitelistAddress,
      controllerAddress,
      curveAddress,
      0, // type 0 vault
      weth.address,
      20 // 0.2%
    )) as ShortOTokenActionWithSwap;

    await vault.connect(owner).setActions(
      [action1.address]
    );
  });

  this.beforeAll(
    "Deploy sdecrvPricer, wethPricer and update sdecrvPricer in opyn's oracle",
    async () => {
      provider = ethers.provider;

      const PricerContract = await ethers.getContractFactory(
        'StakedaoEcrvPricer'
      );
      sdecrvPricer = (await PricerContract.deploy(
        stakeDaoLP.address,
        weth.address,
        oracleAddress,
        curveAddress
      )) as StakedaoEcrvPricer;
      const MockPricerContract = await ethers.getContractFactory('MockPricer');
      wethPricer = (await MockPricerContract.deploy(
        oracleAddress
      )) as MockPricer;

      // impersonate owner and change the sdecrvPricer
      await owner.sendTransaction({
        to: opynOwner,
        value: utils.parseEther('2.0')
      });
      await provider.send('hardhat_impersonateAccount', [opynOwner]);
      const signer = await ethers.provider.getSigner(opynOwner);
      await oracle
        .connect(signer)
        .setAssetPricer(stakeDaoLP.address, sdecrvPricer.address);
      await oracle
        .connect(signer)
        .setAssetPricer(weth.address, wethPricer.address);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
    }
  );

  this.beforeAll('whitelist sdeCRV in the Opyn system', async () => {
    const whitelist = (await ethers.getContractAt(
      'IWhitelist',
      otokenWhitelistAddress
    )) as IWhitelist;

    // impersonate owner and change the sdecrvPricer
    await owner.sendTransaction({
      to: opynOwner,
      value: utils.parseEther('1.0')
    });
    await provider.send('hardhat_impersonateAccount', [opynOwner]);
    const signer = await ethers.provider.getSigner(opynOwner);
    await whitelist.connect(signer).whitelistCollateral(stakeDaoTokenAddress);
    await whitelist
      .connect(signer)
      .whitelistProduct(
        weth.address,
        usdc.address,
        stakeDaoTokenAddress,
        false
      );
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
  });

  this.beforeAll('get ecrv and approve that to be spent', async () => {
    const ecrvWhale = '0x9eA83407e0046Ee452Bc6535c0Aa5609D7F6F680';
    // impersonate ecrvWhale and get ecrv
    await provider.send('hardhat_impersonateAccount', [ecrvWhale]);
    const signer = await ethers.provider.getSigner(ecrvWhale);
    const p1DepositAmount = utils.parseEther('10');
    const p2DepositAmount = utils.parseEther('70');
    const p3DepositAmount = utils.parseEther('20');
    await ecrv.connect(signer).transfer(depositor1.address, p1DepositAmount);
    await ecrv.connect(signer).transfer(depositor2.address, p2DepositAmount);
    await ecrv.connect(signer).transfer(depositor3.address, p3DepositAmount);
    await ecrv
      .connect(signer)
      .transfer(counterpartyWallet.address, p1DepositAmount);
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [ecrvWhale]);
    await ecrv.connect(depositor1).approve(vault.address, p1DepositAmount);
    await ecrv.connect(depositor2).approve(vault.address, p2DepositAmount);
    await ecrv.connect(depositor3).approve(vault.address, p3DepositAmount);
  });

  describe('check the admin setup', async () => {
    it('contract is initialized correctly', async () => {
      // initial state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalStakedaoAsset()).isZero(), 'total asset should be zero')
        .to.be.true;
    });

    it('should set fee reserve', async () => {
      // 10% reserve
      await vault.connect(owner).setWithdrawReserve(1000);
      expect((await vault.withdrawReserve()).toNumber() == 1000).to.be.true;
    });
  });

  describe('profitable scenario', async () => {
    const p1DepositAmount = utils.parseEther('10');
    const p2DepositAmount = utils.parseEther('70');
    const p3DepositAmount = utils.parseEther('20');
    const premium = utils.parseEther('2');
    let actualAmountInVault;
    let otoken: IOToken;
    let expiry: number;
    const reserveFactor = 10;
    this.beforeAll(
      'deploy otoken that will be sold and set up counterparty',
      async () => {
        const otokenStrikePrice = 500000000000;
        const blockNumber = await provider.getBlockNumber();
        const block = await provider.getBlock(blockNumber);
        const currentTimestamp = block.timestamp;
        expiry = (Math.floor(currentTimestamp / day) + 10) * day + 28800;

        await otokenFactory.createOtoken(
          weth.address,
          usdc.address,
          stakeDaoLP.address,
          otokenStrikePrice,
          expiry,
          false
        );

        const otokenAddress = await otokenFactory.getOtoken(
          weth.address,
          usdc.address,
          stakeDaoLP.address,
          otokenStrikePrice,
          expiry,
          false
        );

        otoken = (await ethers.getContractAt(
          'IOToken',
          otokenAddress
        )) as IOToken;

        // prepare counterparty
        counterpartyWallet = counterpartyWallet.connect(provider);
        await owner.sendTransaction({
          to: counterpartyWallet.address,
          value: utils.parseEther('3000')
        });
        await weth.connect(counterpartyWallet).deposit({ value: premium });
        await weth.connect(counterpartyWallet).approve(swapAddress, premium);
      }
    );
    it('p1 deposits', async () => {
      // there is no accurate way of estimating this, so just approximating for now
      const expectedSdecrvInVault = p1DepositAmount.mul(95).div(100);

      await vault.connect(depositor1).depositETH('0', {value: p1DepositAmount});

      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdecrvBalance = await stakeDaoLP.balanceOf(vault.address);
      const totalSharesMinted = vaultSdecrvBalance;

      // check the sdeCRV token balances
      expect(
        (vaultTotal).gte(expectedSdecrvInVault),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(vaultSdecrvBalance).to.be.equal(
        vaultTotal, 'internal balance is incorrect'
      );

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
    });

    it('p2 deposits', async () => {
      // there is no accurate way of estimating this, so just approximating for now
      const expectedSdecrvInVault = p1DepositAmount.mul(95).div(100);
      const sharesBefore = await vault.totalSupply();
      const vaultSdecrvBalanceBefore = await stakeDaoLP.balanceOf(vault.address);

      await vault.connect(depositor2).depositETH('0', {value: p2DepositAmount});

      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdecrvBalance = await stakeDaoLP.balanceOf(vault.address);
      // check the sdeCRV token balances
      // there is no accurate way of estimating this, so just approximating for now
      expect(
        (vaultTotal).gte(expectedSdecrvInVault),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(vaultTotal).to.be.equal(
        vaultSdecrvBalance, 'internal balance is incorrect'
      );

      // check the minted share balances
      const stakedaoDeposited = vaultSdecrvBalance.sub(vaultSdecrvBalanceBefore);
      const shares = sharesBefore.div(vaultSdecrvBalanceBefore).mul(stakedaoDeposited)
      expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted' ).to.be.equal(shares)
    });

    it('tests getPrice in sdecrvPricer', async () => {
      await wethPricer.setPrice('2000');
      const wethPrice = await oracle.getPrice(weth.address);
      const stakeDaoLPPrice = await oracle.getPrice(stakeDaoLP.address);
      expect(wethPrice.toNumber()).to.be.lessThanOrEqual(
        stakeDaoLPPrice.toNumber()
      );
    });

    it('owner commits to the option', async () => {
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitOToken(otoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });

    it('owner mints options with sdeCRV as collateral and sells them', async () => {
      // increase time
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      const vaultSdecrvBalanceBefore = await stakeDaoLP.balanceOf(vault.address);

      await vault.rollOver([(100 - reserveFactor) * 100]);


      // const vaultSdecrvBalanceBefore = await stakeDaoLP.balanceOf(vault.address);
      const expectedSdecrvBalanceInVault = vaultSdecrvBalanceBefore.mul(reserveFactor).div(100)
      let expectedSdecrvBalanceInAction = vaultSdecrvBalanceBefore.sub(expectedSdecrvBalanceInVault)
      const collateralAmount = await stakeDaoLP.balanceOf(action1.address)
      const premiumInSdecrv = premium.mul(95).div(100);
      const expectedTotal = vaultSdecrvBalanceBefore.add(premiumInSdecrv);
      expectedSdecrvBalanceInAction = expectedSdecrvBalanceInVault.add(premiumInSdecrv);
      const sellAmount = (collateralAmount.div(10000000000)).toString(); 
      const marginPoolSdecrvBalanceAfter = await stakeDaoLP.balanceOf(marginPoolAddess);

      const marginPoolBalanceOfStakeDaoLPBefore = await stakeDaoLP.balanceOf(marginPoolAddess);

      const order = await getOrder(
        action1.address,
        otoken.address,
        sellAmount,
        counterpartyWallet.address,
        weth.address,
        premium.toString(),
        swapAddress,
        counterpartyWallet.privateKey
      );

      expect(
        (await action1.lockedAsset()).eq('0'),
        'collateral should not be locked'
      ).to.be.true;

      await action1.mintAndSellOToken(collateralAmount, sellAmount, order);

      const vaultSdecrvBalanceAfter = await stakeDaoLP.balanceOf(vault.address);

      // check sdeCRV balance in action and vault
      expect(vaultSdecrvBalanceAfter).to.be.within(
        expectedSdecrvBalanceInVault.sub(1) as any, expectedSdecrvBalanceInVault.add(1) as any, "incorrect balance in vault"
      );
      expect(
        (await vault.totalStakedaoAsset()).gte(expectedTotal),
        'incorrect accounting in vault'
      ).to.be.true;
      expect(((await stakeDaoLP.balanceOf(action1.address)).gte(expectedSdecrvBalanceInAction), 'incorrect sdecrv balance in action'))
      expect((await action1.lockedAsset()), 'incorrect accounting in action').to.be.equal(collateralAmount)
      expect(await weth.balanceOf(action1.address)).to.be.equal('0');


      // check the otoken balance of counterparty
      expect(await otoken.balanceOf(counterpartyWallet.address), 'incorrect otoken balance sent to counterparty').to.be.equal(
        sellAmount
      );

      const marginPoolBalanceOfStakeDaoLPAfter = await stakeDaoLP.balanceOf(marginPoolAddess);

      // check sdecrv balance in opyn 
      expect(marginPoolBalanceOfStakeDaoLPAfter, 'incorrect balance in Opyn').to.be.equal(marginPoolBalanceOfStakeDaoLPBefore.add(collateralAmount));
    });

    it('p3 deposits', async () => {
      const effectiveP3deposit = p3DepositAmount.mul(95).div(100)
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const expectedTotal = vaultTotalBefore.add(effectiveP3deposit);
      const sharesBefore = await vault.totalSupply();
      const actualAmountInVaultBefore = await stakeDaoLP.balanceOf(vault.address);

      await vault.connect(depositor3).depositETH('0', {value: p3DepositAmount});

      const vaultTotalAfter = await vault.totalStakedaoAsset();
      const stakedaoDeposited = vaultTotalAfter.sub(vaultTotalBefore);
      actualAmountInVault = await stakeDaoLP.balanceOf(vault.address);
      // check the sdeCRV token balances
      // there is no accurate way of estimating this, so just approximating for now
      expect(
        (await vault.totalStakedaoAsset()).gte(expectedTotal),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(actualAmountInVault).to.be.equal(
        actualAmountInVaultBefore.add(stakedaoDeposited), 'internal accounting should match actual balance'
      );

      // check the minted share balances
      const shares = stakedaoDeposited.mul(sharesBefore).div(vaultTotalBefore)
      expect((await vault.balanceOf(depositor3.address))).to.be.equal(shares)
    });

    it('p1 withdraws', async () => {
      // vault balance calculations
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultSdECRVBalanceBefore = await stakeDaoLP.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);

      // p1 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p1DepositAmount.add(shareOfPremium);
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP1 = amountToWithdraw.sub(fee).mul(95).div(100);
      const balanceOfP1Before = await provider.getBalance(depositor1.address);

      // fee calculations 
      const effectiveFee = fee.mul(95).div(100);
      const balanceOfFeeRecipientBefore = await provider.getBalance(feeRecipient.address);


      await vault
        .connect(depositor1)
        .withdrawETH(sharesToWithdraw, amountTransferredToP1);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const sdeCRVWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultSdECRVBalanceAfter = await stakeDaoLP.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await provider.getBalance(feeRecipient.address)
      const balanceOfP1After = await provider.getBalance(depositor1.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalStakedaoAssets = await vault.totalStakedaoAsset();
      // check vault balance 
      expect(
        vaultTotalStakedaoAssets).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
        'total asset should update'
      );
      expect(vaultSdECRVBalanceAfter).to.be.within(
        vaultSdECRVBalanceBefore.sub(sdeCRVWithdrawn).sub(1) as any,
        vaultSdECRVBalanceBefore.sub(sdeCRVWithdrawn).add(1) as any,
      );

      // check p1 balance 
      expect(balanceOfP1After.gte((balanceOfP1Before.add(amountTransferredToP1))), 'incorrect ETH transferred to p1').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter.gte(
        balanceOfFeeRecipientBefore.add(effectiveFee)
      ), 'incorrect fee paid out').to.be.true;
    });

    it('option expires', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
      await provider.send('evm_mine', []);

      // set settlement price
      await wethPricer.setExpiryPriceInOracle(weth.address, expiry, '100000000000');
      await sdecrvPricer.setExpiryPriceInOracle(expiry);

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      const sdecrvControlledByActionBefore = await action1.currentValue();
      const sdecrvBalanceInVaultBefore = await stakeDaoLP.balanceOf(vault.address);

      await vault.closePositions();

      const sdecrvBalanceInVaultAfter = await stakeDaoLP.balanceOf(vault.address);
      const sdecrvBalanceInActionAfter = await stakeDaoLP.balanceOf(action1.address);
      const sdecrvControlledByActionAfter = await action1.currentValue();
      const vaultTotal = await vault.totalStakedaoAsset();

      // check vault balances
      expect(vaultTotal, 'incorrect accounting in vault').to.be.equal(sdecrvBalanceInVaultAfter);
      expect(sdecrvBalanceInVaultAfter, 'incorrect balances in vault').to.be.equal(sdecrvBalanceInVaultBefore.add(sdecrvControlledByActionBefore));

      // check action balances
      expect(
        (await action1.lockedAsset()).eq('0'),
        'all collateral should be unlocked'
      ).to.be.true;
      expect(sdecrvBalanceInActionAfter, 'no sdecrv should be left in action').to.be.equal('0');
      expect(sdecrvControlledByActionAfter, 'no sdecrv should be controlled by action').to.be.equal('0');
    });

    it('p2 withdraws', async () => {
      // vault balance calculations
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultSdECRVBalanceBefore = await stakeDaoLP.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);

      // p2 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p2DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p2DepositAmount.add(shareOfPremium);
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP2 = amountToWithdraw.sub(fee).mul(95).div(100);
      const balanceOfP2Before = await provider.getBalance(depositor2.address);

      // fee calculations 
      const effectiveFee = fee.mul(95).div(100);
      const balanceOfFeeRecipientBefore = await provider.getBalance(feeRecipient.address);


      await vault
        .connect(depositor2)
        .withdrawETH(sharesToWithdraw, amountTransferredToP2);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const sdeCRVWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultSdECRVBalanceAfter = await stakeDaoLP.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await provider.getBalance(feeRecipient.address)
      const balanceOfP2After = await provider.getBalance(depositor2.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalStakedaoAssets = await vault.totalStakedaoAsset();

      // check vault balance 
      expect(
        vaultTotalStakedaoAssets).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
        'total asset should update'
      );
      expect(vaultSdECRVBalanceAfter).to.be.within(
        vaultSdECRVBalanceBefore.sub(sdeCRVWithdrawn).sub(1) as any,
        vaultSdECRVBalanceBefore.sub(sdeCRVWithdrawn).add(1) as any,
      );

      // check p2 balance 
      expect(balanceOfP2After.gte((balanceOfP2Before.add(amountTransferredToP2))), 'incorrect ETH transferred to p2').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter.gte(
        balanceOfFeeRecipientBefore.add(effectiveFee)
      ), 'incorrect fee paid out').to.be.true;
    });

    it('p3 withdraws', async () => {
      // balance calculations 
      const amountToWithdraw = p3DepositAmount;
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP3 = amountToWithdraw.sub(fee).mul(95).div(100);
      const balanceOfP3Before = await provider.getBalance(depositor3.address);

      // fee calculations
      const balanceOfFeeRecipientBefore = await provider.getBalance(feeRecipient.address);
      const effectiveFee = fee.mul(95).div(100)

      await vault
        .connect(depositor3)
        .withdrawETH(await vault.balanceOf(depositor3.address), amountTransferredToP3);

      const balanceOfFeeRecipientAfter = await provider.getBalance(feeRecipient.address);
      const balanceOfP3After = await provider.getBalance(depositor3.address);

      expect(
        (await vault.totalStakedaoAsset()).eq('0'),
        'total in vault should be empty'
      ).to.be.true;
      expect(await stakeDaoLP.balanceOf(vault.address), 'total in vault should be empty').to.be.equal(
        '0'
      );

      // check fee 
      expect(balanceOfFeeRecipientAfter.gte(
        balanceOfFeeRecipientBefore.add(effectiveFee)
      ), 'incorrect fee paid out').to.be.true;

      // check p3 balance 
      expect(balanceOfP3After.gte((balanceOfP3Before.add(amountTransferredToP3))), 'incorrect ETH transferred to p3').to.be.true;
    });
  });
});
