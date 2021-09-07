import {ethers, network} from 'hardhat';
import {BigNumber, Signer, utils} from 'ethers';
import {SignerWithAddress} from '@nomiclabs/hardhat-ethers/signers';
import {expect} from 'chai';
import {
  OpynPerpVault,
  IERC20,
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
  // asset used by this action: in this case, wbtc
  let wbtc: IERC20;
  let usdc: IERC20;
  let crvRenWSBTC: IERC20;
  let sdcrvRenWSBTC: IERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  let sbtcPricer: StakedaoEcrvPricer;
  let wbtcPricer: MockPricer;
  let oracle: IOracle;
  let controller: IController;
  let provider: typeof ethers.provider;

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
  const wbtcAddress = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
  const stakeDaoTokenAddress = '0x24129B935AfF071c4f0554882C0D9573F4975fEd';
  const curveAddress = '0x7fC77b5c7614E1533320Ea6DDc2Eb61fa00A9714';
  const sbtcCrvAddress = '0x075b1bb99792c9E1041bA13afEf80C91a1e70fB3';
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddess = '0x5934807cC0654d46755eBd2848840b616256C6Ef'

  /** Test Scenario Params */
  const p1DepositAmount = BigNumber.from('1000000000')
  const p2DepositAmount = BigNumber.from('7000000000')
  const p3DepositAmount = BigNumber.from('2000000000')
  const premium = BigNumber.from('200000000')

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
    crvRenWSBTC = (await ethers.getContractAt('IERC20', sbtcCrvAddress)) as IERC20;
    sdcrvRenWSBTC = (await ethers.getContractAt(
      'IERC20',
      stakeDaoTokenAddress
    )) as IERC20;
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

  this.beforeAll('Deploy vault and sell wBTC calls action', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy(
      wbtc.address,
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
      wbtc.address,
      20 // 0.2%
    )) as ShortOTokenActionWithSwap;

    await vault.connect(owner).setActions(
      [action1.address]
    );
  });

  this.beforeAll(
    "Deploy sbtcPricer, wbtcPricer and update sbtcPricer in opyn's oracle",
    async () => {
      provider = ethers.provider;

      const PricerContract = await ethers.getContractFactory(
        'StakedaoEcrvPricer'
      );
      sbtcPricer = (await PricerContract.deploy(
        sdcrvRenWSBTC.address,
        wbtc.address,
        oracleAddress,
        curveAddress
      )) as StakedaoEcrvPricer;
      const MockPricerContract = await ethers.getContractFactory('MockPricer');
      wbtcPricer = (await MockPricerContract.deploy(
        oracleAddress
      )) as MockPricer;

      // impersonate owner and change the sbtcPricer
      await owner.sendTransaction({
        to: opynOwner,
        value: utils.parseEther('2.0')
      });
      await provider.send('hardhat_impersonateAccount', [opynOwner]);
      const signer = await ethers.provider.getSigner(opynOwner);
      await oracle
        .connect(signer)
        .setAssetPricer(sdcrvRenWSBTC.address, sbtcPricer.address);
      await oracle
        .connect(signer)
        .setAssetPricer(wbtc.address, wbtcPricer.address);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
    }
  );

  this.beforeAll('whitelist sdcrvRenWSBTC in the Opyn system', async () => {
    const whitelist = (await ethers.getContractAt(
      'IWhitelist',
      otokenWhitelistAddress
    )) as IWhitelist;

    // impersonate owner and change the sbtcPricer
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
        wbtc.address,
        usdc.address,
        stakeDaoTokenAddress,
        false
      );
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
  });

  this.beforeAll('send everyone wbtc', async () => { 
    const wbtcWhale = '0xF977814e90dA44bFA03b6295A0616a897441aceC'

    // send everyone wbtc
    await provider.send('hardhat_impersonateAccount', [wbtcWhale]);
    const signer = await ethers.provider.getSigner(wbtcWhale);
    await wbtc.connect(signer).transfer(counterpartyWallet.address, premium);
    await wbtc.connect(signer).transfer(depositor1.address, p1DepositAmount);
    await wbtc.connect(signer).transfer(depositor2.address, p2DepositAmount);
    await wbtc.connect(signer).transfer(depositor3.address, p3DepositAmount);
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [wbtcWhale]);
  })

  this.beforeAll('prepare counterparty wallet', async () => { 
    // prepare counterparty
    counterpartyWallet = counterpartyWallet.connect(provider);
    await owner.sendTransaction({
      to: counterpartyWallet.address,
      value: utils.parseEther('3000')
    });

    // approve wbtc to be spent by counterparty 
    await wbtc.connect(counterpartyWallet).approve(swapAddress, premium);
  })
  

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

  describe('not-profitable scenario', async () => {
    let actualAmountInVault;
    let otoken: IOToken;
    let expiry: number;
    let optionsSold: BigNumber;
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
          sdcrvRenWSBTC.address,
          otokenStrikePrice,
          expiry,
          false
        );

        const otokenAddress = await otokenFactory.getOtoken(
          wbtc.address,
          usdc.address,
          sdcrvRenWSBTC.address,
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
      // there is no accurate way of estimating this, so just approximating for now
      const expectedSdcrvRenWSBTCInVault = p1DepositAmount.mul(95).div(100);

      await wbtc.connect(depositor1).approve(vault.address, p1DepositAmount);
      await vault.connect(depositor1).depositUnderlying(p1DepositAmount, '0');

      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdcrvRenWSBTCBalance = await sdcrvRenWSBTC.balanceOf(vault.address);
      const totalSharesMinted = vaultSdcrvRenWSBTCBalance;

      // check the sdcrvRenWSBTC token balances
      expect(
        (vaultTotal).gte(expectedSdcrvRenWSBTCInVault),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(vaultSdcrvRenWSBTCBalance).to.be.equal(
        vaultTotal, 'internal balance is incorrect'
      );

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
    });

    it('p2 deposits', async () => {
      // there is no accurate way of estimating this, so just approximating for now
      const expectedSdcrvRenWSBTCInVault = p1DepositAmount.mul(95).div(100);
      const sharesBefore = await vault.totalSupply();
      const vaultSdcrvRenWSBTCBalanceBefore = await sdcrvRenWSBTC.balanceOf(vault.address);

      await wbtc.connect(depositor2).approve(vault.address, p2DepositAmount);
      await vault.connect(depositor2).depositUnderlying(p2DepositAmount, '0');

      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdcrvRenWSBTCBalance = await sdcrvRenWSBTC.balanceOf(vault.address);
      // check the sdcrvRenWSBTC token balances
      // there is no accurate way of estimating this, so just approximating for now
      expect(
        (vaultTotal).gte(expectedSdcrvRenWSBTCInVault),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(vaultTotal).to.be.equal(
        vaultSdcrvRenWSBTCBalance, 'internal balance is incorrect'
      );

      // check the minted share balances
      const stakedaoDeposited = vaultSdcrvRenWSBTCBalance.sub(vaultSdcrvRenWSBTCBalanceBefore);
      const shares = sharesBefore.div(vaultSdcrvRenWSBTCBalanceBefore).mul(stakedaoDeposited)
      expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted' ).to.be.equal(shares)
    });

    it('tests getPrice in sbtcPricer', async () => {
      await wbtcPricer.setPrice('4000000000000');
      const wbtcPrice = await oracle.getPrice(wbtc.address);
      const sdcrvRenWSBTCPrice = await oracle.getPrice(sdcrvRenWSBTC.address);
      expect(wbtcPrice.toNumber()).to.be.lessThanOrEqual(
        sdcrvRenWSBTCPrice.toNumber()
      );
    });

    it('owner commits to the option', async () => {
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitOToken(otoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });

    it('owner mints options with sdcrvRenWSBTC as collateral and sells them', async () => {
      // increase time
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      const vaultSdcrvRenWSBTCBalanceBefore = await sdcrvRenWSBTC.balanceOf(vault.address);

      await vault.rollOver([(100 - reserveFactor) * 100]);


      // const vaultSdcrvRenWSBTCBalanceBefore = await sdcrvRenWSBTC.balanceOf(vault.address);
      const expectedSdcrvRenWSBTCBalanceInVault = vaultSdcrvRenWSBTCBalanceBefore.mul(reserveFactor).div(100)
      let expectedSdcrvRenWSBTCBalanceInAction = vaultSdcrvRenWSBTCBalanceBefore.sub(expectedSdcrvRenWSBTCBalanceInVault)
      const collateralAmount = await sdcrvRenWSBTC.balanceOf(action1.address)
      const premiumInSdcrvRenWSBTC = premium.mul(95).div(100);
      const expectedTotal = vaultSdcrvRenWSBTCBalanceBefore.add(premiumInSdcrvRenWSBTC);
      expectedSdcrvRenWSBTCBalanceInAction = expectedSdcrvRenWSBTCBalanceInVault.add(premiumInSdcrvRenWSBTC);
      const sellAmount = (collateralAmount.div(10000000000)).toString(); 
      optionsSold =  collateralAmount.div(10000000000);

      const marginPoolBalanceOfStakeDaoLPBefore = await sdcrvRenWSBTC.balanceOf(marginPoolAddess);

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

      expect(
        (await action1.lockedAsset()).eq('0'),
        'collateral should not be locked'
      ).to.be.true;

      await action1.mintAndSellOToken(collateralAmount, sellAmount, order);

      const vaultSdcrvRenWSBTCBalanceAfter = await sdcrvRenWSBTC.balanceOf(vault.address);

      // check sdcrvRenWSBTC balance in action and vault
      expect(vaultSdcrvRenWSBTCBalanceAfter).to.be.within(
        expectedSdcrvRenWSBTCBalanceInVault.sub(1) as any, expectedSdcrvRenWSBTCBalanceInVault.add(1) as any, "incorrect balance in vault"
      );
      expect(
        (await vault.totalStakedaoAsset()).gte(expectedTotal),
        'incorrect accounting in vault'
      ).to.be.true;
      expect(((await sdcrvRenWSBTC.balanceOf(action1.address)).gte(expectedSdcrvRenWSBTCBalanceInAction), 'incorrect sbtc balance in action'))
      expect((await action1.lockedAsset()), 'incorrect accounting in action').to.be.equal(collateralAmount)
      expect(await wbtc.balanceOf(action1.address)).to.be.equal('0');


      // check the otoken balance of counterparty
      expect(await otoken.balanceOf(counterpartyWallet.address), 'incorrect otoken balance sent to counterparty').to.be.equal(
        sellAmount
      );

      const marginPoolBalanceOfStakeDaoLPAfter = await sdcrvRenWSBTC.balanceOf(marginPoolAddess);

      // check sbtc balance in opyn 
      expect(marginPoolBalanceOfStakeDaoLPAfter, 'incorrect balance in Opyn').to.be.equal(marginPoolBalanceOfStakeDaoLPBefore.add(collateralAmount));
    });

    it('p3 deposits', async () => {
      const effectiveP3deposit = p3DepositAmount.mul(95).div(100)
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const expectedTotal = vaultTotalBefore.add(effectiveP3deposit);
      const sharesBefore = await vault.totalSupply();
      const actualAmountInVaultBefore = await sdcrvRenWSBTC.balanceOf(vault.address);

      await wbtc.connect(depositor3).approve(vault.address, p3DepositAmount);
      await vault.connect(depositor3).depositUnderlying(p3DepositAmount, '0');

      const vaultTotalAfter = await vault.totalStakedaoAsset();
      const stakedaoDeposited = vaultTotalAfter.sub(vaultTotalBefore);
      actualAmountInVault = await sdcrvRenWSBTC.balanceOf(vault.address);
      // check the sdcrvRenWSBTC token balances
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
      const vaultSdBtcBalanceBefore = await sdcrvRenWSBTC.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);

      // p1 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p1DepositAmount.add(shareOfPremium);
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP1 = amountToWithdraw.sub(fee).mul(95).div(100);
      const balanceOfP1Before = await wbtc.balanceOf(depositor1.address);

      // fee calculations 
      const effectiveFee = fee.mul(95).div(100);
      const balanceOfFeeRecipientBefore = await wbtc.balanceOf(depositor1.address);


      await vault
        .connect(depositor1)
        .withdrawUnderlying(sharesToWithdraw, amountTransferredToP1);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const sdcrvRenWSBTCWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultSdBtcBalanceAfter = await sdcrvRenWSBTC.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await wbtc.balanceOf(depositor1.address);
      const balanceOfP1After = await wbtc.balanceOf(depositor1.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalStakedaoAssets = await vault.totalStakedaoAsset();
      // check vault balance 
      expect(
        vaultTotalStakedaoAssets).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
        'total asset should update'
      );
      expect(vaultSdBtcBalanceAfter).to.be.within(
        vaultSdBtcBalanceBefore.sub(sdcrvRenWSBTCWithdrawn).sub(1) as any,
        vaultSdBtcBalanceBefore.sub(sdcrvRenWSBTCWithdrawn).add(1) as any,
      );

      // check p1 balance 
      expect(balanceOfP1After.gte((balanceOfP1Before.add(amountTransferredToP1))), 'incorrect wBTC transferred to p1').to.be.true;

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
      await wbtcPricer.setExpiryPriceInOracle(wbtc.address, expiry, '10000000000000');
      await sbtcPricer.setExpiryPriceInOracle(expiry);

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      const sbtcControlledByActionBefore = await action1.currentValue();
      const sdsbtcPrice = await oracle.getExpiryPrice(sdcrvRenWSBTC.address, expiry);
      const sdcrvRenWSBTCToBTCPrice = sdsbtcPrice[0]
      // getExpiryPrice is scaled to 1e8, options sold is scaled to 1e8, trying to scale to 1e18
      const collateralAmountDeducted = optionsSold.mul('1000000000000000000').mul('100000').div(sdcrvRenWSBTCToBTCPrice).div(2)
      const collateralAmountReturned = sbtcControlledByActionBefore.sub(collateralAmountDeducted).sub(1);
      const sbtcBalanceInVaultBefore = await sdcrvRenWSBTC.balanceOf(vault.address);

      await vault.closePositions();

      const sbtcBalanceInVaultAfter = await sdcrvRenWSBTC.balanceOf(vault.address);
      const sbtcBalanceInActionAfter = await sdcrvRenWSBTC.balanceOf(action1.address);
      const sbtcControlledByActionAfter = await action1.currentValue();
      const vaultTotal = await vault.totalStakedaoAsset();

      // check vault balances
      expect(vaultTotal, 'incorrect accounting in vault').to.be.equal(sbtcBalanceInVaultAfter);
      expect(sbtcBalanceInVaultAfter, 'incorrect balances in vault').to.be.equal(sbtcBalanceInVaultBefore.add(collateralAmountReturned));

      // check action balances
      expect(
        (await action1.lockedAsset()).eq('0'),
        'all collateral should be unlocked'
      ).to.be.true;
      expect(sbtcBalanceInActionAfter, 'no sbtc should be left in action').to.be.equal('0');
      expect(sbtcControlledByActionAfter, 'no sbtc should be controlled by action').to.be.equal('0');
    });

    it('p2 withdraws', async () => {
      // vault balance calculations
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultSdBtcBalanceBefore = await sdcrvRenWSBTC.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);

      // p2 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p2DepositAmount.mul(premium).div(denominator);
      // p2 deposited 70, since btc price doubled, they should get about half back. 
      const amountToWithdraw = p2DepositAmount.mul(35).div(90).add(shareOfPremium);
      const fee = amountToWithdraw.mul(5).div(1000);
      // Slippage 5% 
      const amountTransferredToP2 = amountToWithdraw.sub(fee).mul(95).div(100);
      const balanceOfP2Before = await wbtc.balanceOf(depositor2.address);

      // fee calculations 
      // Slippage 5%
      const effectiveFee = fee.mul(95).div(100);
      const balanceOfFeeRecipientBefore = await wbtc.balanceOf(feeRecipient.address);

      await vault
        .connect(depositor2)
        .withdrawUnderlying(sharesToWithdraw, amountTransferredToP2);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const sdcrvRenWSBTCWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultSdBtcBalanceAfter = await sdcrvRenWSBTC.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await wbtc.balanceOf(feeRecipient.address)
      const balanceOfP2After = await wbtc.balanceOf(depositor2.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalStakedaoAssets = await vault.totalStakedaoAsset();

      // check vault balance 
      expect(
        vaultTotalStakedaoAssets).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
        'total asset should update'
      );
      expect(vaultSdBtcBalanceAfter).to.be.within(
        vaultSdBtcBalanceBefore.sub(sdcrvRenWSBTCWithdrawn).sub(1) as any,
        vaultSdBtcBalanceBefore.sub(sdcrvRenWSBTCWithdrawn).add(1) as any,
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
      // p2 deposited 20, since btc price doubled, they should get about half back. 
      const amountToWithdraw = p3DepositAmount.mul(10).div(90);
      const fee = amountToWithdraw.mul(5).div(1000);
      // Slippage 5%
      const amountTransferredToP3 = amountToWithdraw.sub(fee).mul(95).div(100);
      const balanceOfP3Before = await wbtc.balanceOf(depositor3.address);

      // fee calculations
      const balanceOfFeeRecipientBefore = await wbtc.balanceOf(feeRecipient.address);
    // Slippage 95%
      const effectiveFee = fee.mul(95).div(100)

      await vault
        .connect(depositor3)
        .withdrawUnderlying(await vault.balanceOf(depositor3.address), amountTransferredToP3);

      const balanceOfFeeRecipientAfter = await wbtc.balanceOf(feeRecipient.address);
      const balanceOfP3After = await wbtc.balanceOf(depositor3.address);

      expect(
        (await vault.totalStakedaoAsset()).eq('0'),
        'total in vault should be empty'
      ).to.be.true;
      expect(await sdcrvRenWSBTC.balanceOf(vault.address), 'total in vault should be empty').to.be.equal(
        '0'
      );

      // check fee 
      expect(balanceOfFeeRecipientAfter.gte(
        balanceOfFeeRecipientBefore.add(effectiveFee)
      ), 'incorrect fee paid out').to.be.true;

      // check p3 balance 
      expect(balanceOfP3After.gte((balanceOfP3Before.add(amountTransferredToP3))), 'incorrect ETH transferred to p3').to.be.true;
    });

    it('counterparty redeems and gets sdecrv', async () => { 

        const sdecrvPrice = await oracle.getExpiryPrice(sdcrvRenWSBTC.address, expiry);
        const sdecrvToETHPrice = sdecrvPrice[0]
        // options sold * 5000/ 10000 * 1/sdecrvConv = payout, scaling this up to 1e18. 
        const payout = optionsSold.mul('1000000000000000000').mul('10000').div(sdecrvToETHPrice).div(2)
        const payoutExpected = payout.mul(9999).div(10000);

        const sdecrvBalanceBefore = await sdcrvRenWSBTC.balanceOf(counterpartyWallet.address);
        
        const actionArgs = [
            {
              actionType: ActionType.Redeem,
              owner: ZERO_ADDR,
              secondAddress: counterpartyWallet.address,
              asset: otoken.address,
              vaultId: '0',
              amount: optionsSold,
              index: '0',
              data: ZERO_ADDR,
            },
          ]

          await controller.connect(counterpartyWallet).operate(actionArgs);

          const sdecrvBalanceAfter = await sdcrvRenWSBTC.balanceOf(counterpartyWallet.address);

          // TODO: off by a small amount, need to figure out how best to round. 
          expect(sdecrvBalanceBefore.add(payoutExpected).lte(sdecrvBalanceAfter)).to.be.true;
          expect(sdecrvBalanceBefore.add(payout).gte(sdecrvBalanceAfter)).to.be.true;
    })
  });
});