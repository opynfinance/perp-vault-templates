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
  StakedaoEcrvPricer,
  IOracle,
  IWhitelist,
  MockPricer,
  IStakeDao,
  ICurve
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
  let crvRenWsbtc: IERC20;
  let sdcrvRenWsbtc: IERC20;

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
  let stakedaoSdcrvRenWsbtcStrategy: IStakeDao;
  let curvePool: ICurve;
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
  const sdcrvRenWsbtcAddress = '0x24129B935AfF071c4f0554882C0D9573F4975fEd';
  const curvePoolAddress = '0x7fC77b5c7614E1533320Ea6DDc2Eb61fa00A9714';
  const crvRenWsbtcAddress = '0x075b1bb99792c9E1041bA13afEf80C91a1e70fB3';
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddess = '0x5934807cC0654d46755eBd2848840b616256C6Ef'

  /** Test Scenario Params */
  const p1DepositAmount = BigNumber.from('1000000000')
  const p2DepositAmount = BigNumber.from('7000000000')
  const p3DepositAmount = BigNumber.from('2000000000')
  const premium = BigNumber.from('800000000')

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
    crvRenWsbtc = (await ethers.getContractAt('IERC20', crvRenWsbtcAddress)) as IERC20;
    sdcrvRenWsbtc = (await ethers.getContractAt(
      'IERC20',
      sdcrvRenWsbtcAddress
    )) as IERC20;
    otokenFactory = (await ethers.getContractAt(
      'IOtokenFactory',
      otokenFactoryAddress
    )) as IOtokenFactory;
    oracle = (await ethers.getContractAt('IOracle', oracleAddress)) as IOracle;
    stakedaoSdcrvRenWsbtcStrategy = (await ethers.getContractAt('IStakeDao', sdcrvRenWsbtcAddress)) as IStakeDao;
    curvePool = (await ethers.getContractAt('ICurve', curvePoolAddress)) as ICurve;
  });

  this.beforeAll('Deploy vault and sell wBTC calls action', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy(
      wbtc.address,
      sdcrvRenWsbtcAddress,
      curvePoolAddress,
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
      sdcrvRenWsbtcAddress,
      swapAddress,
      whitelistAddress,
      controllerAddress,
      curvePoolAddress,
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
        sdcrvRenWsbtc.address,
        wbtc.address,
        oracleAddress,
        curvePoolAddress
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
        .setAssetPricer(sdcrvRenWsbtc.address, sbtcPricer.address);
      await oracle
        .connect(signer)
        .setAssetPricer(wbtc.address, wbtcPricer.address);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
    }
  );

  this.beforeAll('whitelist sdcrvRenWsbtc in the Opyn system', async () => {
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
    await whitelist.connect(signer).whitelistCollateral(sdcrvRenWsbtcAddress);
    await whitelist
      .connect(signer)
      .whitelistProduct(
        wbtc.address,
        usdc.address,
        sdcrvRenWsbtcAddress,
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

  describe('profitable scenario', async () => {
    let actualAmountInVault;
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
          sdcrvRenWsbtc.address,
          otokenStrikePrice,
          expiry,
          false
        );

        const otokenAddress = await otokenFactory.getOtoken(
          wbtc.address,
          usdc.address,
          sdcrvRenWsbtc.address,
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
      // calculating the ideal amount of sdCrvRenWsbtc that should be deposited
      const crvRenWsbtcTowbtc = await curvePool.get_virtual_price();
      const amountCrvRenWsbtcDeposited = p1DepositAmount.mul(utils.parseEther('1.0')).div(crvRenWsbtcTowbtc);
      const sdCrvRenWsbtcToCrvRenWsbtc = await stakedaoSdcrvRenWsbtcStrategy.getPricePerFullShare();
      const amountSdCrvRenWsbtcDeposited = amountCrvRenWsbtcDeposited.mul(utils.parseEther('1.0')).div(sdCrvRenWsbtcToCrvRenWsbtc);

      // multiplying by 10^10 to scale a 10^8 number to a 10^18 number
      const upperBoundOfSdCrvRenWsbtcDeposited = amountSdCrvRenWsbtcDeposited.mul(10000000000)
      // 1% slippage from the ideal is acceptable at most
      const lowerBoundOfSdCrvRenWsbtcDeposited = amountSdCrvRenWsbtcDeposited.mul(99).div(100).mul(10000000000);


      await wbtc.connect(depositor1).approve(vault.address, p1DepositAmount);
      await vault.connect(depositor1).depositUnderlying(p1DepositAmount, lowerBoundOfSdCrvRenWsbtcDeposited);


      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdcrvRenWsbtcBalance = await sdcrvRenWsbtc.balanceOf(vault.address);
      const totalSharesMinted = vaultSdcrvRenWsbtcBalance;


      // check the sdcrvRenWsbtc token balances
      expect(vaultTotal, 'internal accounting is incorrect').to.be.within(lowerBoundOfSdCrvRenWsbtcDeposited as any, upperBoundOfSdCrvRenWsbtcDeposited as any);
      expect(vaultSdcrvRenWsbtcBalance).to.be.equal(
        vaultTotal, 'internal balance is incorrect'
      );

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
    });

    it('p2 deposits', async () => {
      // Calculate lower and upper bounds
      // calculating the ideal amount of sdCrvRenWsbtc that should be deposited
      const crvRenWsbtcTowbtc = await curvePool.get_virtual_price();
      const amountCrvRenWsbtcDeposited = p2DepositAmount.mul(utils.parseEther('1.0')).div(crvRenWsbtcTowbtc);
      const sdCrvRenWsbtcToCrvRenWsbtc = await stakedaoSdcrvRenWsbtcStrategy.getPricePerFullShare();
      const amountSdCrvRenWsbtcDeposited = amountCrvRenWsbtcDeposited.mul(utils.parseEther('1.0')).div(sdCrvRenWsbtcToCrvRenWsbtc);
      // multiplying by 10^10 to scale a 10^8 number to a 10^18 number
      const upperBoundOfSdCrvRenWsbtcDeposited = amountSdCrvRenWsbtcDeposited.mul(10000000000)
      // 1% slippage from the ideal is acceptable at most
      const lowerBoundOfSdCrvRenWsbtcDeposited = amountSdCrvRenWsbtcDeposited.mul(99).div(100).mul(10000000000);


      // keep track of shares before
      const sharesBefore = await vault.totalSupply();
      const vaultSdcrvRenWsbtcBalanceBefore = await sdcrvRenWsbtc.balanceOf(vault.address);

      // Approve and deposit underlying
      await wbtc.connect(depositor2).approve(vault.address, p2DepositAmount);
      await vault.connect(depositor2).depositUnderlying(p2DepositAmount, lowerBoundOfSdCrvRenWsbtcDeposited);

      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdcrvRenWsbtcBalanceAfter = await sdcrvRenWsbtc.balanceOf(vault.address);
      const sdcrvRenWsbtcDeposited = vaultSdcrvRenWsbtcBalanceAfter.sub(vaultSdcrvRenWsbtcBalanceBefore);

      // check the sdcrvRenWsbtc token balances
      // there is no accurate way of estimating this, so just approximating for now
      expect(sdcrvRenWsbtcDeposited, 'internal accounting is incorrect').to.be.within(lowerBoundOfSdCrvRenWsbtcDeposited as any, upperBoundOfSdCrvRenWsbtcDeposited as any);
      expect(vaultTotal).to.be.equal(
        vaultSdcrvRenWsbtcBalanceAfter, 'internal balance is incorrect'
      );

      // check the minted share balances
      const shares = sharesBefore.div(vaultSdcrvRenWsbtcBalanceBefore).mul(sdcrvRenWsbtcDeposited)
      expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted' ).to.be.equal(shares)
    });

    it('tests getPrice in sbtcPricer', async () => {
      await wbtcPricer.setPrice('4000000000000');
      const wbtcPrice = await oracle.getPrice(wbtc.address);
      const sdcrvRenWsbtcPrice = await oracle.getPrice(sdcrvRenWsbtc.address);
      expect(wbtcPrice.toNumber()).to.be.lessThanOrEqual(
        sdcrvRenWsbtcPrice.toNumber()
      );
    });

    it('owner commits to the option', async () => {
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitOToken(otoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });

    it('owner mints options with sdcrvRenWsbtc as collateral and sells them', async () => {
      // increase time
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      const vaultSdcrvRenWsbtcBalanceBefore = await sdcrvRenWsbtc.balanceOf(vault.address);

      await vault.rollOver([(100 - reserveFactor) * 100]);


      // const vaultSdcrvRenWsbtcBalanceBefore = await sdcrvRenWsbtc.balanceOf(vault.address);
      const expectedSdcrvRenWsbtcBalanceInVault = vaultSdcrvRenWsbtcBalanceBefore.mul(reserveFactor).div(100)
      let expectedSdcrvRenWsbtcBalanceInAction = vaultSdcrvRenWsbtcBalanceBefore.sub(expectedSdcrvRenWsbtcBalanceInVault)
      const collateralAmount = await sdcrvRenWsbtc.balanceOf(action1.address)
      const premiumInSdcrvRenWsbtc = premium.mul(95).div(100);
      const expectedTotal = vaultSdcrvRenWsbtcBalanceBefore.add(premiumInSdcrvRenWsbtc);
      expectedSdcrvRenWsbtcBalanceInAction = expectedSdcrvRenWsbtcBalanceInVault.add(premiumInSdcrvRenWsbtc);
      const sellAmount = (collateralAmount.div(10000000000)).toString(); 
      const marginPoolSdcrvRenWsbtcBalanceAfter = await sdcrvRenWsbtc.balanceOf(marginPoolAddess);

      const marginPoolBalanceOfsdcrvRenWsbtcBefore = await sdcrvRenWsbtc.balanceOf(marginPoolAddess);

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

      const vaultSdcrvRenWsbtcBalanceAfter = await sdcrvRenWsbtc.balanceOf(vault.address);

      // check sdcrvRenWsbtc balance in action and vault
      expect(vaultSdcrvRenWsbtcBalanceAfter).to.be.within(
        expectedSdcrvRenWsbtcBalanceInVault.sub(1) as any, expectedSdcrvRenWsbtcBalanceInVault.add(1) as any, "incorrect balance in vault"
      );
      expect(
        (await vault.totalStakedaoAsset()).gte(expectedTotal),
        'incorrect accounting in vault'
      ).to.be.true;
      expect(((await sdcrvRenWsbtc.balanceOf(action1.address)).gte(expectedSdcrvRenWsbtcBalanceInAction), 'incorrect sdcrvRenWSBTC balance in action'))
      expect((await action1.lockedAsset()), 'incorrect accounting in action').to.be.equal(collateralAmount)
      expect(await wbtc.balanceOf(action1.address)).to.be.equal('0');


      // check the otoken balance of counterparty
      expect(await otoken.balanceOf(counterpartyWallet.address), 'incorrect otoken balance sent to counterparty').to.be.equal(
        sellAmount
      );

      const marginPoolBalanceOfsdcrvRenWsbtcAfter = await sdcrvRenWsbtc.balanceOf(marginPoolAddess);

      // check sdcrvRenWSBTC balance in opyn 
      expect(marginPoolBalanceOfsdcrvRenWsbtcAfter, 'incorrect balance in Opyn').to.be.equal(marginPoolBalanceOfsdcrvRenWsbtcBefore.add(collateralAmount));
    });

    it('p3 deposits', async () => {
      const effectiveP3deposit = p3DepositAmount.mul(95).div(100)
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const expectedTotal = vaultTotalBefore.add(effectiveP3deposit);
      const sharesBefore = await vault.totalSupply();
      const actualAmountInVaultBefore = await sdcrvRenWsbtc.balanceOf(vault.address);

      await wbtc.connect(depositor3).approve(vault.address, p3DepositAmount);
      await vault.connect(depositor3).depositUnderlying(p3DepositAmount, '0');

      const vaultTotalAfter = await vault.totalStakedaoAsset();
      const sdcrvRenWsbtcDeposited = vaultTotalAfter.sub(vaultTotalBefore);
      actualAmountInVault = await sdcrvRenWsbtc.balanceOf(vault.address);
      // check the sdcrvRenWsbtc token balances
      // there is no accurate way of estimating this, so just approximating for now
      expect(
        (await vault.totalStakedaoAsset()).gte(expectedTotal),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(actualAmountInVault).to.be.equal(
        actualAmountInVaultBefore.add(sdcrvRenWsbtcDeposited), 'internal accounting should match actual balance'
      );

      // check the minted share balances
      const shares = sdcrvRenWsbtcDeposited.mul(sharesBefore).div(vaultTotalBefore)
      expect((await vault.balanceOf(depositor3.address))).to.be.equal(shares)
    });

    it('p1 withdraws', async () => {
      // vault balance calculations
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultSdECRVBalanceBefore = await sdcrvRenWsbtc.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);

      // p1 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p1DepositAmount.add(shareOfPremium);
      const fee = sharesToWithdraw.mul(vaultTotalBefore).div(sharesBefore).mul(5).div(1000);
      const amountTransferredToP1 = amountToWithdraw.mul(95).div(100);
      const balanceOfP1Before = await wbtc.balanceOf(depositor1.address);

      // fee calculations 
      const balanceOfFeeRecipientBefore = await sdcrvRenWsbtc.balanceOf(feeRecipient.address);


      await vault
        .connect(depositor1)
        .withdrawUnderlying(sharesToWithdraw, amountTransferredToP1);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const sdcrvRenWsbtcWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultSdECRVBalanceAfter = await sdcrvRenWsbtc.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await sdcrvRenWsbtc.balanceOf(feeRecipient.address);
      const balanceOfP1After = await wbtc.balanceOf(depositor1.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalSdcrvRenWsbtc = await vault.totalStakedaoAsset();
      // check vault balance 
      expect(
        vaultTotalSdcrvRenWsbtc).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
        'total asset should update'
      );
      expect(vaultSdECRVBalanceAfter).to.be.within(
        vaultSdECRVBalanceBefore.sub(sdcrvRenWsbtcWithdrawn).sub(1) as any,
        vaultSdECRVBalanceBefore.sub(sdcrvRenWsbtcWithdrawn).add(1) as any,
      );

      // check p1 balance 
      expect(balanceOfP1After.gte((balanceOfP1Before.add(amountTransferredToP1))), 'incorrect wBTC transferred to p1').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))
    });

    it('option expires', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
      await provider.send('evm_mine', []);

      // set settlement price
      await wbtcPricer.setExpiryPriceInOracle(wbtc.address, expiry, '3000000000000');
      await sbtcPricer.setExpiryPriceInOracle(expiry);

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      const sbtcControlledByActionBefore = await action1.currentValue();
      const sbtcBalanceInVaultBefore = await sdcrvRenWsbtc.balanceOf(vault.address);

      await vault.closePositions();

      const sbtcBalanceInVaultAfter = await sdcrvRenWsbtc.balanceOf(vault.address);
      const sbtcBalanceInActionAfter = await sdcrvRenWsbtc.balanceOf(action1.address);
      const sbtcControlledByActionAfter = await action1.currentValue();
      const vaultTotal = await vault.totalStakedaoAsset();

      // check vault balances
      expect(vaultTotal, 'incorrect accounting in vault').to.be.equal(sbtcBalanceInVaultAfter);
      expect(sbtcBalanceInVaultAfter, 'incorrect balances in vault').to.be.equal(sbtcBalanceInVaultBefore.add(sbtcControlledByActionBefore));

      // check action balances
      expect(
        (await action1.lockedAsset()).eq('0'),
        'all collateral should be unlocked'
      ).to.be.true;
      expect(sbtcBalanceInActionAfter, 'no sdcrvRenWSBTC should be left in action').to.be.equal('0');
      expect(sbtcControlledByActionAfter, 'no sdcrvRenWSBTC should be controlled by action').to.be.equal('0');
    });

    it('p2 withdraws', async () => {
      // vault balance calculations
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultSdECRVBalanceBefore = await sdcrvRenWsbtc.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);

      // p2 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p2DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p2DepositAmount.add(shareOfPremium);
      const fee = sharesToWithdraw.mul(vaultTotalBefore).div(sharesBefore).mul(5).div(1000);
      const amountTransferredToP2 = amountToWithdraw.mul(95).div(100);
      const balanceOfP2Before = await wbtc.balanceOf(depositor2.address);

      // fee calculations 
      const balanceOfFeeRecipientBefore = await sdcrvRenWsbtc.balanceOf(feeRecipient.address);


      await vault
        .connect(depositor2)
        .withdrawUnderlying(sharesToWithdraw, amountTransferredToP2);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const sdcrvRenWsbtcWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultSdECRVBalanceAfter = await sdcrvRenWsbtc.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await sdcrvRenWsbtc.balanceOf(feeRecipient.address)
      const balanceOfP2After = await wbtc.balanceOf(depositor2.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalSdcrvRenWsbtc = await vault.totalStakedaoAsset();

      // check vault balance 
      expect(
        vaultTotalSdcrvRenWsbtc).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
        'total asset should update'
      );
      expect(vaultSdECRVBalanceAfter).to.be.within(
        vaultSdECRVBalanceBefore.sub(sdcrvRenWsbtcWithdrawn).sub(1) as any,
        vaultSdECRVBalanceBefore.sub(sdcrvRenWsbtcWithdrawn).add(1) as any,
      );

      // check p2 balance 
      expect(balanceOfP2After.gte((balanceOfP2Before.add(amountTransferredToP2))), 'incorrect underlying transferred to p2').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))
    });

    it('p3 withdraws', async () => {
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor3.address);

      // balance calculations 
      const amountToWithdraw = p3DepositAmount;
      const fee = sharesToWithdraw.mul(vaultTotalBefore).div(sharesBefore).mul(5).div(1000);
      const amountTransferredToP3 = amountToWithdraw.mul(95).div(100);
      const balanceOfP3Before = await wbtc.balanceOf(depositor3.address);

      // fee calculations
      const balanceOfFeeRecipientBefore = await sdcrvRenWsbtc.balanceOf(feeRecipient.address);

      await vault
        .connect(depositor3)
        .withdrawUnderlying(await vault.balanceOf(depositor3.address), amountTransferredToP3);

      const balanceOfFeeRecipientAfter = await sdcrvRenWsbtc.balanceOf(feeRecipient.address);
      const balanceOfP3After = await wbtc.balanceOf(depositor3.address);

      expect(
        (await vault.totalStakedaoAsset()).eq('0'),
        'total in vault should be empty'
      ).to.be.true;
      expect(await sdcrvRenWsbtc.balanceOf(vault.address), 'total in vault should be empty').to.be.equal(
        '0'
      );

      // check fee 
      expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))

      // check p3 balance 
      expect(balanceOfP3After.gte((balanceOfP3Before.add(amountTransferredToP3))), 'incorrect underlying transferred to p3').to.be.true;
    });
  });
});
