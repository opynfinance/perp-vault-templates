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
  MockPricer,
  IController
} from '../../typechain';
import * as fs from 'fs';
// import {getOrder} from '../utils/orders';
import { BigNumber } from '@ethersproject/bignumber';

//esilnt-ignore-next-line
const {expectRevert} = require('@openzeppelin/test-helpers'); // eslint-disable-line

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
  
  
  let controller: IController;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  
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
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddress = '0x5934807cC0654d46755eBd2848840b616256C6Ef';
  const aaveLendingPoolAddres = '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9';
  
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
      _depositor3
    ] = accounts;

    await network.provider.send("hardhat_setBalance", [
      opynOwner,
      "0x1000000000000000000000000000000",
    ]);

    owner = _owner;
    feeRecipient = _feeRecipient;

    depositor1 = _depositor1;
    depositor2 = _depositor2;
    depositor3 = _depositor3
  });

  this.beforeAll('Connect to mainnet contracts', async () => {
    weth = (await ethers.getContractAt('IWETH', wethAddress)) as IWETH;
    usdc = (await ethers.getContractAt('MockERC20', usdcAddress)) as MockERC20;
    
    otokenFactory = (await ethers.getContractAt(
      'IOtokenFactory',
      otokenFactoryAddress
    )) as IOtokenFactory;
    oracle = (await ethers.getContractAt('IOracle', oracleAddress)) as IOracle;
    controller = (await ethers.getContractAt(
      'IController',
      controllerAddress
    )) as IController;
  });

  this.beforeAll('Deploy vault and sell ETH calls action', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy(
      wethAddress,
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
      // wethAddress,
      swapAddress,
      whitelistAddress,
      controllerAddress,
      aaveLendingPoolAddres,
      0, // type 0 vault
      weth.address,
      20 // 0.2%,
    )) as ShortOTokenActionWithSwap;

    await vault.connect(owner).setActions(
      [action1.address]
    );
  });

  this.beforeAll(
    "Deploy pricer",
    async () => {
      provider = ethers.provider;

      const MockPricerContract = await ethers.getContractFactory('MockPricer');
      wethPricer = (await MockPricerContract.deploy(
        oracleAddress
      )) as MockPricer;

      // impersonate owner 
      await owner.sendTransaction({
        to: opynOwner,
        value: utils.parseEther('2.0')
      });
      await provider.send('hardhat_impersonateAccount', [opynOwner]);
      const signer = await ethers.provider.getSigner(opynOwner);

      await oracle
        .connect(signer)
        .setAssetPricer(weth.address, wethPricer.address);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
    }
  );

  this.beforeAll('whitelist asset in the Opyn system', async () => {
    const whitelist = (await ethers.getContractAt(
      'IWhitelist',
      otokenWhitelistAddress
    )) as IWhitelist;

    // impersonate owner 
    await owner.sendTransaction({
      to: opynOwner,
      value: utils.parseEther('1.0')
    });
    await provider.send('hardhat_impersonateAccount', [opynOwner]);
    const signer = await ethers.provider.getSigner(opynOwner);
    // await whitelist.connect(signer).whitelistCollateral(wethAddress);
    // await whitelist
    //   .connect(signer)
    //   .whitelistProduct(
    //     weth.address,
    //     usdc.address,
    //     wethAddress,
    //     false
    //   );
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
  });

  // this.beforeAll('get weth and approve that to be spent', async () => {

  //   const p1DepositAmount = utils.parseEther('10');
  //   const p2DepositAmount = utils.parseEther('70');
  //   const p3DepositAmount = utils.parseEther('20');

  //   const wethWhale = '0x56178a0d5f301baf6cf3e1cd53d9863437345bf9'

  //   // send everyone weth
  //   await provider.send('hardhat_impersonateAccount', [wethWhale]);
  //   const signer = await ethers.provider.getSigner(wethWhale);
    
  //   await weth.connect(signer).transfer(depositor1.address, p1DepositAmount);
  //   await weth.connect(signer).transfer(depositor2.address, p2DepositAmount);
  //   await weth.connect(signer).transfer(depositor3.address, p3DepositAmount);
  //   await provider.send('evm_mine', []);
  //   await provider.send('hardhat_stopImpersonatingAccount', [wethWhale]);
    
  // });

  describe('check the admin setup', async () => {
    it('contract is initialized correctly', async () => {
      // initial state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalAsset()).isZero(), 'total asset should be zero')
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
    let lowerStrikeOtoken: IOToken;
    let higherStrikeOtoken: IOToken;
    let expiry: number;

    let sellAmount: BigNumber;

    const reserveFactor = 10;

    this.beforeAll(
      'deploy otokens that will be sold and set up counterparty',
      async () => {
        const lowerStrikeOtokenStrikePrice = 500000000000;
        const higherStrikeOtokenStrikePrice = 1000000000000;
        const blockNumber = await provider.getBlockNumber();
        const block = await provider.getBlock(blockNumber);
        const currentTimestamp = block.timestamp;
        expiry = (Math.floor(currentTimestamp / day) + 10) * day + 28800;

        await otokenFactory.createOtoken(
          weth.address,
          usdc.address,
          weth.address,
          lowerStrikeOtokenStrikePrice,
          expiry,
          false
        );

        await otokenFactory.createOtoken(
          weth.address,
          usdc.address,
          weth.address,
          higherStrikeOtokenStrikePrice,
          expiry,
          false
        );

        const lowerStrikeOtokenAddress = await otokenFactory.getOtoken(
          weth.address,
          usdc.address,
          weth.address,
          lowerStrikeOtokenStrikePrice,
          expiry,
          false
        );

        lowerStrikeOtoken = (await ethers.getContractAt(
          'IOToken',
          lowerStrikeOtokenAddress
        )) as IOToken;

        const higherStrikeOtokenAddress = await otokenFactory.getOtoken(
          weth.address,
          usdc.address,
          weth.address,
          higherStrikeOtokenStrikePrice,
          expiry,
          false
        );

        higherStrikeOtoken = (await ethers.getContractAt(
          'IOToken',
          higherStrikeOtokenAddress
        )) as IOToken;


        // prepare counterparty
        counterpartyWallet = counterpartyWallet.connect(provider);
        await owner.sendTransaction({
          to: counterpartyWallet.address,
          value: utils.parseEther('3000')
        });
        await weth.connect(counterpartyWallet).deposit({ value: utils.parseEther('2')});
        await weth.connect(counterpartyWallet).approve(action1.address, utils.parseEther('2'));
      }
    );

    it('p1 deposits', async () => {
      // there is no accurate way of estimating this, so just approximating for now
      const expectedWethInVault = p1DepositAmount;

      await vault.connect(depositor1).depositETH({ value: p1DepositAmount });

      const vaultTotal = await vault.totalAsset();
      const vaultWethBalance = await weth.balanceOf(vault.address);
      const totalSharesMinted = vaultWethBalance;

      // check the token balances
      expect(
        (vaultTotal).eq(expectedWethInVault),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(vaultWethBalance).to.be.equal(
        vaultTotal, 'internal balance is incorrect'
      );

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
        
    });

    it('p2 deposits', async () => {
      // there is no accurate way of estimating this, so just approximating for now
      const expectedWethInVault = p1DepositAmount.add(p2DepositAmount);
      const sharesBefore = await vault.totalSupply();
      const vaultWethBalanceBefore = await weth.balanceOf(vault.address);

      await vault.connect(depositor2).depositETH({value: p2DepositAmount});

      const vaultTotal = await vault.totalAsset();
      const vaultWethBalance = await weth.balanceOf(vault.address);

      expect(
        (vaultTotal).eq(vaultWethBalance),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(vaultTotal).to.be.equal(
        vaultWethBalance, 'internal balance is incorrect'
      );

      // check the minted share balances
      const wethDeposited = vaultWethBalance.sub(vaultWethBalanceBefore);
      const shares = sharesBefore.div(vaultWethBalanceBefore).mul(wethDeposited)
      expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted' ).to.be.equal(shares)

    });

    it('owner provides wrong strikes', async () => {
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await expect(action1.commitSpread(higherStrikeOtoken.address, lowerStrikeOtoken.address)).to.be.revertedWith('Lower Strike higher than Higher Strike');
      expect(await action1.state()).to.be.equal(ActionState.Idle);
    });

    it('owner commits to the option', async () => {
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitSpread(lowerStrikeOtoken.address, higherStrikeOtoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });

    it('owner mints call credit spread with WETH as margin collateral and sells them', async () => {    
      // increase time
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      const vaultWethBalanceBefore = await weth.balanceOf(vault.address);

      await vault.rollOver([(100 - reserveFactor) * 100]);

      const expectedWethBalanceInVault = vaultWethBalanceBefore.mul(reserveFactor).div(100)
      let expectedWethBalanceInAction = vaultWethBalanceBefore.sub(expectedWethBalanceInVault)
      
      const collateralAmount = await weth.balanceOf(action1.address)

      const expectedTotal = vaultWethBalanceBefore.add(premium);

      expectedWethBalanceInAction = expectedWethBalanceInVault.add(premium);
      
      const longStrikePrice = await higherStrikeOtoken.strikePrice();
      const shortStrikePrice = await lowerStrikeOtoken.strikePrice();

      const wethAmount = collateralAmount;
      const collateralRequiredPerOption = (longStrikePrice.sub(shortStrikePrice).mul(1e10).div(longStrikePrice));
      
      const sellAmount = (wethAmount).div(collateralRequiredPerOption);

      const marginPoolBalanceOfWethBefore = await weth.balanceOf(marginPoolAddress);

      expect(
        (await action1.lockedAsset()).eq('0'),
        'collateral should not be locked'
      ).to.be.true;

      await controller.connect(counterpartyWallet).setOperator(action1.address, true);

      const lowPremium = utils.parseEther('0.0000001');

      // testing revert with premium === 0
      await expectRevert.unspecified(
        action1.flashMintAndSellOToken(sellAmount.toString(), lowPremium, counterpartyWallet.address)
      )
      
      await expectRevert.unspecified(action1.flashMintAndSellOToken(sellAmount, (await weth.balanceOf(counterpartyWallet.address)).add(1), counterpartyWallet.address))

      await action1.flashMintAndSellOToken(sellAmount.toString(), premium, counterpartyWallet.address);

      const vaultWethBalanceAfter = await weth.balanceOf(vault.address);

      // check balance in action and vault
      expect(vaultWethBalanceAfter).to.be.within(
        expectedWethBalanceInVault.sub(1) as any, expectedWethBalanceInVault.add(1) as any, "incorrect balance in vault"
      );
      
      const vaultTotalAsset = await vault.totalAsset()

      // include fee paid for flashloan
      expect(
        (vaultTotalAsset).lte(expectedTotal),
        'incorrect accounting in vault'
      ).to.be.true;
      
      expect(((await weth.balanceOf(action1.address)).gte(expectedWethBalanceInVault), 'incorrect weth balance in action'))
      
      // checking that we pay fee from sdcrv wrapping and flashloan
      // expect((await weth.balanceOf(action1.address)).lte(premium), 'Final WETH amount incorrect').to.be.true;

      expect( (premium.sub(await weth.balanceOf(action1.address)) ).lte( premium.mul(10).div(100)   ),
        'Fee paid on the transaction are higher than 10% of the premium' ).to.be.true;

      // check correct amounts in MM vault
      const mmVault =  await controller.getVault(counterpartyWallet.address, 1);
      expect( (mmVault.longOtokens[0]), 'MM does not have the correct long otoken' ).to.be.equal(lowerStrikeOtoken.address);
      expect( (mmVault.shortOtokens[0]), 'MM does not have the correct short otoken' ).to.be.equal(higherStrikeOtoken.address);
      expect( (mmVault.longAmounts[0]), 'MM does not have the correct amount for long otoken' ).to.be.equal(sellAmount);
      expect( (mmVault.shortAmounts[0]), 'MM does not have the correct amount for short otoken' ).to.be.equal(sellAmount);

      // check correct amounts in action vault
      const actionVault =  await controller.getVault(action1.address, 1);
      expect( (actionVault.shortOtokens[0]), 'Action does not have the correct short otoken' ).to.be.equal(lowerStrikeOtoken.address);
      expect( (actionVault.longOtokens[0]), 'Action does not have the correct long otoken' ).to.be.equal(higherStrikeOtoken.address);
      expect( (actionVault.longAmounts[0]), 'Action does not have the correct amount for long otoken' ).to.be.equal(sellAmount);
      expect( (actionVault.shortAmounts[0]), 'Action does not have the correct amount for short otoken' ).to.be.equal(sellAmount);
      expect( (actionVault.collateralAssets[0]), 'Action does not have the right collateral' ).to.be.equal(weth.address);
      expect( (actionVault.collateralAmounts[0]), 'Action does not have the correct amount of required collateral' ).to.be.lte( collateralAmount );

      const marginPoolBalanceOfWethAfter = await weth.balanceOf(marginPoolAddress);

      expect(marginPoolBalanceOfWethAfter, 'incorrect balance in Opyn').to.be.lte(
        marginPoolBalanceOfWethBefore.add(collateralAmount)
      );
    });

    it('p3 deposits', async () => {

      const vaultTotalBefore = await vault.totalAsset();
      
      const expectedTotal = vaultTotalBefore.add(p3DepositAmount);
      const sharesBefore = await vault.totalSupply();
      const actualAmountInVaultBefore = await weth.balanceOf(vault.address);

      await vault.connect(depositor3).depositETH({value: p3DepositAmount});

      const vaultTotalAfter = await vault.totalAsset();

      const wethDeposited = vaultTotalAfter.sub(vaultTotalBefore);
      actualAmountInVault = await weth.balanceOf(vault.address);

      expect(
        (await vault.totalAsset()).gte(expectedTotal),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(actualAmountInVault).to.be.equal(
        actualAmountInVaultBefore.add(wethDeposited), 'internal accounting should match actual balance'
      );

      // check the minted share balances
      const shares = wethDeposited.mul(sharesBefore).div(vaultTotalBefore)
      expect((await vault.balanceOf(depositor3.address))).to.be.equal(shares)
    });

    it('p1 withdraws', async () => {
      // vault balance calculations
      const vaultTotalBefore = await vault.totalAsset();

      const vaultWethBalanceBefore = await weth.balanceOf(vault.address);

      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);

      // p1 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);

      // premium  fees for flash loan ~5%
      const netPremium = premium.mul(95).div(100)

      // const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
      const shareOfPremium = p1DepositAmount.mul(netPremium).div(denominator);
      const amountToWithdraw = p1DepositAmount.add(shareOfPremium);

      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP1 = amountToWithdraw.sub(fee);

      const balanceOfP1Before = await provider.getBalance(depositor1.address);
      const balanceOfFeeRecipientBefore = await provider.getBalance(feeRecipient.address);

      await vault
        .connect(depositor1)
        .withdrawETH(sharesToWithdraw);
        // .withdrawETH(sharesToWithdraw, '0' );

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const wethWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultWethBalanceAfter = await weth.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await provider.getBalance(feeRecipient.address)
      const balanceOfP1After = await provider.getBalance(depositor1.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalAssets = await vault.totalAsset();
      // check vault balance 
      expect(
        vaultTotalAssets).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
        'total asset should update'
      );
      expect(vaultWethBalanceAfter).to.be.within(
        vaultWethBalanceBefore.sub(wethWithdrawn).sub(1) as any,
        vaultWethBalanceBefore.sub(wethWithdrawn).add(1) as any,
      );

      // check p1 balance 
      expect(balanceOfP1After.gte((balanceOfP1Before.add(amountTransferredToP1))), 'incorrect ETH transferred to p1').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter.gte(
        balanceOfFeeRecipientBefore.add(fee)
      ), 'incorrect fee paid out').to.be.true;
    });

    it('option expires', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
      await provider.send('evm_mine', []);

      // set settlement price
      await wethPricer.setExpiryPriceInOracle(weth.address, expiry, '400000000000');

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      const wethControlledByActionBefore = await action1.currentValue();
      const wethBalanceInVaultBefore = await weth.balanceOf(vault.address);

      await vault.closePositions();

      const wethBalanceInVaultAfter = await weth.balanceOf(vault.address);

      const wethBalanceInActionAfter = await weth.balanceOf(action1.address);
      const wethControlledByActionAfter = await action1.currentValue();
      const vaultTotal = await vault.totalAsset();

      // check vault balances
      expect(vaultTotal, 'incorrect accounting in vault').to.be.equal(wethBalanceInVaultAfter);
      
      expect(wethBalanceInVaultAfter, 'incorrect balances in vault')
      .to.be.equal(wethBalanceInVaultBefore.add(wethControlledByActionBefore));

      // check action balances
      expect(
        (await action1.lockedAsset()).eq('0'),
        'all collateral should be unlocked'
      ).to.be.true;

      expect(wethBalanceInActionAfter, 'no weth should be left in action').to.be.equal('0');
      expect(wethControlledByActionAfter, 'no weth should be controlled by action').to.be.equal('0');
    });

    it('p2 withdraws', async () => {
      // vault balance calculations
      const vaultTotalBefore = await vault.totalAsset();
      const vaultWethBalanceBefore = await weth.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);

      // p2 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const netPremium = premium.mul(95).div(100);
      const shareOfPremium = p2DepositAmount.mul(netPremium).div(denominator);
      const amountToWithdraw = p2DepositAmount.add(shareOfPremium);
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP2 = amountToWithdraw.sub(fee);
      const balanceOfP2Before = await provider.getBalance(depositor2.address);

      const balanceOfFeeRecipientBefore = await provider.getBalance(feeRecipient.address);


      await vault
        .connect(depositor2)
        .withdrawETH(sharesToWithdraw);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const wethWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultWethBalanceAfter = await weth.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await provider.getBalance(feeRecipient.address)
      const balanceOfP2After = await provider.getBalance(depositor2.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalAssets = await vault.totalAsset();

      // check vault balance 
      expect(
        vaultTotalAssets).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
        'total asset should update'
      );
      expect(vaultWethBalanceAfter).to.be.within(
        vaultWethBalanceBefore.sub(wethWithdrawn).sub(1) as any,
        vaultWethBalanceBefore.sub(wethWithdrawn).add(1) as any,
      );

      // check p2 balance 
      expect(balanceOfP2After.gte((balanceOfP2Before.add(amountTransferredToP2))), 'incorrect ETH transferred to p2').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter.gte(
        balanceOfFeeRecipientBefore.add(fee)
      ), 'incorrect fee paid out').to.be.true;
    });

    it('p3 withdraws', async () => {
      // balance calculations 
      const amountToWithdraw = p3DepositAmount;
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP3 = amountToWithdraw.sub(fee);
      const balanceOfP3Before = await provider.getBalance(depositor3.address);

      const balanceOfFeeRecipientBefore = await provider.getBalance(feeRecipient.address);

      await vault
        .connect(depositor3)
        .withdrawETH(await vault.balanceOf(depositor3.address));

      const balanceOfFeeRecipientAfter = await provider.getBalance(feeRecipient.address);
      const balanceOfP3After = await provider.getBalance(depositor3.address);

      expect(
        (await vault.totalAsset()).eq('0'),
        'total in vault should be empty'
      ).to.be.true;
      expect(await weth.balanceOf(vault.address), 'total in vault should be empty').to.be.equal(
        '0'
      );

      // check fee 
      expect(balanceOfFeeRecipientAfter.gte(
        balanceOfFeeRecipientBefore.add(fee)
      ), 'incorrect fee paid out').to.be.true;

      // check p3 balance 
      expect(balanceOfP3After.lte((balanceOfP3Before.add(amountTransferredToP3))), 'incorrect ETH transferred to p3').to.be.true;
    });
  });
});