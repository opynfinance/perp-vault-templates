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
  IOracle,
  IWhitelist,
  MockPricer,
  IController
} from '../../typechain';
import * as fs from 'fs';
import { BigNumber } from '@ethersproject/bignumber';
// import {getOrder} from '../utils/orders';

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
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
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
    await whitelist.connect(signer).whitelistCollateral(wethAddress);
    await whitelist
      .connect(signer)
      .whitelistProduct(
        weth.address,
        usdc.address,
        wethAddress,
        false
      );
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
  });


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

  describe('loss scenario', async () => {
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
        const higherStrikeOtokenStrikePrice = 2000000000000;
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
        await weth.connect(counterpartyWallet).deposit({ value: premium });
        await weth.connect(counterpartyWallet).approve(action1.address, premium);
      }
    );

    it('p1 deposits', async () => {
      // there is no accurate way of estimating this, so just approximating for now
      const expectedwethInVault = p1DepositAmount.mul(95).div(100);

      await vault.connect(depositor1).depositETH({value: p1DepositAmount});

      const vaultTotal = await vault.totalAsset();
      const vaultwethBalance = await weth.balanceOf(vault.address);
      const totalSharesMinted = vaultwethBalance;

      // check the weth token balances
      expect(
        (vaultTotal).gte(expectedwethInVault),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(vaultwethBalance).to.be.equal(
        vaultTotal, 'internal balance is incorrect'
      );

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
        
    });

    it('p2 deposits', async () => {
      // there is no accurate way of estimating this, so just approximating for now
      const expectedwethInVault = p1DepositAmount.mul(95).div(100);
      const sharesBefore = await vault.totalSupply();
      const vaultwethBalanceBefore = await weth.balanceOf(vault.address);

      await vault.connect(depositor2).depositETH({value: p2DepositAmount});

      const vaultTotal = await vault.totalAsset();
      const vaultwethBalance = await weth.balanceOf(vault.address);
      // check the weth token balances
      // there is no accurate way of estimating this, so just approximating for now
      expect(
        (vaultTotal).gte(expectedwethInVault),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(vaultTotal).to.be.equal(
        vaultwethBalance, 'internal balance is incorrect'
      );

      // check the minted share balances
      const wethDeposited = vaultwethBalance.sub(vaultwethBalanceBefore);
      const shares = sharesBefore.div(vaultwethBalanceBefore).mul(wethDeposited)
      expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted' ).to.be.equal(shares)

    });

    it('tests getPrice in wethPricer', async () => {
      await wethPricer.setPrice('2000');
      const wethPrice = await oracle.getPrice(weth.address);
      expect(wethPrice.toNumber()).to.be.lessThanOrEqual(
        wethPrice.toNumber()
      );
    });

    it('owner commits to the option', async () => {
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitSpread(lowerStrikeOtoken.address, higherStrikeOtoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });

    it('owner mints call credit spread with weth as margin collateral and sells them', async () => {
    
      // increase time
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      const vaultwethBalanceBefore = await weth.balanceOf(vault.address);

      await vault.rollOver([(100 - reserveFactor) * 100]);

      const expectedwethBalanceInVault = vaultwethBalanceBefore.mul(reserveFactor).div(100)
      let expectedwethBalanceInAction = vaultwethBalanceBefore.sub(expectedwethBalanceInVault)
      
      const collateralAmount = await weth.balanceOf(action1.address)

      const premiumInweth = premium.mul(95).div(100);
      // estimating fee for flash loan and wrapping ~10%
      const netPremiumInweth = premium.mul(90).div(100)
      const expectedTotal = vaultwethBalanceBefore.add(netPremiumInweth);
      expectedwethBalanceInAction = expectedwethBalanceInVault.add(premiumInweth);
      // const sellAmount = (collateralAmount.div(10000000000)).toString(); 
      
      const longStrikePrice = await higherStrikeOtoken.strikePrice();
      const shortStrikePrice = await lowerStrikeOtoken.strikePrice();
      
      // // ((((longStrike).sub(shortStrike)).mul(1e10)).div(longStrike))
      const collateralRequiredPerOption = (longStrikePrice.sub(shortStrikePrice).mul(1e10).div(longStrikePrice));

      const wethAmount = collateralAmount;
      // const sellAmount = (collateralAmount.add(collateralAmount)).div(1e10).toString(); 

      sellAmount = (wethAmount).div(collateralRequiredPerOption);

      const requiredCollateral = ((((longStrikePrice).sub(shortStrikePrice)).mul(1e10)).div(longStrikePrice)).mul(sellAmount);

      const marginPoolwethBalanceAfter = await weth.balanceOf(marginPoolAddress);

      const marginPoolBalanceOfwethBefore = await weth.balanceOf(marginPoolAddress);

      expect(
        (await action1.lockedAsset()).eq('0'),
        'collateral should not be locked'
      ).to.be.true;

      await controller.connect(counterpartyWallet).setOperator(action1.address, true);

      await action1.flashMintAndSellOToken(sellAmount.toString(), premium, counterpartyWallet.address);

      const vaultwethBalanceAfter = await weth.balanceOf(vault.address);

      // check weth balance in action and vault
      expect(vaultwethBalanceAfter).to.be.within(
        expectedwethBalanceInVault.sub(1) as any, expectedwethBalanceInVault.add(1) as any, "incorrect balance in vault"
      );
      
      expect(
        (await vault.totalAsset() ).gte(expectedTotal),
        'incorrect accounting in vault'
      ).to.be.true;
      
      expect(((await weth.balanceOf(action1.address)).gte(expectedwethBalanceInAction), 'incorrect weth balance in action'))
      
      expect((await action1.lockedAsset()), 'incorrect accounting in action').to.be.equal(requiredCollateral)

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

      const marginPoolBalanceOfwethAfter = await weth.balanceOf(marginPoolAddress);

      // // check weth balance in opyn 
      expect(marginPoolBalanceOfwethAfter, 'incorrect balance in Opyn').to.be.lte(
        marginPoolBalanceOfwethBefore.add(collateralAmount)
      );
    });

    it('p3 deposits', async () => {

      const effectiveP3deposit = p3DepositAmount.mul(95).div(100)
      const vaultTotalBefore = await vault.totalAsset();
      
      const expectedTotal = vaultTotalBefore.add(effectiveP3deposit);
      const sharesBefore = await vault.totalSupply();
      const actualAmountInVaultBefore = await weth.balanceOf(vault.address);

      await vault.connect(depositor3).depositETH({value: p3DepositAmount});

      const vaultTotalAfter = await vault.totalAsset();

      const wethDeposited = vaultTotalAfter.sub(vaultTotalBefore);
      actualAmountInVault = await weth.balanceOf(vault.address);
      // check the weth token balances
      // there is no accurate way of estimating this, so just approximating for now
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

      const vaultwethBalanceBefore = await weth.balanceOf(vault.address);

      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);

      // p1 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);

      // premium estimanti  fees for flash loan ~10%
      const netPremium = premium.mul(90).div(100)

      // const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
      const shareOfPremium = p1DepositAmount.mul(netPremium).div(denominator);
      const amountToWithdraw = p1DepositAmount.add(shareOfPremium);

      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP1 = amountToWithdraw.sub(fee).mul(95).div(100);

      const balanceOfP1Before = await provider.getBalance(depositor1.address);
      // fee calculations 
      const effectiveFee = fee.mul(95).div(100);
      const balanceOfFeeRecipientBefore = await provider.getBalance(feeRecipient.address);

      await vault
        .connect(depositor1)
        .withdrawETH(sharesToWithdraw);
        // .withdrawETH(sharesToWithdraw, '0' );

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const wethWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultwethBalanceAfter = await weth.balanceOf(vault.address);

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
      expect(vaultwethBalanceAfter).to.be.within(
        vaultwethBalanceBefore.sub(wethWithdrawn).sub(1) as any,
        vaultwethBalanceBefore.sub(wethWithdrawn).add(1) as any,
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
 
      const expPrice = 10000 * 1e8;

      const settlePrice = BigNumber.from(expPrice)

      // set settlement price
      await wethPricer.setExpiryPriceInOracle(weth.address, expiry, settlePrice);

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      const wethControlledByActionBefore = await action1.currentValue();
      const wethPrice = await oracle.getExpiryPrice(weth.address, expiry);
      const wethToETHPrice = wethPrice[0]
      // getExpiryPrice is scaled to 1e8, options sold is scaled to 1e8, trying to scale to 1e18

      const longStrikePrice = await higherStrikeOtoken.strikePrice();
      const shortStrikePrice = await lowerStrikeOtoken.strikePrice();


      const collateralAmountDeducted =  sellAmount.mul(settlePrice)
                                        .mul(1e10)
                                        .div(wethToETHPrice)
                                        .mul( shortStrikePrice )
                                        .div( settlePrice )


      const collateralAmountReturned = wethControlledByActionBefore.sub(collateralAmountDeducted).sub(1);
      const wethBalanceInVaultBefore = await weth.balanceOf(vault.address);

      await vault.closePositions();

      const wethBalanceInVaultAfter = await weth.balanceOf(vault.address);
      const wethBalanceInActionAfter = await weth.balanceOf(action1.address);
      const wethControlledByActionAfter = await action1.currentValue();
      const vaultTotal = await vault.totalAsset();

      // check vault balances
      expect(vaultTotal, 'incorrect accounting in vault').to.be.equal(wethBalanceInVaultAfter);
      // expect(wethBalanceInVaultAfter, 'incorrect balances in vault').to.be.equal(wethBalanceInVaultBefore.add(collateralAmountReturned));

      expect(wethBalanceInVaultAfter.sub(wethBalanceInVaultBefore.add(collateralAmountReturned))).to.be.within(
        0 as any, 1 as any, "incorrect balances in vault"
      );

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
      const vaultwethBalanceBefore = await weth.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);

      // p2 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p2DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p2DepositAmount.mul(35).div(90).add(shareOfPremium);
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP2 = amountToWithdraw.sub(fee).mul(95).div(100);
      const balanceOfP2Before = await provider.getBalance(depositor2.address);

      // fee calculations 
      const effectiveFee = fee.mul(95).div(100);
      const balanceOfFeeRecipientBefore = await provider.getBalance(feeRecipient.address);


      await vault
        .connect(depositor2)
        .withdrawETH(sharesToWithdraw);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const wethWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultwethBalanceAfter = await weth.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await provider.getBalance(feeRecipient.address)
      const balanceOfP2After = await provider.getBalance(depositor2.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      // check vault balance 
      expect(
        (await vault.totalAsset()).eq(expectedVaultTotalAfter.add(1)),
        'total asset should update'
      ).to.be.true;
      expect(vaultwethBalanceAfter).to.be.equal(
        vaultwethBalanceBefore.sub(wethWithdrawn).add(1)
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
      const amountToWithdraw = p3DepositAmount.mul(35).div(90);
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP3 = amountToWithdraw.div(2).sub(fee).mul(95).div(100);
      const balanceOfP3Before = await provider.getBalance(depositor3.address);

      // fee calculations
      const balanceOfFeeRecipientBefore = await provider.getBalance(feeRecipient.address);
      const effectiveFee = fee.mul(95).div(100)

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
        balanceOfFeeRecipientBefore.add(effectiveFee)
      ), 'incorrect fee paid out').to.be.true;

      // check p3 balance 
      expect(balanceOfP3After.gte((balanceOfP3Before.add(amountTransferredToP3))), 'incorrect ETH transferred to p3').to.be.true;
    });

    it('counterparty settle and gets weth', async () => { 

        const wethPrice = await oracle.getExpiryPrice(weth.address, expiry);
        const wethToETHPrice = wethPrice[0]
        // options sold * 5000/ 10000 * 1/wethConv = payout, scaling this up to 1e18. 
        // const payout = sellAmount.mul('1000000000000000000').mul('10000').div(wethToETHPrice).div(2)


        const longStrikePrice = await higherStrikeOtoken.strikePrice();
        const shortStrikePrice = await lowerStrikeOtoken.strikePrice();

        const payout =  sellAmount.mul(wethToETHPrice)
                                        .mul(1e10)
                                        .div(wethToETHPrice)
                                        .mul( shortStrikePrice )
                                        .div( wethToETHPrice )

        const payoutExpected = payout.mul(9999).div(10000);

        const wethBalanceBefore = await weth.balanceOf(counterpartyWallet.address);
        
        const mmVault =  await controller.getVault(counterpartyWallet.address, 1);

        const actionArgs = [
            {
              actionType: ActionType.SettleVault,
              owner: counterpartyWallet.address,
              secondAddress: counterpartyWallet.address,
              asset: lowerStrikeOtoken.address,
              vaultId: '1',
              amount: sellAmount,
              index: '0',
              data: ZERO_ADDR,
            },
          ]

          await controller.connect(counterpartyWallet).operate(actionArgs);

          const wethBalanceAfter = await weth.balanceOf(counterpartyWallet.address);

          // TODO: off by a small amount, need to figure out how best to round. 
          expect(wethBalanceBefore.add(payoutExpected).lte(wethBalanceAfter)).to.be.true;
          expect(wethBalanceBefore.add(payout).gte(wethBalanceAfter)).to.be.true;
    })
  });
});
