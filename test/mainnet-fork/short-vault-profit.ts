import {ethers, network} from 'hardhat';
import {BigNumber, Signer, utils} from 'ethers';
import {SignerWithAddress} from '@nomiclabs/hardhat-ethers/signers';
import {expect} from 'chai';
import {
  OpynPerpVault,
  IERC20,
  ShortOTokenActionWithSwap,
  IOtokenFactory,
  IOToken,
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
  // asset used by this action: in this case, wbtc
  let wbtc: IERC20;
  let usdc: IERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  let wbtcPricer: MockPricer;
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
  const wbtcAddress = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddess = '0x5934807cC0654d46755eBd2848840b616256C6Ef'

  /** Test Scenario Params */
  const p1DepositAmount = BigNumber.from('1000000000')
  const p2DepositAmount = BigNumber.from('7000000000')
  const p3DepositAmount = BigNumber.from('2000000000')
  const premium = BigNumber.from('600000000')

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
    wbtc = (await ethers.getContractAt('IERC20', wbtcAddress)) as IERC20;
    usdc = (await ethers.getContractAt('IERC20', usdcAddress)) as IERC20;
    otokenFactory = (await ethers.getContractAt('IOtokenFactory',otokenFactoryAddress)) as IOtokenFactory;
    oracle = (await ethers.getContractAt('IOracle', oracleAddress)) as IOracle;
  });

  this.beforeAll('Deploy vault and sell calls action', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy(
      wbtc.address,
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
      wbtc.address,
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
      wbtcPricer = (await MockPricerContract.deploy(
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
        .setAssetPricer(wbtc.address, wbtcPricer.address);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
    }
  );

  this.beforeAll('whitelist collateral & product in the Opyn system', async () => {
    const whitelist = (await ethers.getContractAt(
      'IWhitelist',
      otokenWhitelistAddress
    )) as IWhitelist;

    // impersonate owner and change the whitelist
    await owner.sendTransaction({
      to: opynOwner,
      value: utils.parseEther('1.0')
    });
    await provider.send('hardhat_impersonateAccount', [opynOwner]);
    const signer = await ethers.provider.getSigner(opynOwner);
    await whitelist.connect(signer).whitelistCollateral(wbtc.address);
    await whitelist
      .connect(signer)
      .whitelistProduct(
        wbtc.address,
        usdc.address,
        wbtc.address,
        false
      );
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
  });

  this.beforeAll('send everyone underlying', async () => { 
    const whale = '0xF977814e90dA44bFA03b6295A0616a897441aceC'

    // send everyone underlying
    await provider.send('hardhat_impersonateAccount', [whale]);
    const signer = await ethers.provider.getSigner(whale);
    await wbtc.connect(signer).transfer(counterpartyWallet.address, premium);
    await wbtc.connect(signer).transfer(depositor1.address, p1DepositAmount);
    await wbtc.connect(signer).transfer(depositor2.address, p2DepositAmount);
    await wbtc.connect(signer).transfer(depositor3.address, p3DepositAmount);
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
    await wbtc.connect(counterpartyWallet).approve(swapAddress, premium);
  })
  

  describe('check the admin setup', async () => {
    it('contract is initialized correctly', async () => {
      // initial state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalUnderlyingAsset()).isZero(), 'total asset should be zero')
        .to.be.true;
    });

    it('should set fee reserve', async () => {
      // 10% reserve
      await vault.connect(owner).setWithdrawReserve(1000);
      expect((await vault.withdrawReserve()).toNumber() == 1000).to.be.true;
    });
  });

  describe('profitable scenario', async () => {
    let otoken: IOToken;
    let expiry: number;
    const reserveFactor = 10;
    this.beforeAll(
      'deploy otoken that will be sold',
      async () => {
        const otokenStrikePrice = 5000000000000;
        const blockNumber = await provider.getBlockNumber();
        const block = await provider.getBlock(blockNumber);
        const currentTimestamp = block.timestamp;
        expiry = (Math.floor(currentTimestamp / day) + 10) * day + 28800;

        await otokenFactory.createOtoken(
          wbtc.address,
          usdc.address,
          wbtc.address,
          otokenStrikePrice,
          expiry,
          false
        );

        const otokenAddress = await otokenFactory.getOtoken(
          wbtc.address,
          usdc.address,
          wbtc.address,
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
      const UnderlyingBeforeDeposit = await vault.totalUnderlyingAsset(); //await wbtc.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      console.log("UnderlyingBeforeDeposit:",UnderlyingBeforeDeposit.toNumber());
      console.log("sharesBefore:",sharesBefore.toNumber());
      console.log("p1DepositAmount:",p1DepositAmount.toNumber());

      // approve and deposit underlying
      await wbtc.connect(depositor1).approve(vault.address, p1DepositAmount);
      await vault.connect(depositor1).depositUnderlying(p1DepositAmount);

      // check underlying & shares deposited by depositor1
      const vaultTotal = await vault.totalUnderlyingAsset();
      const totalSharesMinted = p1DepositAmount;
      const totalSharesExisting = await vault.totalSupply();
      console.log("vaultTotal:",vaultTotal.toNumber());
      console.log("totalSharesMinted:",totalSharesMinted.toNumber());
      console.log("totalSharesExisting:",totalSharesExisting.toNumber());

      // check the underlying token balances
      expect(vaultTotal).to.be.equal(UnderlyingBeforeDeposit.add(p1DepositAmount), 'internal underlying balance is incorrect');

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrect amount of shares minted').to.be.equal(totalSharesMinted);
      expect(totalSharesExisting, 'incorrect amount of shares existing').to.be.equal(sharesBefore.add(totalSharesMinted));
    });

    it('p2 deposits', async () => {
      // keep track of underlying & shares before deposit
      const UnderlyingBeforeDeposit = await vault.totalUnderlyingAsset(); //await wbtc.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      console.log("UnderlyingBeforeDeposit:",UnderlyingBeforeDeposit.toNumber());
      console.log("sharesBefore:",sharesBefore.toNumber());
      console.log("p2DepositAmount:",p2DepositAmount.toNumber());

      // approve and deposit underlying
      await wbtc.connect(depositor2).approve(vault.address, p2DepositAmount);
      await vault.connect(depositor2).depositUnderlying(p2DepositAmount);

      // check underlying & shares deposited by depositor2
      const vaultTotal = await vault.totalUnderlyingAsset();
      const totalSharesMinted = sharesBefore.mul(p2DepositAmount).div(UnderlyingBeforeDeposit);
      const totalSharesExisting = await vault.totalSupply();
      console.log("vaultTotal:",vaultTotal.toNumber());
      console.log("totalSharesMinted:",totalSharesMinted.toNumber());
      console.log("totalSharesExisting:",totalSharesExisting.toNumber());

      // check the underlying token balances
      expect(vaultTotal).to.be.equal(UnderlyingBeforeDeposit.add(p2DepositAmount), 'internal underlying balance is incorrect');

      // check the minted share balances
      expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted').to.be.equal(totalSharesMinted);
      expect(totalSharesExisting, 'incorrect amount of shares existing').to.be.equal(sharesBefore.add(totalSharesMinted));
    });

    it('owner commits to the option', async () => {
      await wbtcPricer.setPrice('4000000000000');
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
      const underlyingExpectedAfterMintInVault = underlyingBeforeRollOverTotal.mul(reserveFactor).div(100);
      const underlyingExpectedBeforeMintInActionLocked = 0;
      const underlyingExpectedBeforeMintInActionUnlocked = underlyingBeforeRollOverTotal.sub(underlyingExpectedAfterMintInVault);
      const underlyingExpectedBeforeMintInActionTotal = underlyingExpectedBeforeMintInActionUnlocked.add(underlyingExpectedBeforeMintInActionLocked);
      const underlyingExpectedAfterMintInActionLocked = underlyingBeforeRollOverTotal.sub(underlyingExpectedAfterMintInVault);
      const underlyingExpectedAfterMintInActionUnlocked = premium;
      const underlyingExpectedAfterMintInActionTotal = underlyingExpectedAfterMintInActionUnlocked.add(underlyingExpectedAfterMintInActionLocked);
      console.log("premium:",premium.toNumber());
      console.log("underlyingBeforeRollOverTotal:",underlyingBeforeRollOverTotal.toNumber());
      console.log("underlyingExpectedAfterMintTotal:",underlyingExpectedAfterMintTotal.toNumber());
      console.log("underlyingExpectedAfterMintInVault:",underlyingExpectedAfterMintInVault.toNumber());
      console.log("underlyingExpectedBeforeMintInActionLocked:",underlyingExpectedBeforeMintInActionLocked);
      console.log("underlyingExpectedBeforeMintInActionUnlocked:",underlyingExpectedBeforeMintInActionUnlocked.toNumber());
      console.log("underlyingExpectedBeforeMintInActionTotal:",underlyingExpectedBeforeMintInActionTotal.toNumber());
      console.log("underlyingExpectedAfterMintInActionLocked:",underlyingExpectedAfterMintInActionLocked.toNumber());
      console.log("underlyingExpectedAfterMintInActionUnlocked:",underlyingExpectedAfterMintInActionUnlocked.toNumber());
      console.log("underlyingExpectedAfterMintInActionTotal:",underlyingExpectedAfterMintInActionTotal.toNumber());

      // rollover
      await vault.rollOver([(100 - reserveFactor) * 100]);

      // keep track after rollover and before mint
      const collateralAmount = await wbtc.balanceOf(action1.address);
      expect((underlyingBeforeRollOverTotal.sub(underlyingExpectedAfterMintInVault)), 'incorrect accounting in locked asset').to.be.equal(collateralAmount);
      const marginPoolUnderlyingBeforeMint = await wbtc.balanceOf(marginPoolAddess);
      console.log("collateralAmount:",collateralAmount.toNumber());
      console.log("marginPoolUnderlyingBeforeMint:",marginPoolUnderlyingBeforeMint.toNumber());

      // mint and sell oTokens
      const sellAmount = (collateralAmount).toString(); //.div(10000000000)
      console.log("sellAmount:",sellAmount);
      
      const order = await getOrder(
        action1.address,
        otoken.address,
        sellAmount,
        counterpartyWallet.address,
        wbtc.address,
        premium.toString(),
        swapAddress,
        counterpartyWallet.privateKey
      );
      
      expect((await action1.lockedAsset()).eq(underlyingExpectedBeforeMintInActionLocked),'collateral should not be locked').to.be.true;
      expect((await wbtc.balanceOf(action1.address)).eq(underlyingExpectedBeforeMintInActionUnlocked),'collateral should all be unlocked').to.be.true;

      await action1.mintAndSellOToken(collateralAmount, sellAmount, order);

      // keep track after rollover and mint
      const underlyingAfterMintInVault = await wbtc.balanceOf(vault.address);
      const underlyingAfterMintInActionTotal = await action1.currentValue();
      const underlyingAfterMintInActionUnlocked = await wbtc.balanceOf(action1.address);
      const underlyingAfterMintInActionLocked = await action1.lockedAsset();
      const underlyingAfterMintTotal = await vault.totalUnderlyingAsset();
      const marginPoolUnderlyingAfterMint = await wbtc.balanceOf(marginPoolAddess);
      console.log("underlyingAfterMintInVault:",underlyingAfterMintInVault.toNumber());
      console.log("underlyingAfterMintInActionTotal:",underlyingAfterMintInActionTotal.toNumber());
      console.log("underlyingAfterMintInActionLocked:",underlyingAfterMintInActionLocked.toNumber());
      console.log("underlyingAfterMintInActionUnlocked:",underlyingAfterMintInActionUnlocked.toNumber());
      console.log("underlyingAfterMintTotal:",underlyingAfterMintTotal.toNumber());
      console.log("marginPoolUnderlyingAfterMint:",marginPoolUnderlyingAfterMint.toNumber());

      // check underlying balance in action and vault
      expect((underlyingAfterMintInVault), 'incorrect accounting in vault').to.be.equal(underlyingExpectedAfterMintInVault);
      expect((underlyingAfterMintInActionTotal), 'incorrect accounting in action total').to.be.equal(underlyingExpectedAfterMintInActionTotal);
      expect((underlyingAfterMintTotal), 'incorrect accounting in totals').to.be.equal(underlyingExpectedAfterMintTotal);
      expect(underlyingAfterMintInActionLocked, 'incorrect accounting in locked asset').to.be.equal(collateralAmount);
      expect(underlyingAfterMintInActionLocked, 'incorrect accounting in locked asset').to.be.equal(underlyingExpectedAfterMintInActionLocked);
      expect(underlyingAfterMintInActionUnlocked, 'incorrect accounting in locked asset').to.be.equal(underlyingExpectedAfterMintInActionUnlocked);

      // check the otoken balance of counterparty
      expect(await otoken.balanceOf(counterpartyWallet.address), 'incorrect otoken balance sent to counterparty').to.be.equal(sellAmount);

      // check underlying balance in opyn
      expect(marginPoolUnderlyingAfterMint, 'incorrect balance in Opyn').to.be.equal(marginPoolUnderlyingBeforeMint.add(collateralAmount));
    });

    it('p3 deposits', async () => {
      // keep track of underlying & shares before deposit
      const UnderlyingBeforeDeposit = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      console.log("UnderlyingBeforeDeposit:",UnderlyingBeforeDeposit.toNumber());
      console.log("sharesBefore:",sharesBefore.toNumber());
      console.log("p3DepositAmount:",p3DepositAmount.toNumber());
      // approve and deposit underlying
      await wbtc.connect(depositor3).approve(vault.address, p3DepositAmount);
      await vault.connect(depositor3).depositUnderlying(p3DepositAmount);

      // check underlying & shares deposited by depositor3
      const vaultTotal = await vault.totalUnderlyingAsset();
      const totalSharesMinted = sharesBefore.mul(p3DepositAmount).div(UnderlyingBeforeDeposit);
      const totalSharesExisting = await vault.totalSupply();
      console.log("vaultTotal:",vaultTotal.toNumber());
      console.log("totalSharesMinted:",totalSharesMinted.toNumber());
      console.log("totalSharesExisting:",totalSharesExisting.toNumber());

      // check the underlying token balances
      expect(vaultTotal).to.be.equal(UnderlyingBeforeDeposit.add(p3DepositAmount), 'internal underlying balance is incorrect');

      // check the minted share balances
      expect((await vault.balanceOf(depositor3.address)), 'incorrect amount of shares minted').to.be.equal(totalSharesMinted);
      expect(totalSharesExisting, 'incorrect amount of shares existing').to.be.equal(sharesBefore.add(totalSharesMinted));
    });

    it('p1 withdraws', async () => {
      // keep track of underlying & shares before withdrawal
      const underlyingBeforeWithdrawal = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);
      console.log("UnderlyingBeforeWithdrawal:",underlyingBeforeWithdrawal.toNumber());
      console.log("sharesBefore:",sharesBefore.toNumber());
      console.log("sharesToWithdraw:",sharesToWithdraw.toNumber());

      // balance calculations
      const amountWithdrawn = sharesToWithdraw.mul(underlyingBeforeWithdrawal).div(sharesBefore)
      const fee = amountWithdrawn.mul(5).div(1000);
      const amountToUser = amountWithdrawn.sub(fee);
      console.log("amountWithdrawn:",amountWithdrawn.toNumber());
      console.log("fee:",fee.toNumber());
      console.log("amountToUser:",amountToUser.toNumber());

      // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositorBefore = await wbtc.balanceOf(depositor1.address);
      const underlyingOfFeeRecipientBefore = await wbtc.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorBefore:",underlyingOfDepositorBefore.toNumber());
      console.log("underlyingOfFeeRecipientBefore:",underlyingOfFeeRecipientBefore.toNumber());

      await vault
        .connect(depositor1)
        .withdrawUnderlying(sharesToWithdraw);

      // keep track of underlying & shares after withdrawal
      const underlyingAfterWithdrawal = await vault.totalUnderlyingAsset();
      const sharesAfter = await vault.totalSupply();
      console.log("underlyingAfterWithdrawal:",underlyingAfterWithdrawal.toNumber());
      console.log("sharesAfter:",sharesAfter.toNumber());

      // keep track of underlying of other parties after withdrawal
      const underlyingOfDepositorAfter = await wbtc.balanceOf(depositor1.address);
      const underlyingOfFeeRecipientAfter = await wbtc.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorAfter:",underlyingOfDepositorAfter.toNumber());
      console.log("underlyingOfFeeRecipientAfter:",underlyingOfFeeRecipientAfter.toNumber());

      // created expected values
      const underlyingExpectedAfterWithdrawal = underlyingBeforeWithdrawal.sub(amountWithdrawn);
      const sharesExpectedAfter = sharesBefore.sub(sharesToWithdraw);
      const underlyingOfDepositorExpectedAfter = underlyingOfDepositorBefore.add(amountToUser);
      const underlyingOfFeeRecipientExpectedAfter = underlyingOfFeeRecipientBefore.add(fee);

      // check shares
      expect(sharesAfter, 'incorrect amount of shares withdrawn').to.be.equal(sharesExpectedAfter);

      // check vault balance 
      expect(underlyingAfterWithdrawal, 'incorrect underlying remained in the vault').to.be.eq(underlyingExpectedAfterWithdrawal);

      // check user balance 
      expect(underlyingOfDepositorAfter, 'incorrect underlying given to depositor').to.be.eq(underlyingOfDepositorExpectedAfter);

      // check fee 
      expect(underlyingOfFeeRecipientAfter, 'incorrect fee paid out to fee recipient').to.be.eq(underlyingOfFeeRecipientExpectedAfter);
    });

    it('option expires', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
      await provider.send('evm_mine', []);

      // set settlement price
      await wbtcPricer.setExpiryPriceInOracle(wbtc.address, expiry, '3000000000000');

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      // keep track before closing positions
      const underlyingBeforeCloseInActionTotal = await action1.currentValue();
      const underlyingBeforeCloseInVaultTotal = await wbtc.balanceOf(vault.address);
      console.log("underlyingBeforeCloseInActionTotal:",underlyingBeforeCloseInActionTotal.toNumber());
      console.log("underlyingBeforeCloseInVaultTotal:",underlyingBeforeCloseInVaultTotal.toNumber());
      // close positions
      await vault.closePositions();

      // keep track after closing positions
      const underlyingAfterCloseInActionTotal = await action1.currentValue();
      const underlyingAfterCloseInVaultTotal = await wbtc.balanceOf(vault.address);
      const vaultTotal = await vault.totalUnderlyingAsset();
      console.log("underlyingAfterCloseInActionTotal:",underlyingAfterCloseInActionTotal.toNumber());
      console.log("underlyingAfterCloseInVaultTotal:",underlyingAfterCloseInVaultTotal.toNumber());

      // check vault balances
      expect(vaultTotal, 'incorrect accounting in vault').to.be.equal(underlyingAfterCloseInVaultTotal);
      expect(underlyingAfterCloseInVaultTotal, 'incorrect balances in vault').to.be.equal(underlyingBeforeCloseInVaultTotal.add(underlyingBeforeCloseInActionTotal));

      // check action balances
      expect((await action1.lockedAsset()).eq('0'),'no underlying should be locked').to.be.true;
      expect((await wbtc.balanceOf(action1.address)), 'no underlying should be left in action').to.be.equal('0');
      expect(underlyingAfterCloseInActionTotal, 'no underlying should be controlled by action').to.be.equal('0');
    });

    it('p2 withdraws', async () => {
      // keep track of underlying & shares before withdrawal
      const underlyingBeforeWithdrawal = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);
      console.log("UnderlyingBeforeWithdrawal:",underlyingBeforeWithdrawal.toNumber());
      console.log("sharesBefore:",sharesBefore.toNumber());
      console.log("sharesToWithdraw:",sharesToWithdraw.toNumber());

      // balance calculations
      const amountWithdrawn = sharesToWithdraw.mul(underlyingBeforeWithdrawal).div(sharesBefore)
      const fee = amountWithdrawn.mul(5).div(1000);
      const amountToUser = amountWithdrawn.sub(fee);
      console.log("amountWithdrawn:",amountWithdrawn.toNumber());
      console.log("fee:",fee.toNumber());
      console.log("amountToUser:",amountToUser.toNumber());

      // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositorBefore = await wbtc.balanceOf(depositor2.address);
      const underlyingOfFeeRecipientBefore = await wbtc.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorBefore:",underlyingOfDepositorBefore.toNumber());
      console.log("underlyingOfFeeRecipientBefore:",underlyingOfFeeRecipientBefore.toNumber());

      await vault
        .connect(depositor2)
        .withdrawUnderlying(sharesToWithdraw);

      // keep track of underlying & shares after withdrawal
      const underlyingAfterWithdrawal = await vault.totalUnderlyingAsset();
      const sharesAfter = await vault.totalSupply();
      console.log("underlyingAfterWithdrawal:",underlyingAfterWithdrawal.toNumber());
      console.log("sharesAfter:",sharesAfter.toNumber());

      // keep track of underlying of other parties after withdrawal
      const underlyingOfDepositorAfter = await wbtc.balanceOf(depositor2.address);
      const underlyingOfFeeRecipientAfter = await wbtc.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorAfter:",underlyingOfDepositorAfter.toNumber());
      console.log("underlyingOfFeeRecipientAfter:",underlyingOfFeeRecipientAfter.toNumber());

      // created expected values
      const underlyingExpectedAfterWithdrawal = underlyingBeforeWithdrawal.sub(amountWithdrawn);
      const sharesExpectedAfter = sharesBefore.sub(sharesToWithdraw);
      const underlyingOfDepositorExpectedAfter = underlyingOfDepositorBefore.add(amountToUser);
      const underlyingOfFeeRecipientExpectedAfter = underlyingOfFeeRecipientBefore.add(fee);

      // check shares
      expect(sharesAfter, 'incorrect amount of shares withdrawn').to.be.equal(sharesExpectedAfter);

      // check vault balance 
      expect(underlyingAfterWithdrawal, 'incorrect underlying remained in the vault').to.be.eq(underlyingExpectedAfterWithdrawal);

      // check user balance 
      expect(underlyingOfDepositorAfter, 'incorrect underlying given to depositor').to.be.eq(underlyingOfDepositorExpectedAfter);

      // check fee 
      expect(underlyingOfFeeRecipientAfter, 'incorrect fee paid out to fee recipient').to.be.eq(underlyingOfFeeRecipientExpectedAfter);
    });

    it('p3 withdraws', async () => {
      // keep track of underlying & shares before withdrawal
      const underlyingBeforeWithdrawal = await vault.totalUnderlyingAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor3.address);
      console.log("UnderlyingBeforeWithdrawal:",underlyingBeforeWithdrawal.toNumber());
      console.log("sharesBefore:",sharesBefore.toNumber());
      console.log("sharesToWithdraw:",sharesToWithdraw.toNumber());

      // balance calculations
      const amountWithdrawn = sharesToWithdraw.mul(underlyingBeforeWithdrawal).div(sharesBefore)
      const fee = amountWithdrawn.mul(5).div(1000);
      const amountToUser = amountWithdrawn.sub(fee);
      console.log("amountWithdrawn:",amountWithdrawn.toNumber());
      console.log("fee:",fee.toNumber());
      console.log("amountToUser:",amountToUser.toNumber());

      // keep track of underlying of other parties before withdrawal
      const underlyingOfDepositorBefore = await wbtc.balanceOf(depositor3.address);
      const underlyingOfFeeRecipientBefore = await wbtc.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorBefore:",underlyingOfDepositorBefore.toNumber());
      console.log("underlyingOfFeeRecipientBefore:",underlyingOfFeeRecipientBefore.toNumber());

      await vault
        .connect(depositor3)
        .withdrawUnderlying(sharesToWithdraw);

      // keep track of underlying & shares after withdrawal
      const underlyingAfterWithdrawal = await vault.totalUnderlyingAsset();
      const sharesAfter = await vault.totalSupply();
      console.log("underlyingAfterWithdrawal:",underlyingAfterWithdrawal.toNumber());
      console.log("sharesAfter:",sharesAfter.toNumber());

      // keep track of underlying of other parties after withdrawal
      const underlyingOfDepositorAfter = await wbtc.balanceOf(depositor3.address);
      const underlyingOfFeeRecipientAfter = await wbtc.balanceOf(feeRecipient.address);
      console.log("underlyingOfDepositorAfter:",underlyingOfDepositorAfter.toNumber());
      console.log("underlyingOfFeeRecipientAfter:",underlyingOfFeeRecipientAfter.toNumber());

      // created expected values
      const underlyingExpectedAfterWithdrawal = underlyingBeforeWithdrawal.sub(amountWithdrawn);
      const sharesExpectedAfter = sharesBefore.sub(sharesToWithdraw);
      const underlyingOfDepositorExpectedAfter = underlyingOfDepositorBefore.add(amountToUser);
      const underlyingOfFeeRecipientExpectedAfter = underlyingOfFeeRecipientBefore.add(fee);

      // check shares
      expect(sharesAfter, 'incorrect amount of shares withdrawn').to.be.equal(sharesExpectedAfter);

      // check vault balance 
      expect(underlyingAfterWithdrawal, 'incorrect underlying remained in the vault').to.be.eq(underlyingExpectedAfterWithdrawal);

      // check user balance 
      expect(underlyingOfDepositorAfter, 'incorrect underlying given to depositor').to.be.eq(underlyingOfDepositorExpectedAfter);

      // check fee 
      expect(underlyingOfFeeRecipientAfter, 'incorrect fee paid out to fee recipient').to.be.eq(underlyingOfFeeRecipientExpectedAfter);
    });
  });
});
