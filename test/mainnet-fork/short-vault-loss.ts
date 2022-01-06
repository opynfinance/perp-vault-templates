import { ethers, network } from 'hardhat';
import { BigNumber, Signer, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import {
  OpynPerpVault,
  IERC20,
  ShortOTokenActionWithSwap,
  IOtokenFactory,
  IOToken,
  StakedaoPricer,
  IOracle,
  IWhitelist,
  MockPricer,
  IController
} from '../../typechain';
import * as fs from 'fs';
import { getOrder } from '../utils/orders';

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

enum ActionType {
  OpenVault,
  MintShortOption,
  BurnShortOption,
  DepositLongOption,
  WithdrawLongOption,
  DepositCollateral,
  WithdrawCollateral,
  SettleVault,
  Redeem,
  Call,
  InvalidAction,
}

describe('Mainnet Fork Tests', function () {
  let counterpartyWallet = ethers.Wallet.fromMnemonic(
    mnemonic,
    "m/44'/60'/0'/0/30"
  );
  let action1: ShortOTokenActionWithSwap;
  // asset used by this action: in this case, wbtc
  let underlying: IERC20;
  let usdc: IERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  let underlyingPricer: MockPricer;
  let oracle: IOracle;
  let controller: IController;
  let provider: typeof ethers.provider;


  let p1DepositAmount : BigNumber;
  let p2DepositAmount : BigNumber;
  let p3DepositAmount : BigNumber;
  let premium : BigNumber;
  let underlyingDecimals : any;

  /**
   *
   * CONSTANTS
   *
   */
  const day = 86400;
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
  const controllerAddress = '0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72';
  const whitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const swapAddress = '0x4572f2554421Bd64Bef1c22c8a81840E8D496BeA';
  const oracleAddress = '0x789cD7AB3742e23Ce0952F6Bc3Eb3A73A0E08833';
  const opynOwner = '0x638E5DA0EEbbA58c67567bcEb4Ab2dc8D34853FB';
  const otokenFactoryAddress = '0x7C06792Af1632E77cb27a558Dc0885338F4Bdf8E';
  const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const underlyingAddress = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddess = '0x5934807cC0654d46755eBd2848840b616256C6Ef'

  /** Test Scenario Params */
  const p1Amount = '10'
  const p2Amount = '70'
  const p3Amount = '20'
  const premiumAmount = '80'

  const reserveFactor = 10;  //as a %
  const feePercentage = 0.5;  //as a %

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
    underlying = (await ethers.getContractAt('IERC20', underlyingAddress)) as IERC20;
    usdc = (await ethers.getContractAt('IERC20', usdcAddress)) as IERC20;
    otokenFactory = (await ethers.getContractAt('IOtokenFactory',otokenFactoryAddress)) as IOtokenFactory;
    oracle = (await ethers.getContractAt('IOracle', oracleAddress)) as IOracle;
    controller = (await ethers.getContractAt('IController', controllerAddress)) as IController;
  });

  this.beforeAll('Scale Params', async () => {
    underlyingDecimals = await(await ethers.getContractAt('ERC20', underlyingAddress)).decimals();
    p1DepositAmount = ethers.utils.parseUnits(p1Amount, underlyingDecimals);
    p2DepositAmount = ethers.utils.parseUnits(p2Amount, underlyingDecimals);
    p3DepositAmount = ethers.utils.parseUnits(p3Amount, underlyingDecimals);
    premium =ethers.utils.parseUnits(premiumAmount, underlyingDecimals);
  });

  this.beforeAll('Deploy vault and sell calls action', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy(
      underlying.address,
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
      swapAddress,
      whitelistAddress,
      controllerAddress,
      0, // type 0 vault
      underlying.address,
      20 // 0.2%
    )) as ShortOTokenActionWithSwap;

    await vault.connect(owner).setActions(
      [action1.address]
    );
  });

  this.beforeAll(
    "Deploy underlying pricer in opyn's oracle",
    async () => {
      provider = ethers.provider;

      const MockPricerContract = await ethers.getContractFactory('MockPricer');
      underlyingPricer = (await MockPricerContract.deploy(
        oracleAddress
      )) as MockPricer;

      // impersonate owner and change the pricer
      await owner.sendTransaction({
        to: opynOwner,
        value: utils.parseEther('2.0')
      });
      await provider.send('hardhat_impersonateAccount', [opynOwner]);
      const signer = await ethers.provider.getSigner(opynOwner);
      await oracle
        .connect(signer)
        .setAssetPricer(underlying.address, underlyingPricer.address);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
    }
  );

  this.beforeAll('whitelist collateral & product in the Opyn system', async () => {
    const whitelist = (await ethers.getContractAt('IWhitelist', otokenWhitelistAddress)) as IWhitelist;

    // impersonate owner and change the whitelist
    await owner.sendTransaction({
      to: opynOwner,
      value: utils.parseEther('1.0')
    });
    await provider.send('hardhat_impersonateAccount', [opynOwner]);
    const signer = await ethers.provider.getSigner(opynOwner);
    await whitelist.connect(signer).whitelistCollateral(underlyingAddress);
    await whitelist
      .connect(signer)
      .whitelistProduct(
        underlying.address,
        usdc.address,
        underlying.address,
        false
      );
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
  });

  this.beforeAll('send everyone underlying', async () => {
    const whale = '0x6262998ced04146fa42253a5c0af90ca02dfd2a3'; //'0xF977814e90dA44bFA03b6295A0616a897441aceC'

    // send everyone underlying
    await provider.send('hardhat_impersonateAccount', [whale]);
    const signer = await ethers.provider.getSigner(whale);
    await underlying.connect(signer).transfer(counterpartyWallet.address, premium);
    await underlying.connect(signer).transfer(depositor1.address, p1DepositAmount);
    await underlying.connect(signer).transfer(depositor2.address, p2DepositAmount);
    await underlying.connect(signer).transfer(depositor3.address, p3DepositAmount);
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [whale]);
  })

  this.beforeAll('prepare counterparty wallet', async () => {
    // prepare counterparty
    counterpartyWallet = counterpartyWallet.connect(provider);
    await owner.sendTransaction({
      to: counterpartyWallet.address,
      value: utils.parseEther('3000')
    });

    // approve underlying to be spent by counterparty 
    await underlying.connect(counterpartyWallet).approve(swapAddress, premium);
  })


  describe('check the admin setup', async () => {
    it('contract is initialized correctly', async () => {
      // initial state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalUnderlyingAsset()).isZero(), 'total asset should be zero')
        .to.be.true;
    });

    it('should set withdraw reserve for vault', async () => {
      // 10% reserve default
      await vault.connect(owner).setWithdrawReserve((reserveFactor * 100));
      expect((await vault.withdrawReserve()).toNumber() == (reserveFactor * 100)).to.be.true;
    });


    it('should set withdrawal fee', async () => {
      // 0.5% fee percentage
      await vault.connect(owner).setWithdrawalFeePercentage((feePercentage * 100));
      expect((await vault.withdrawalFeePercentage()).toNumber() == (feePercentage * 100)).to.be.true;
    });
  });

  describe('not-profitable scenario', async () => {
    let actualAmountInVault;
    let otoken: IOToken;
    let expiry: number;
    let optionsSold: BigNumber;
    this.beforeAll(
      'deploy otoken that will be sold',
      async () => {
        const otokenStrikePrice = 5000000000000;
        const blockNumber = await provider.getBlockNumber();
        const block = await provider.getBlock(blockNumber);
        const currentTimestamp = block.timestamp;
        expiry = (Math.floor(currentTimestamp / day) + 10) * day + 28800;

        await otokenFactory.createOtoken(
          underlying.address,
          usdc.address,
          underlying.address,
          otokenStrikePrice,
          expiry,
          false
        );

        const otokenAddress = await otokenFactory.getOtoken(
          underlying.address,
          usdc.address,
          underlying.address,
          otokenStrikePrice,
          expiry,
          false
        );

        otoken = (await ethers.getContractAt(
          'IOToken',
          otokenAddress
        )) as IOToken;
      }
    );

    it('p1 deposits', async () => {
  
      // keep track of underlying & shares before deposit
      const underlyingBeforeDeposit = await vault.totalUnderlyingAsset();

      // approve and deposit underlying
      await underlying.connect(depositor1).approve(vault.address, p1DepositAmount);
      await vault.connect(depositor1).depositUnderlying(p1DepositAmount);

      // check underlying & shares deposited by depositor1
      const vaultTotal = await vault.totalUnderlyingAsset();
      const underlyingInVaultBalance = await underlying.balanceOf(vault.address);
      const totalSharesMinted = underlyingInVaultBalance;

      // check the underlying token balances
      expect(vaultTotal).to.be.equal(underlyingBeforeDeposit.add(p1DepositAmount), 'internal underlying balance is incorrect');
      expect(underlyingInVaultBalance).to.be.equal( vaultTotal, 'internal balance is incorrect');

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
    });

    it('p2 deposits', async () => {

      // keep track of underlying & shares before deposit
      const underlyingBeforeDeposit = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();

      // approve and deposit underlying
      await underlying.connect(depositor1).approve(vault.address, p2DepositAmount);
      await vault.connect(depositor1).depositUnderlying(p2DepositAmount);

      // check underlying deposited by depositor2
      const vaultTotal = await vault.totalUnderlyingAsset();
      const underlyingInVaultBalance = await underlying.balanceOf(vault.address);

      // check the underlying token balances
      expect(vaultTotal).to.be.equal(underlyingBeforeDeposit.add(p1DepositAmount), 'internal underlying balance is incorrect');
      expect(underlyingInVaultBalance).to.be.equal( vaultTotal, 'internal balance is incorrect');

      // check the minted share balances
      const underlyingDeposited = underlyingInVaultBalance.sub(underlyingBeforeDeposit);
      const totalSharesMinted = sharesBefore.div(underlyingBeforeDeposit).mul(underlyingDeposited)
      expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted').to.be.equal(totalSharesMinted)
    });

    it('owner commits to the option', async () => {
      await underlyingPricer.setPrice('4000000000000');
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitOToken(otoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });

    it('owner mints options with underlying as collateral and sells them', async () => {
      // increase time
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      // keep track of balance before rollover and create expected values
      const underlyingBalanceBeforeRollOver = await vault.totalUnderlyingAsset();

      const underlyingExpectedAfterMintTotal = underlyingBalanceBeforeRollOver.add(premium)
      const underlyingExpectedAfterMintInVault = underlyingBalanceBeforeRollOver.mul(reserveFactor).div(100)
      const underlyingExpectedBeforeMintInActionLocked = 0;
      const underlyingExpectedBeforeMintInActionUnlocked = underlyingBalanceBeforeRollOver.sub(underlyingExpectedAfterMintInVault)
      
      const underlyingExpectedAfterMintInActionLocked = underlyingBalanceBeforeRollOver.sub(underlyingExpectedAfterMintInVault);
      const underlyingExpectedAfterMintInActionUnlocked = premium;
      const underlyingExpectedAfterMintInActionTotal = underlyingExpectedAfterMintInActionUnlocked.add(underlyingExpectedAfterMintInActionLocked);
     
      console.log("premium: %d  -  underlyingBeforeRollOverTotal: %d",premium, underlyingBalanceBeforeRollOver);
      console.log("underlyingExpectedAfterMintInVault: %d  - underlyingExpectedAfterMintTotal: %d",underlyingExpectedAfterMintInVault, underlyingExpectedAfterMintTotal);
      console.log("underlyingExpectedAfterMintInActionLocked: %d  - underlyingExpectedAfterMintInActionUnlocked: %d - underlyingExpectedAfterMintInActionTotal %d",underlyingExpectedAfterMintInActionLocked, underlyingExpectedAfterMintInActionUnlocked, underlyingExpectedAfterMintInActionTotal);
     
      // rollover
      await vault.rollOver([(100 - reserveFactor) * 100]);

      // keer track after rollover 
      const collateralAmount = await underlying.balanceOf(action1.address)
      const marginPoolUnderlyingBeforeMint = await underlying.balanceOf(marginPoolAddess);

      
      //mint and sell oTokens
      const sellAmount = (collateralAmount.div(10**(underlyingDecimals-8))).toString(); // 8 used since opyn's oTokens is recognised in that 
    
      const order = await getOrder(
        action1.address,
        otoken.address,
        sellAmount,
        counterpartyWallet.address,
        underlying.address,
        premium.toString(),
        swapAddress,
        counterpartyWallet.privateKey
      );

      expect( (await action1.lockedAsset()).eq(underlyingExpectedBeforeMintInActionLocked),'collateral should not be locked' ).to.be.true;
      expect((await underlying.balanceOf(action1.address)).eq(underlyingExpectedBeforeMintInActionUnlocked),'collateral should all be unlocked').to.be.true;
      expect((await action1.currentValue()).eq(underlyingExpectedBeforeMintInActionUnlocked),'collateral should all be unlocked').to.be.true;

      await action1.mintAndSellOToken(collateralAmount, sellAmount, order);

      const underlyingAfterMintInVault = await underlying.balanceOf(vault.address)
      const underlyingAfterMintInActionTotal = await action1.currentValue();
      const underlyingAfterMintInActionUnlocked = await underlying.balanceOf(action1.address);
      const underlyingAfterMintInActionLocked = await action1.lockedAsset();
      const underlyingAfterMintTotal = await vault.totalUnderlyingAsset();
      const marginPoolUnderlyingAfterMint = await underlying.balanceOf(marginPoolAddess);
      
      console.log("underlyingAfterMintInVault: %d  -  underlyingAfterMintInActionTotal: %d",underlyingAfterMintInVault, underlyingAfterMintInActionTotal);
      console.log("underlyingAfterMintInActionUnlocked: %d  - underlyingAfterMintInActionLocked: %d - underlyingAfterMintTotal: %d",underlyingAfterMintInActionUnlocked, underlyingAfterMintInActionLocked, underlyingAfterMintTotal);
      console.log("marginPoolUnderlyingAfterMint: %d", marginPoolUnderlyingAfterMint);
     

      // check underlying balance in action and vault
      expect((underlyingAfterMintInVault), 'incorrect accounting in vault').to.be.equal(underlyingExpectedAfterMintInVault);
      expect((underlyingAfterMintInActionTotal), 'incorrect accounting in action total').to.be.equal(underlyingExpectedAfterMintInActionTotal);
      expect((underlyingAfterMintTotal), 'incorrect accounting in totals').to.be.equal(underlyingExpectedAfterMintTotal);
      expect((await action1.lockedAsset()), 'incorrect accounting in action').to.be.equal(collateralAmount)
      expect(await underlying.balanceOf(action1.address)).to.be.equal('0');


      // check the otoken balance of counterparty
      expect(await otoken.balanceOf(counterpartyWallet.address), 'incorrect otoken balance sent to counterparty').to.be.equal(sellAmount);
      // check underlying balance in opyn 
      expect(marginPoolUnderlyingAfterMint, 'incorrect balance in Opyn').to.be.equal(marginPoolUnderlyingBeforeMint.add(collateralAmount));
    });

    it('p3 deposits', async () => {
    
      const vaultTotalBefore = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      
      console.log("vaultTotalBefore: %d  -  sharesBefore: %d",vaultTotalBefore, sharesBefore);
      console.log("p3DepositAmount: %d",p3DepositAmount);
     
      // approve and deposit underlying
      await underlying.connect(depositor3).approve(vault.address, p3DepositAmount);
      await vault.connect(depositor3).depositUnderlying(p3DepositAmount);

      // check underlying & shares deposited by depositor3
      const vaultTotalAfter = await vault.totalUnderlyingAsset();
      const totalSharesMinted = p3DepositAmount.mul(sharesBefore).div(vaultTotalBefore);
      const totalSharesExisting = await vault.totalSupply();
      actualAmountInVault = await underlying.balanceOf(vault.address);

      // check the underlying token balances
      expect(vaultTotalAfter).to.be.equal(vaultTotalBefore.add(p3DepositAmount), 'internal underlying balance is incorrect');

      // check the minted share balances
      expect((await vault.balanceOf(depositor3.address)), 'incorrect amount of shares minted').to.be.equal(totalSharesMinted);
      expect(totalSharesExisting, 'incorrect amount of shares existing').to.be.equal(sharesBefore.add(totalSharesMinted));
  
      // manual checks
      expect(await underlying.balanceOf(vault.address)).to.be.equal(((await vault.withdrawReserve()).mul(p1DepositAmount.add(p2DepositAmount)).div(10000)).add(p3DepositAmount), 'internal underlying balance is incorrect'); //true after rollover
    

    });

    it('p1 withdraws', async () => {
      // vault shares and balance calculations
      const underlyingBeforeWithdrawal = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);

      console.log("underlyingBeforeWithdrawal: %d  -  sharesBefore: %d -  sharesToWithdraw: %d",underlyingBeforeWithdrawal, sharesBefore, sharesToWithdraw);

      // p1 balance calculations 
      const amountWithdrawn = sharesToWithdraw.mul(underlyingBeforeWithdrawal).div(sharesBefore)
      const fee = amountWithdrawn.mul(5).div(1000);
      const amountToUser = amountWithdrawn.sub(fee);


       // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositor1Before = await underlying.balanceOf(depositor1.address);
      const underlyingOfFeeRecipientBefore = await underlying.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositor1Before: %d - underlyingOfFeeRecipientBefore: %d",underlyingOfDepositor1Before, underlyingOfFeeRecipientBefore);
     
      // withdraw
      await vault.connect(depositor1).withdrawUnderlying(sharesToWithdraw);

      // keep track of underlying & shares after withdrawal
      const underlyingAfterWithdrawal = await vault.totalUnderlyingAsset();
      const sharesAfter = await vault.totalSupply();
      console.log("underlyingAfterWithdrawal: %d - sharesAfter: %d",underlyingAfterWithdrawal, sharesAfter);
     

      // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositorAfter = await underlying.balanceOf(depositor1.address);
      const underlyingOfFeeRecipientAfter = await underlying.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorAfter: %d - underlyingOfFeeRecipientAfter: %d",underlyingOfDepositor1Before, underlyingOfFeeRecipientBefore);
     
       // created expected values
      const underlyingExpectedAfterWithdrawal = underlyingBeforeWithdrawal.sub(amountWithdrawn);
      const sharesExpectedAfter = sharesBefore.sub(sharesToWithdraw);
      const underlyingOfDepositorExpectedAfter = underlyingOfDepositor1Before.add(amountToUser);
      const underlyingOfFeeRecipientExpectedAfter = underlyingOfFeeRecipientBefore.add(fee);
 
      // check total vault shares
      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesExpectedAfter)

      // check vault balance 
      expect(underlyingAfterWithdrawal, 'incorrect underlying remained in the vault').to.be.eq(underlyingExpectedAfterWithdrawal);

      // check p1 balance 
      expect(underlyingOfDepositorAfter, 'incorrect underlying given to depositor').to.be.eq(underlyingOfDepositorExpectedAfter);

      // check fee 
      expect(underlyingOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(underlyingOfFeeRecipientExpectedAfter)
    });

    it('option expires', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
      await provider.send('evm_mine', []);

      // set settlement price
      await underlyingPricer.setExpiryPriceInOracle(underlyingPricer.address, expiry, '10000000000000');
   

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      // keep track before closing positions
      const underlyingBeforeCloseInActionTotal = await action1.currentValue();
      console.log("underlyingBeforeCloseInActionTotal: %d",underlyingBeforeCloseInActionTotal);
      
     
      const priceAtExpiry = await oracle.getExpiryPrice(underlying.address, expiry);
      const underlyingPriceAtExpiry = priceAtExpiry[0]

      // getExpiryPrice is scaled to 1e8, options sold is scaled to 1e8, trying to scale to 1e18
      const collateralAmountDeducted = optionsSold.mul('1000000000000000000').mul('100000').div(underlyingPriceAtExpiry).div(2)
      const collateralAmountReturned = underlyingBeforeCloseInActionTotal.sub(collateralAmountDeducted).sub(1);
      const underlyingBalanceInVaultBefore = await underlying.balanceOf(vault.address);
      console.log("underlyingPriceAtExpiry: %d  -  collateralAmountDeducted: %d -  collateralAmountReturned: %d -  underlyingBalanceInVaultBefore: %d",underlyingPriceAtExpiry, collateralAmountDeducted, collateralAmountReturned, underlyingBalanceInVaultBefore);
      

      await vault.closePositions();

      const underlyingBalanceInVaultAfter = await underlying.balanceOf(vault.address);
      const underlyingBalanceInActionAfter = await underlying.balanceOf(action1.address);
      const underlyingControlledByActionAfter = await action1.currentValue();
      const vaultTotal = await vault.totalUnderlyingAsset();

      console.log("underlyingBalanceInVaultAfter: %d  -  underlyingBalanceInActionAfter: %d - underlyingControlledByActionAfter: %d - vaultTotal: %d",underlyingBalanceInVaultAfter, underlyingBalanceInActionAfter, underlyingControlledByActionAfter, vaultTotal);
      

      // check vault balances
      expect(vaultTotal, 'incorrect accounting in vault').to.be.equal(underlyingBalanceInVaultAfter);
      expect(underlyingBalanceInVaultAfter, 'incorrect balances in vault').to.be.equal(underlyingBalanceInVaultBefore.add(collateralAmountReturned));

      // check action balances
      expect((await action1.lockedAsset()).eq('0'), 'all collateral should be unlocked').to.be.true;
      expect(underlyingBalanceInActionAfter, 'no underlying should be left in action').to.be.equal('0');
      expect(underlyingControlledByActionAfter, 'no underlying should be controlled by action').to.be.equal('0');
    });

    it('p2 withdraws', async () => {
      // vault balance calculations
      const underlyingBeforeWithdrawal = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);

      console.log("underlyingBeforeWithdrawal: %d  -  sharesBefore: %d -  sharesToWithdraw: %d",underlyingBeforeWithdrawal, sharesBefore, sharesToWithdraw);

      // balance calculations 
      //  since underlying price doubled, they should get about half back.
      const amountToWithdraw = sharesToWithdraw.mul(underlyingBeforeWithdrawal).div(sharesBefore) // how to do this
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountToUser = amountToWithdraw.sub(fee);
      console.log("amountToWithdraw: %d  -  fee: %d -  amountToUser: %d",amountToWithdraw, fee, amountToUser);


      // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositorBefore = await underlying.balanceOf(depositor2.address);
      const underlyingOfFeeRecipientBefore = await underlying.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorBefore: %d  -  underlyingOfFeeRecipientBefore: %d",underlyingOfDepositorBefore, underlyingOfFeeRecipientBefore);


      await vault.connect(depositor2).withdrawUnderlying(sharesToWithdraw);

      // keep track of underlying & shares after withdrawal
      const underlyingAfterWithdrawal = await vault.totalUnderlyingAsset();
      const sharesAfter = await vault.totalSupply();
      console.log("underlyingAfterWithdrawal: %d  -  sharesAfter: %d",underlyingAfterWithdrawal, sharesAfter);

    
      // keep track of underlying of other parties after withdrawal
      const underlyingOfDepositorAfter = await underlying.balanceOf(depositor2.address);
      const underlyingOfFeeRecipientAfter = await underlying.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorAfter: %d  -  underlyingOfFeeRecipientAfter: %d",underlyingOfDepositorAfter, underlyingOfFeeRecipientAfter);
      
      // created expected values
      const underlyingExpectedAfterWithdrawal = underlyingBeforeWithdrawal.sub(amountToWithdraw);
      const sharesExpectedAfter = sharesBefore.sub(sharesToWithdraw);
      const underlyingOfDepositorExpectedAfter = underlyingOfDepositorBefore.add(amountToUser);
      const underlyingOfFeeRecipientExpectedAfter = underlyingOfFeeRecipientBefore.add(fee);
 

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesExpectedAfter)

      // check user balance 
      expect(underlyingOfDepositorAfter, 'incorrect underlying given to depositor').to.be.eq(underlyingOfDepositorExpectedAfter);

      expect(underlyingAfterWithdrawal, 'incorrect underlying remained in the vault').to.be.eq(underlyingExpectedAfterWithdrawal);

      // check user shares
      expect(await vault.balanceOf(depositor2.address), 'user should not have any shares left').to.be.equal('0');

      // check fee 
      expect(underlyingOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(underlyingOfFeeRecipientExpectedAfter)
    });

    it('p3 withdraws', async () => {
      
      const underlyingBeforeWithdrawal = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor3.address);

      console.log("underlyingBeforeWithdrawal: %d  -  sharesBefore: %d -  sharesToWithdraw: %d",underlyingBeforeWithdrawal, sharesBefore, sharesToWithdraw);

      // balance calculations 
      //  since underlying price doubled, they should get about half back.
      const amountToWithdraw = sharesToWithdraw.mul(underlyingBeforeWithdrawal).div(sharesBefore) // how to do this
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountToUser = amountToWithdraw.sub(fee);
      console.log("amountToWithdraw: %d  -  fee: %d -  amountToUser: %d",amountToWithdraw, fee, amountToUser);

      // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositorBefore = await underlying.balanceOf(depositor2.address);
      const underlyingOfFeeRecipientBefore = await underlying.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorBefore: %d  -  underlyingOfFeeRecipientBefore: %d",underlyingOfDepositorBefore, underlyingOfFeeRecipientBefore);

      await vault.connect(depositor3).withdrawUnderlying(await vault.balanceOf(depositor3.address));

      // keep track of underlying & shares after withdrawal
      const underlyingAfterWithdrawal = await vault.totalUnderlyingAsset();
      const sharesAfter = await vault.totalSupply();
      console.log("underlyingAfterWithdrawal: %d  -  sharesAfter: %d",underlyingAfterWithdrawal, sharesAfter);
      
      // keep track of underlying of other parties after withdrawal
      const underlyingOfDepositorAfter = await underlying.balanceOf(depositor2.address);
      const underlyingOfFeeRecipientAfter = await underlying.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorAfter: %d  -  underlyingOfFeeRecipientAfter: %d",underlyingOfDepositorAfter, underlyingOfFeeRecipientAfter);
      

      // created expected values
     // const underlyingExpectedAfterWithdrawal = underlyingBeforeWithdrawal.sub(amountToWithdraw);
    //  const sharesExpectedAfter = sharesBefore.sub(sharesToWithdraw);
      const underlyingOfDepositorExpectedAfter = underlyingOfDepositorBefore.add(amountToUser);
      const underlyingOfFeeRecipientExpectedAfter = underlyingOfFeeRecipientBefore.add(fee);
   
    
      expect((await vault.totalUnderlyingAsset()).eq('0'), 'total in vault should be empty').to.be.true;
      expect(await underlying.balanceOf(vault.address), 'total in vault should be empty').to.be.equal( '0');

      // check fee 
      expect(underlyingOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(underlyingOfFeeRecipientExpectedAfter.add(fee))

      // check p3 balance 
      expect(underlyingOfDepositorAfter, 'incorrect underlying given to depositor').to.be.eq(underlyingOfDepositorExpectedAfter);
    });

    // it('counterparty redeems and gets underlying', async () => {

    //   const underlyingPrice = await oracle.getExpiryPrice(underlying.address, expiry);
    //   const sdecrvToUnderlyingPrice = sdecrvPrice[0]
    //   // options sold * 5000/ 10000 * 1/sdecrvConv = payout, scaling this up to 1e18. 
    //   const payout = optionsSold.mul('1000000000000000000').mul('10000').div(sdecrvToUnderlyingPrice).div(2)
    //   const payoutExpected = payout.mul(9999).div(10000);

    //   const sdecrvBalanceBefore = await underlying.balanceOf(counterpartyWallet.address);

    //   const actionArgs = [
    //     {
    //       actionType: ActionType.Redeem,
    //       owner: ZERO_ADDR,
    //       secondAddress: counterpartyWallet.address,
    //       asset: otoken.address,
    //       vaultId: '0',
    //       amount: optionsSold,
    //       index: '0',
    //       data: ZERO_ADDR,
    //     },
    //   ]

    //   await controller.connect(counterpartyWallet).operate(actionArgs);

    //   const sdecrvBalanceAfter = await underlying.balanceOf(counterpartyWallet.address);

    //   // TODO: off by a small amount, need to figure out how best to round. 
    //   expect(sdecrvBalanceBefore.add(payoutExpected).lte(sdecrvBalanceAfter)).to.be.true;
    //   expect(sdecrvBalanceBefore.add(payout).gte(sdecrvBalanceAfter)).to.be.true;
    // })
  });
});