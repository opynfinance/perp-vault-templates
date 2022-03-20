import {ethers, network} from 'hardhat';
import {BigNumber, Signer, utils} from 'ethers';
import {SignerWithAddress} from '@nomiclabs/hardhat-ethers/signers';
import {expect} from 'chai';
import {
  OpynPerpVault,
  IERC20,
  ERC20,
  ShortOTokenActionWithSwap,
  IOtokenFactory,
  IOToken,
  IOracle,
  IWhitelist,
  MockPricer,
  IController
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

describe('Mainnet Fork Tests', function() {
  let counterpartyWallet = ethers.Wallet.fromMnemonic(
    mnemonic,
    "m/44'/60'/0'/0/30"
  );
  let action1: ShortOTokenActionWithSwap;
  // asset used by this action: in this case, underlying
  let underlying: IERC20;
  let usdc: IERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let feeWithdrawalRecipient: SignerWithAddress;
  let feePerformanceRecipient: SignerWithAddress;
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
  let profit = BigNumber.from('0');  //represents remaining profit to be claimed
  let callPayOffActual : BigNumber;

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
  const opynWhitelister = '0x2FCb2fc8dD68c48F406825255B4446EDFbD3e140';
  const otokenFactoryAddress = '0x7C06792Af1632E77cb27a558Dc0885338F4Bdf8E';
  const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddess = '0x5934807cC0654d46755eBd2848840b616256C6Ef'

 /**
   *
   * FUNCTIONS
   *
   */
  function maxBN(a: BigNumber, b: BigNumber): BigNumber {return a.gt(b) ? a : b } 
  function minBN(a: BigNumber, b: BigNumber): BigNumber {return a.lt(b) ? a : b } 

  /** Vault Params Chosen */
  const underlyingAddress = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9';  // i.e. WBTC:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599, AAVE:0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9
  const reserveFactor = 1000;  //w.r.t. BASE so 1000: 10%
  const withdrawalFeePercentage = 50;  //w.r.t. BASE so 50: 0.5%
  const perfromanceFeePercentage = 1000; //w.r.t. BASE so 1000: 10%
  const BASE = 10000
  const mintPercentage = 9000; // w.r.t BASE so 10000: 90% - Percentage of underlying in the action to mint and sell
  

  /** Test Scenario Params */
  const p1Amount = '10';
  const p2Amount = '70';
  const p3Amount = '20';
  const premiumAmount = '6';


  /**
   *
   * Setup
   *
   */

  this.beforeAll('Set accounts', async () => {
    accounts = await ethers.getSigners();

    const [
      _owner,
      _feeWithdrawalRecipient,
      _feePerformanceRecipient,
      _depositor1,
      _depositor2,
      _depositor3,
    ] = accounts;

    await network.provider.send("hardhat_setBalance", [
      opynWhitelister,
      "0x1000000000000000000000000000000",
    ]);

    owner = _owner;
    feeWithdrawalRecipient = _feeWithdrawalRecipient;
    feePerformanceRecipient = _feePerformanceRecipient;
    depositor1 = _depositor1;
    depositor2 = _depositor2;
    depositor3 = _depositor3;
  });

  this.beforeAll('Connect to mainnet contracts', async () => {
    underlying = (await ethers.getContractAt('IERC20', underlyingAddress)) as IERC20;
    usdc = (await ethers.getContractAt('IERC20', usdcAddress)) as IERC20;
    otokenFactory = (await ethers.getContractAt('IOtokenFactory',otokenFactoryAddress)) as IOtokenFactory;
    oracle = (await ethers.getContractAt('IOracle', oracleAddress)) as IOracle;
    controller = (await ethers.getContractAt('IController',controllerAddress)) as IController;
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
      feeWithdrawalRecipient.address,
      feePerformanceRecipient.address,
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
    "Deploy the underlying pricer and update in opyn's oracle",
    async () => {
      provider = ethers.provider;

      const MockPricerContract = await ethers.getContractFactory('MockPricer');
      underlyingPricer = (await MockPricerContract.deploy(
        oracleAddress
      )) as MockPricer;

      // impersonate owner and change the pricer
      await owner.sendTransaction({
        to: opynWhitelister,
        value: utils.parseEther('2.0')
      });
      await provider.send('hardhat_impersonateAccount', [opynWhitelister]);
      const signer = await ethers.provider.getSigner(opynWhitelister);
      await oracle
        .connect(signer)
        .setAssetPricer(underlying.address, underlyingPricer.address);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [opynWhitelister]);
    }
  );

  this.beforeAll('whitelist collateral & product in the Opyn system', async () => {
    const whitelist = (await ethers.getContractAt(
      'IWhitelist',
      otokenWhitelistAddress
    )) as IWhitelist;

    // impersonate owner and change the whitelist
    await owner.sendTransaction({
      to: opynWhitelister,
      value: utils.parseEther('1.0')
    });
    await provider.send('hardhat_impersonateAccount', [opynWhitelister]);
    const signer = await ethers.provider.getSigner(opynWhitelister);
    await whitelist.connect(signer).whitelistCollateral(underlying.address);
    await whitelist
      .connect(signer)
      .whitelistProduct(
        underlying.address,
        usdc.address,
        underlying.address,
        false
      );
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynWhitelister]);
  });

  this.beforeAll('send everyone underlying', async () => { 
    const whale = '0x6262998ced04146fa42253a5c0af90ca02dfd2a3'; //'0xdfd5293d8e347dfe59e90efd55b2956a1343963d' //'0xF977814e90dA44bFA03b6295A0616a897441aceC'

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

    it('should set withdraw reserve', async () => {
      // 10% withdraw reserve default
      await vault.connect(owner).setWithdrawReserve((reserveFactor));
      expect((await vault.withdrawReserve()).toNumber() == (reserveFactor)).to.be.true;
    });

    it('should set withdrawal fee', async () => {
      // 0.5% withdrawal fee default
      await vault.connect(owner).setWithdrawalFeePercentage((withdrawalFeePercentage));
      expect((await vault.withdrawalFeePercentage()).toNumber() == (withdrawalFeePercentage)).to.be.true;
    });
  });

  describe('profitable scenario', async () => {
    let otoken: IOToken;
    let expiry: number;
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
      const sharesBefore = await vault.totalSupply();

      // approve and deposit underlying
      await underlying.connect(depositor1).approve(vault.address, p1DepositAmount);
      await vault.connect(depositor1).depositUnderlying(p1DepositAmount);

      // check underlying & shares deposited by depositor1
      const vaultTotal = await vault.totalUnderlyingAsset();
      const totalSharesMinted = p1DepositAmount;
      const totalSharesExisting = await vault.totalSupply();

      // check the underlying token balances
      expect(vaultTotal).to.be.equal(underlyingBeforeDeposit.add(p1DepositAmount), 'internal underlying balance is incorrect');

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrect amount of shares minted').to.be.equal(totalSharesMinted);
      expect(totalSharesExisting, 'incorrect amount of shares existing').to.be.equal(sharesBefore.add(totalSharesMinted));

      // manual checks
      expect(vaultTotal).to.be.equal(await underlying.balanceOf(vault.address), 'internal underlying balance is incorrect'); //true before rollover
    });

    it('p2 deposits', async () => {
      // keep track of underlying & shares before deposit
      const underlyingBeforeDeposit = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();

      // approve and deposit underlying
      await underlying.connect(depositor2).approve(vault.address, p2DepositAmount);
      await vault.connect(depositor2).depositUnderlying(p2DepositAmount);

      // check underlying & shares deposited by depositor2
      const vaultTotal = await vault.totalUnderlyingAsset();
      const totalSharesMinted = sharesBefore.mul(p2DepositAmount).div(underlyingBeforeDeposit);
      const totalSharesExisting = await vault.totalSupply();

      // check the underlying token balances
      expect(vaultTotal).to.be.equal(underlyingBeforeDeposit.add(p2DepositAmount), 'internal underlying balance is incorrect');

      // check the minted share balances
      expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted').to.be.equal(totalSharesMinted);
      expect(totalSharesExisting, 'incorrect amount of shares existing').to.be.equal(sharesBefore.add(totalSharesMinted));

      // manual checks
      expect(vaultTotal).to.be.equal(await underlying.balanceOf(vault.address), 'internal underlying balance is incorrect'); //true before rollover
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

      // keep track before rollover and create expected values
      const underlyingBeforeRollOverTotal = await vault.totalUnderlyingAsset();
      const underlyingExpectedAfterMintTotal = underlyingBeforeRollOverTotal.add(premium);
      const underlyingExpectedAfterRolloverInAction = underlyingBeforeRollOverTotal.sub(underlyingBeforeRollOverTotal.mul(reserveFactor).div(BASE));
      const underlyingExpectedAfterRolloverInVault = underlyingBeforeRollOverTotal.mul(reserveFactor).div(BASE);
      const underlyingExpectedAfterMintInVault = underlyingBeforeRollOverTotal.mul(reserveFactor).div(BASE);
      const underlyingExpectedBeforeMintInActionLocked = 0;
      const underlyingExpectedBeforeMintInActionUnlocked = underlyingBeforeRollOverTotal.sub(underlyingBeforeRollOverTotal.mul(reserveFactor).div(BASE));
      const underlyingExpectedBeforeMintInActionTotal = underlyingExpectedBeforeMintInActionUnlocked.add(underlyingExpectedBeforeMintInActionLocked);
      const underlyingExpectedAfterMintInActionLocked = underlyingExpectedAfterRolloverInAction.mul(mintPercentage).div(BASE); // lockpercentage
      const underlyingPercentageNotMinted = BASE -mintPercentage;
      const underlyingNotMintedExpectedAfterMintInActionUnlocked = await underlyingExpectedAfterRolloverInAction.mul(underlyingPercentageNotMinted).div(BASE)
      const underlyingExpectedAfterMintInActionUnlocked = premium.add(underlyingNotMintedExpectedAfterMintInActionUnlocked);
      const underlyingExpectedAfterMintInActionTotal = underlyingExpectedAfterMintInActionUnlocked.add(underlyingExpectedAfterMintInActionLocked);
      const underlyingUsedForStrategyBeforeCloseInVaultTotal = await vault.totalUnderlyingInvestedInAction(action1.address);

      // rollover
      await vault.rollOver([(BASE - reserveFactor)]);

      // keep track after rollover and before mint
      const collateralAmount = await underlying.balanceOf(action1.address);
      const collateralAmountToMint = await (await underlying.balanceOf(action1.address)).mul(mintPercentage).div(BASE);
      expect((underlyingBeforeRollOverTotal.sub(underlyingExpectedAfterRolloverInVault)), 'incorrect accounting after rollover').to.be.equal(collateralAmount);
      const marginPoolUnderlyingBeforeMint = await underlying.balanceOf(marginPoolAddess);

      // mint and sell oTokens
      const sellAmount = (collateralAmountToMint).div(10**(underlyingDecimals-8)).toString();
      
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
      
      expect((await action1.lockedAsset()).eq(underlyingExpectedBeforeMintInActionLocked),'collateral should not be locked').to.be.true;
      expect((await underlying.balanceOf(action1.address)).eq(underlyingExpectedBeforeMintInActionUnlocked),'collateral should all be unlocked').to.be.true;
      expect((await action1.currentValue()).eq(underlyingExpectedBeforeMintInActionUnlocked),'collateral should all be unlocked').to.be.true;

      await action1.mintAndSellOToken(collateralAmountToMint, sellAmount, order);

      // keep track after rollover and mint
      const underlyingAfterMintInVault = await underlying.balanceOf(vault.address);
      const underlyingAfterMintInActionTotal = await action1.currentValue();
      const underlyingAfterMintInActionUnlocked = await underlying.balanceOf(action1.address);
      const underlyingAfterMintInActionLocked =  await action1.lockedAsset();
      const underlyingAfterMintTotal = await vault.totalUnderlyingAsset();
      const marginPoolUnderlyingAfterMint = await underlying.balanceOf(marginPoolAddess);
      const underlyingUsedForStrategyAfterCloseInVaultTotal = await vault.totalUnderlyingInvestedInAction(action1.address);

      // check underlying balance in action and vault
      expect((underlyingAfterMintInVault), 'incorrect accounting in vault').to.be.equal(underlyingExpectedAfterMintInVault);
      expect((underlyingAfterMintInActionTotal), 'incorrect accounting in action total').to.be.equal(underlyingExpectedAfterMintInActionTotal);
      expect((underlyingAfterMintTotal), 'incorrect accounting in totals').to.be.equal(underlyingExpectedAfterMintTotal);
      expect(underlyingAfterMintInActionLocked, 'incorrect accounting in locked asset 1').to.be.equal(collateralAmountToMint);
      expect(underlyingAfterMintInActionUnlocked, 'incorrect accounting in locked asset 3').to.be.equal(underlyingExpectedAfterMintInActionUnlocked);
      expect(underlyingUsedForStrategyAfterCloseInVaultTotal, 'incorrect accounting for action underlying being tracked in vault').to.be.equal(underlyingUsedForStrategyBeforeCloseInVaultTotal.add(collateralAmount));
      
     
      // check the otoken balance of counterparty
      expect(await otoken.balanceOf(counterpartyWallet.address), 'incorrect otoken balance sent to counterparty').to.be.equal(sellAmount);

      // check underlying balance in opyn
      expect(marginPoolUnderlyingAfterMint, 'incorrect balance in Opyn').to.be.equal(marginPoolUnderlyingBeforeMint.add(collateralAmountToMint));
    });

    it('p3 deposits', async () => {
      // keep track of underlying & shares before deposit
      const underlyingBeforeDeposit = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();

      // approve and deposit underlying
      await underlying.connect(depositor3).approve(vault.address, p3DepositAmount);
      await vault.connect(depositor3).depositUnderlying(p3DepositAmount);

      // check underlying & shares deposited by depositor3
      const vaultTotal = await vault.totalUnderlyingAsset();
      const totalSharesMinted = sharesBefore.mul(p3DepositAmount).div(underlyingBeforeDeposit);
      const totalSharesExisting = await vault.totalSupply();

      // check the underlying token balances
      expect(vaultTotal).to.be.equal(underlyingBeforeDeposit.add(p3DepositAmount), 'internal underlying balance is incorrect');

      // check the minted share balances
      expect((await vault.balanceOf(depositor3.address)), 'incorrect amount of shares minted').to.be.equal(totalSharesMinted);
      expect(totalSharesExisting, 'incorrect amount of shares existing').to.be.equal(sharesBefore.add(totalSharesMinted));

      // manual checks
      expect(await underlying.balanceOf(vault.address)).to.be.equal(((await vault.withdrawReserve()).mul(p1DepositAmount.add(p2DepositAmount)).div(10000)).add(p3DepositAmount), 'internal underlying balance is incorrect'); //true after rollover
    });

    it('p1 withdraws', async () => {
      // keep track of underlying & shares before withdrawal
      const underlyingBeforeWithdrawal = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);

      // balance calculations
    //  const performanceFee = sharesToWithdraw.mul(profit).mul(perfromanceFeePercentage).div(sharesBefore).div(BASE);
      //if PerfFees=0 no substraction, if PerfFees>0 already happened in ClosePosition() so always no substraction
      const amountWithdrawnAfterPerformanceFees = sharesToWithdraw.mul(underlyingBeforeWithdrawal).div(sharesBefore);
      const withdrawalFee = amountWithdrawnAfterPerformanceFees.mul(withdrawalFeePercentage).div(BASE);
      const amountToUser = amountWithdrawnAfterPerformanceFees.sub(withdrawalFee);

      // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositorBefore = await underlying.balanceOf(depositor1.address);
      const underlyingOfFeeWithdrawalRecipientBefore = await underlying.balanceOf(feeWithdrawalRecipient.address);

      await vault
        .connect(depositor1)
        .withdrawUnderlying(sharesToWithdraw);

      // keep track of underlying & shares after withdrawal
      const underlyingAfterWithdrawal = await vault.totalUnderlyingAsset();
      const sharesAfter = await vault.totalSupply();

      // keep track of underlying of other parties after withdrawal
      const underlyingOfDepositorAfter = await underlying.balanceOf(depositor1.address);
      const underlyingOfFeeWithdrawalRecipientAfter = await underlying.balanceOf(feeWithdrawalRecipient.address);

      // created expected values
      const underlyingExpectedAfterWithdrawal = underlyingBeforeWithdrawal.sub(amountWithdrawnAfterPerformanceFees);
      const sharesExpectedAfter = sharesBefore.sub(sharesToWithdraw);
      const underlyingOfDepositorExpectedAfter = underlyingOfDepositorBefore.add(amountToUser);
      const underlyingOfFeeWithdrawalRecipientExpectedAfter = underlyingOfFeeWithdrawalRecipientBefore.add(withdrawalFee);
      
      // check total vault shares
      expect(sharesAfter, 'incorrect amount of shares withdrawn').to.be.equal(sharesExpectedAfter);

      // check user shares
      expect(await vault.balanceOf(depositor1.address), 'user should not have any shares left').to.be.equal('0');

      // check vault balance 
      expect(underlyingAfterWithdrawal, 'incorrect underlying remained in the vault').to.be.eq(underlyingExpectedAfterWithdrawal);

      // check user balance 
      expect(underlyingOfDepositorAfter, 'incorrect underlying given to depositor').to.be.eq(underlyingOfDepositorExpectedAfter);

      // check withdrawal fee 
      expect(underlyingOfFeeWithdrawalRecipientAfter, 'incorrect withdrawal fee paid out to fee recipient').to.be.eq(underlyingOfFeeWithdrawalRecipientExpectedAfter);

      // manual checks on performance fee
      expect(underlyingOfDepositorAfter, 'Depositor 1 should be in Profit').gte(p1DepositAmount); //it is true as in this case all the amount of that wallet was deposited for this strategy
      expect(underlyingOfDepositorAfter, 'Depositor 1 profit calculations do not match').to.be.eq((p1DepositAmount.sub(withdrawalFee)).add(p1DepositAmount.mul(premium).div(p1DepositAmount.add(p2DepositAmount))));

      //update profit
      profit = (sharesBefore.sub(sharesToWithdraw)).mul(profit).div(sharesBefore);

    });

    it('option expires', async () => {
       // increase time
       await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
       await provider.send('evm_mine', []);
 
       // set settlement price
       await underlyingPricer.setExpiryPriceInOracle(underlying.address, expiry, '3000000000000');       
      
       // increase time
       await provider.send('evm_increaseTime', [day]); // increase time
       await provider.send('evm_mine', []);

       // keep track before closing positions
       const underlyingBeforeCloseInActionTotal = await action1.currentValue();
       const underlyingBeforeCloseInVaultTotal = await underlying.balanceOf(vault.address);
       const lockedAsset = await action1.currentLockedAsset();
       const underlyingUsedForStrategyBeforeCloseInVaultTotal = await vault.totalUnderlyingInvestedInAction(action1.address);
       const underlyingOfFeePerformanceRecipientBefore = await underlying.balanceOf(feePerformanceRecipient.address);
       const underlyingNotInvested = underlyingBeforeCloseInActionTotal.sub(lockedAsset).sub(premium);

      // get expected profit 
      const callPayOff = (maxBN((((await oracle.getExpiryPrice(underlying.address, expiry))[0]).sub(await otoken.strikePrice())).mul(BigNumber.from('10').pow(underlyingDecimals)).div(((await oracle.getExpiryPrice(underlying.address, expiry))[0])),BigNumber.from("0")));
      callPayOffActual = callPayOff.mul(lockedAsset.div(BigNumber.from('10').pow(underlyingDecimals)));
  
     // const realProfit = (premium.sub(callPayOffActual)).add(profit).add(underlyingNotInvested);
      const actionBalance = underlyingBeforeCloseInActionTotal.sub(callPayOffActual)
      const realProfit = underlyingBeforeCloseInActionTotal.sub(underlyingUsedForStrategyBeforeCloseInVaultTotal);
      profit = maxBN(realProfit ,BigNumber.from('0'));
      const performanceFee = profit.mul(perfromanceFeePercentage).div(BASE);
      const netProfit = profit.mul(BASE-perfromanceFeePercentage).div(BASE);
      const realNetProfit = minBN(netProfit ,realProfit);

       // close positions
       await vault.closePositions();
 
       // keep track after closing positions
       const underlyingAfterCloseInActionTotal = await action1.currentValue();
       const underlyingAfterCloseInVaultTotal = await underlying.balanceOf(vault.address);
       const vaultTotal = await vault.totalUnderlyingAsset();
       const underlyingOfFeePerformanceRecipientAfter = await underlying.balanceOf(feePerformanceRecipient.address);
       const underlyingUsedForStrategyAfterCloseInVaultTotal = await vault.totalUnderlyingInvestedInAction(action1.address);
       // check vault balances
       expect(vaultTotal, 'incorrect accounting in vault').to.be.equal(underlyingAfterCloseInVaultTotal);
       expect(underlyingAfterCloseInVaultTotal, 'incorrect balances in vault').to.be.equal(underlyingBeforeCloseInVaultTotal.add(actionBalance).sub(performanceFee));
       expect(underlyingUsedForStrategyAfterCloseInVaultTotal, 'underlying tracked by vault should be tracked 0').to.be.equal('0');
      
       // check action balances
       expect((await action1.lockedAsset()).eq('0'),'no underlying should be locked').to.be.true;
       expect((await underlying.balanceOf(action1.address)), 'no underlying should be left in action').to.be.equal('0');
       expect(underlyingAfterCloseInActionTotal, 'no underlying should be controlled by action').to.be.equal('0');
       
       // check profit 
       expect(realProfit, 'profit calculations do not match').to.be.equal(actionBalance.sub(underlyingUsedForStrategyBeforeCloseInVaultTotal));

      // check performance fee
      expect(underlyingOfFeePerformanceRecipientAfter, 'incorrect performance fee paid out to fee recipient').to.be.eq(underlyingOfFeePerformanceRecipientBefore.add(profit.mul(perfromanceFeePercentage).div(BASE)));
    });

    it('p2 withdraws', async () => {
      // keep track of underlying & shares before withdrawal
      const underlyingBeforeWithdrawal = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);

      // balance calculations
      const performanceFee = sharesToWithdraw.mul(profit).mul(perfromanceFeePercentage).div(sharesBefore).div(BASE);
      //if PerfFees=0 no substraction, if PerfFees>0 already happened in ClosePosition() so always no substraction
      const amountWithdrawnAfterPerformanceFees = sharesToWithdraw.mul(underlyingBeforeWithdrawal).div(sharesBefore);
      const withdrawalFee = amountWithdrawnAfterPerformanceFees.mul(withdrawalFeePercentage).div(BASE);
      const amountToUser = amountWithdrawnAfterPerformanceFees.sub(withdrawalFee);

      // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositorBefore = await underlying.balanceOf(depositor2.address);
      const underlyingOfFeeWithdrawalRecipientBefore = await underlying.balanceOf(feeWithdrawalRecipient.address);

      await vault
        .connect(depositor2)
        .withdrawUnderlying(sharesToWithdraw);

      // keep track of underlying & shares after withdrawal
      const underlyingAfterWithdrawal = await vault.totalUnderlyingAsset();
      const sharesAfter = await vault.totalSupply();

      // keep track of underlying of other parties after withdrawal
      const underlyingOfDepositorAfter = await underlying.balanceOf(depositor2.address);
      const underlyingOfFeeWithdrawalRecipientAfter = await underlying.balanceOf(feeWithdrawalRecipient.address);

      // created expected values
      const underlyingExpectedAfterWithdrawal = underlyingBeforeWithdrawal.sub(amountWithdrawnAfterPerformanceFees);
      const sharesExpectedAfter = sharesBefore.sub(sharesToWithdraw);
      const underlyingOfDepositorExpectedAfter = underlyingOfDepositorBefore.add(amountToUser);
      const underlyingOfFeeWithdrawalRecipientExpectedAfter = underlyingOfFeeWithdrawalRecipientBefore.add(withdrawalFee);

      // check total vault shares
      expect(sharesAfter, 'incorrect amount of shares withdrawn').to.be.equal(sharesExpectedAfter);

      // check user shares
      expect(await vault.balanceOf(depositor2.address), 'user should not have any shares left').to.be.equal('0');

      // check vault balance 
      expect(underlyingAfterWithdrawal, 'incorrect underlying remained in the vault').to.be.eq(underlyingExpectedAfterWithdrawal);

      // check user balance 
      expect(underlyingOfDepositorAfter, 'incorrect underlying given to depositor').to.be.eq(underlyingOfDepositorExpectedAfter);

      // check withdrawal fee 
      expect(underlyingOfFeeWithdrawalRecipientAfter, 'incorrect withdrawal fee paid out to fee recipient').to.be.eq(underlyingOfFeeWithdrawalRecipientExpectedAfter);

      // manual checks on profitability
      expect(underlyingOfDepositorAfter, 'Depositor 2 should be in Profit').gte(p2DepositAmount); //it is true as in this case all the amount of that wallet was deposited for this strategy
      expect(underlyingOfDepositorAfter, 'Depositor 2 profit calculations do not match').to.be.eq((p2DepositAmount.sub(withdrawalFee)).add(p2DepositAmount.mul(premium).div(p1DepositAmount.add(p2DepositAmount))).sub(performanceFee).sub(sharesToWithdraw.mul(callPayOffActual).div(sharesBefore)).sub(1)); // -also may fail due to rounding error (why the sub 1 is added) need to find where this happens

      //update profit
      profit = (sharesBefore.sub(sharesToWithdraw)).mul(profit).div(sharesBefore);
    });

    it('p3 withdraws', async () => {
      // keep track of underlying & shares before withdrawal
      const underlyingBeforeWithdrawal = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor3.address);

      // balance calculations
      const performanceFee = sharesToWithdraw.mul(profit).mul(perfromanceFeePercentage).div(sharesBefore).div(BASE);
      //if PerfFees=0 no substraction, if PerfFees>0 already happened in ClosePosition() so always no substraction
      const amountWithdrawnAfterPerformanceFees = sharesToWithdraw.mul(underlyingBeforeWithdrawal).div(sharesBefore);
      const withdrawalFee = amountWithdrawnAfterPerformanceFees.mul(withdrawalFeePercentage).div(BASE);
      const amountToUser = amountWithdrawnAfterPerformanceFees.sub(withdrawalFee);

      // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositorBefore = await underlying.balanceOf(depositor3.address);
      const underlyingOfFeeWithdrawalRecipientBefore = await underlying.balanceOf(feeWithdrawalRecipient.address);

      await vault
        .connect(depositor3)
        .withdrawUnderlying(sharesToWithdraw);

      // keep track of underlying & shares after withdrawal
      const underlyingAfterWithdrawal = await vault.totalUnderlyingAsset();
      const sharesAfter = await vault.totalSupply();

      // keep track of underlying of other parties after withdrawal
      const underlyingOfDepositorAfter = await underlying.balanceOf(depositor3.address);
      const underlyingOfFeeWithdrawalRecipientAfter = await underlying.balanceOf(feeWithdrawalRecipient.address);

      // created expected values
      const underlyingExpectedAfterWithdrawal = underlyingBeforeWithdrawal.sub(amountWithdrawnAfterPerformanceFees);
      const sharesExpectedAfter = sharesBefore.sub(sharesToWithdraw);
      const underlyingOfDepositorExpectedAfter = underlyingOfDepositorBefore.add(amountToUser);
      const underlyingOfFeeWithdrawalRecipientExpectedAfter = underlyingOfFeeWithdrawalRecipientBefore.add(withdrawalFee);

      // check total vault shares
      expect(sharesAfter, 'incorrect amount of shares withdrawn').to.be.equal(sharesExpectedAfter);

      // check user shares
      expect(await vault.balanceOf(depositor3.address), 'user should not have any shares left').to.be.equal('0');

      // check vault balance 
      expect(underlyingAfterWithdrawal, 'incorrect underlying remained in the vault').to.be.eq(underlyingExpectedAfterWithdrawal);

      // check user balance 
      expect(underlyingOfDepositorAfter, 'incorrect underlying given to depositor').to.be.eq(underlyingOfDepositorExpectedAfter);

      // check withdrawal fee 
      expect(underlyingOfFeeWithdrawalRecipientAfter, 'incorrect withdrawal fee paid out to fee recipient').to.be.eq(underlyingOfFeeWithdrawalRecipientExpectedAfter);

      // manual checks on profitability
      expect(underlyingOfDepositorAfter, 'Depositor 3 should NOT be in Profit').lte(p3DepositAmount); //it is true as in this case all the amount of that wallet was deposited for this strategy
      expect(underlyingOfDepositorAfter, 'Depositor 3 profit -loss in this case- calculations do not match').to.be.eq(p3DepositAmount.sub(withdrawalFee).sub(performanceFee).sub(sharesToWithdraw.mul(callPayOffActual).div(p2DepositAmount.add(sharesToWithdraw)))); //not well generalizable if needed but works for now -also may fail due to rounding error need to find where this happens

      //update profit
      profit = (sharesBefore.sub(sharesToWithdraw)).mul(profit).div(sharesBefore);
      expect(profit,'incorrect profit / performance fees allocation').to.be.equal('0');

    });

    it('counterparty redeems and gets underlying if needed', async () => {
      //counterparty would redeem only if option is ITM to get their profit but checking also on OTM that they get 0 if they would try
      //input needed
      const optionsSold = (await otoken.balanceOf(counterpartyWallet.address)).toString();

      // keep track of underlying before counterparty redeems
      const underlyingOfCounterpartyBefore = await underlying.balanceOf(counterpartyWallet.address);

      // created expected values
      const underlyingOfCounterpartyExpectedAfter = underlyingOfCounterpartyBefore.add(callPayOffActual);

      //counterparty redeems
      const actionArgs = [
        {
          actionType: ActionType.Redeem,
          owner: ZERO_ADDR,
          secondAddress: counterpartyWallet.address,
          asset: otoken.address,
          vaultId: '1',
          amount: optionsSold,
          index: '0',
          data: ZERO_ADDR,
        },
      ]
    
      await controller.connect(counterpartyWallet).operate(actionArgs);
      
      // keep track of underlying after counterparty redeems
      const underlyingOfCounterpartyAfter = await underlying.balanceOf(counterpartyWallet.address); //0 change if OTM, callPayoff if it is ITM

      // check user balance 
      expect(underlyingOfCounterpartyAfter, 'incorrect underlying of counterparty').to.be.eq(underlyingOfCounterpartyExpectedAfter);
    })
  });
});
