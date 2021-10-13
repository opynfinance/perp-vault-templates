import { ethers, network } from 'hardhat';
import { BigNumber, Signer, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect, util } from 'chai';
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
  IStakeDao,
  ICurve
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

describe('Mainnet Fork Tests', function () {
  let counterpartyWallet = ethers.Wallet.fromMnemonic(
    mnemonic,
    "m/44'/60'/0'/0/30"
  );
  let action1: ShortOTokenActionWithSwap;
  // asset used by this action: in this case, frax
  let frax: IERC20;
  let weth: IERC20;
  let sdFrax3Crv: IERC20;
  let usdc: IERC20; 
  let usdt: IERC20;
  let frax3crv: ICurve;


  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  let sdFrax3CrvPricer: StakedaoPricer;
  let wethPricer: MockPricer;
  let oracle: IOracle;
  let stakedaoSdfrax3crvStrategy: IStakeDao;
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
  const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const fraxAddress = '0x853d955aCEf822Db058eb8505911ED77F175b99e';
  const sdFrax3CrvAddress = '0x5af15DA84A4a6EDf2d9FA6720De921E1026E37b7';
  const curvePoolAddress = '0xA79828DF1850E8a3A3064576f380D90aECDD3359';
  const frax3crvAddress = '0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B';
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddess = '0x5934807cC0654d46755eBd2848840b616256C6Ef';
  const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const usdtAddress = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

  /** Test Scenario Params */
  const p1DepositAmount = utils.parseEther('1000');
  const p2DepositAmount = utils.parseEther('7000');
  const p3DepositAmount = utils.parseEther('2000');
  const premium = utils.parseEther('400');

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
    frax = (await ethers.getContractAt('IERC20', fraxAddress)) as IERC20;
    weth = (await ethers.getContractAt('IERC20', wethAddress)) as IERC20;
    usdc = (await ethers.getContractAt('IERC20', usdcAddress)) as IERC20;
    usdt = (await ethers.getContractAt('IERC20', usdtAddress)) as IERC20;
    frax3crv = (await ethers.getContractAt('ICurve', frax3crvAddress)) as ICurve;
    sdFrax3Crv = (await ethers.getContractAt(
      'IERC20',
      sdFrax3CrvAddress
    )) as IERC20;
    otokenFactory = (await ethers.getContractAt(
      'IOtokenFactory',
      otokenFactoryAddress
    )) as IOtokenFactory;
    oracle = (await ethers.getContractAt('IOracle', oracleAddress)) as IOracle;
    stakedaoSdfrax3crvStrategy = (await ethers.getContractAt('IStakeDao', sdFrax3CrvAddress)) as IStakeDao;
    curvePool = (await ethers.getContractAt('ICurve', curvePoolAddress)) as ICurve;
  });

  this.beforeAll('Deploy vault and sell eth calls action', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy(
      frax.address,
      sdFrax3CrvAddress,
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
      sdFrax3CrvAddress,
      swapAddress,
      whitelistAddress,
      controllerAddress,
      curvePoolAddress,
      0, // type 0 vault
      frax.address,
      20 // 0.2%
    )) as ShortOTokenActionWithSwap;

    await vault.connect(owner).setActions(
      [action1.address]
    );
  });

  this.beforeAll(
    "Deploy sdFrax3CrvPricer, mock weth pricer, set frax to stable price and update wethpricer and sdFrax3CrvPricer in opyn's oracle",
    async () => {
      provider = ethers.provider;

      const PricerContract = await ethers.getContractFactory(
        'StakedaoPricer'
      );
      sdFrax3CrvPricer = (await PricerContract.deploy(
        sdFrax3Crv.address,
        frax.address,
        oracleAddress,
        frax3crv.address
      )) as StakedaoPricer;

      const MockPricerContract = await ethers.getContractFactory('MockPricer');
      wethPricer = (await MockPricerContract.deploy(
        oracleAddress
      )) as MockPricer;

      // impersonate owner and change the sdFrax3CrvPricer
      await owner.sendTransaction({
        to: opynOwner,
        value: utils.parseEther('2.0')
      });
      await provider.send('hardhat_impersonateAccount', [opynOwner]);
      const signer = await ethers.provider.getSigner(opynOwner);
      await oracle
        .connect(signer)
        .setStablePrice(frax.address, '100000000');
      await oracle
        .connect(signer)
        .setAssetPricer(weth.address, wethPricer.address);
      await oracle
        .connect(signer)
        .setAssetPricer(sdFrax3Crv.address, sdFrax3CrvPricer.address);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
    }
  );

  this.beforeAll('whitelist sdFrax3Crv in the Opyn system', async () => {
    const whitelist = (await ethers.getContractAt(
      'IWhitelist',
      otokenWhitelistAddress
    )) as IWhitelist;

    // impersonate owner and change the sdFrax3CrvPricer
    await owner.sendTransaction({
      to: opynOwner,
      value: utils.parseEther('1.0')
    });
    await provider.send('hardhat_impersonateAccount', [opynOwner]);
    const signer = await ethers.provider.getSigner(opynOwner);
    await whitelist.connect(signer).whitelistCollateral(sdFrax3CrvAddress);
    await whitelist
      .connect(signer)
      .whitelistProduct(
        weth.address,
        frax.address,
        sdFrax3CrvAddress,
        true
      );
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
  });

      this.beforeAll('send counterparty frax', async () => {
      const fraxWhale = '0x7AfaFe3C06F4D4864fE37E981bf73279B5f44218'
  
      // send everyone frax
      await provider.send('hardhat_impersonateAccount', [fraxWhale]);
      const signer = await ethers.provider.getSigner(fraxWhale);
      await frax.connect(signer).transfer(counterpartyWallet.address, premium);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [fraxWhale]);
    })


  this.beforeAll('send everyone frax3crv', async() => { 
    const frax3crvWhale = '0x2550761D44e709710C15B718B2B73A65151a8488'
    // send everyone frax
    await provider.send('hardhat_impersonateAccount', [frax3crvWhale]);
    const signer = await ethers.provider.getSigner(frax3crvWhale);
    await frax3crv.connect(signer).transfer(depositor1.address, p1DepositAmount);
    await frax3crv.connect(signer).transfer(depositor2.address, p2DepositAmount);
    await frax3crv.connect(signer).transfer(depositor3.address, p3DepositAmount);
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [frax3crvWhale]);
  })

  this.beforeAll('prepare counterparty wallet', async () => {
    // prepare counterparty
    counterpartyWallet = counterpartyWallet.connect(provider);
    await owner.sendTransaction({
      to: counterpartyWallet.address,
      value: utils.parseEther('1')
    });

    // approve frax to be spent by counterparty 
    await frax.connect(counterpartyWallet).approve(swapAddress, premium);
    // await frax3crv.connect(counterpartyWallet).approve(swapAddress, premium);
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
    let otoken: IOToken;
    let expiry: number;
    const reserveFactor = 10;
    const otokenStrikePrice = 100000000000; // $1000
    this.beforeAll(
      'deploy otoken that will be sold',
      async () => {
        const blockNumber = await provider.getBlockNumber();
        const block = await provider.getBlock(blockNumber);
        const currentTimestamp = block.timestamp;
        expiry = (Math.floor(currentTimestamp / day) + 10) * day + 28800;

        await otokenFactory.createOtoken(
          weth.address,
          frax.address,
          sdFrax3Crv.address,
          otokenStrikePrice,
          expiry,
          true
        );

        const otokenAddress = await otokenFactory.getOtoken(
          weth.address,
          frax.address,
          sdFrax3Crv.address,
          otokenStrikePrice,
          expiry,
          true
        );

        otoken = (await ethers.getContractAt(
          'IOToken',
          otokenAddress
        )) as IOToken;
      }
    );    

    it('p1 deposits FRAX3CRV', async () => {
      // calculating the ideal amount of sdCrvRenWsdFrax3Crv that should be deposited
      const amountfrax3crvDeposited = p1DepositAmount

      // multiplying by 10^10 to scale a 10^8 number to a 10^18 number
      const sdfrax3crvSupplyBefore = await stakedaoSdfrax3crvStrategy.totalSupply();
      const frax3crvBalanceInStakedao = await stakedaoSdfrax3crvStrategy.balance();
      const sdFrax3crvDeposited = amountfrax3crvDeposited.mul(sdfrax3crvSupplyBefore).div(frax3crvBalanceInStakedao);

      // approve and deposit 
      await frax3crv.connect(depositor1).approve(vault.address, amountfrax3crvDeposited);
      await vault.connect(depositor1).depositCrvLP(amountfrax3crvDeposited);


      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdfrax3crvBalance = await sdFrax3Crv.balanceOf(vault.address);
      const totalSharesMinted = vaultSdfrax3crvBalance;

      // check the sdFrax3Crv token balances
      expect(vaultTotal, 'internal accounting is incorrect').to.be.eq(sdFrax3crvDeposited);
      expect(vaultSdfrax3crvBalance).to.be.equal(
        vaultTotal, 'internal balance is incorrect'
      );

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
    });

    it('p2 deposits FRAX3CRV', async () => {
      // calculating the ideal amount of sdCrvRenWsdFrax3Crv that should be deposited
      const amountfrax3crvDeposited = p2DepositAmount

      // multiplying by 10^10 to scale a 10^8 number to a 10^18 number
      const sdfrax3crvSupplyBefore = await stakedaoSdfrax3crvStrategy.totalSupply();
      const frax3crvBalanceInStakedao = await stakedaoSdfrax3crvStrategy.balance();
      const sdFrax3crvDeposited = amountfrax3crvDeposited.mul(sdfrax3crvSupplyBefore).div(frax3crvBalanceInStakedao);

      // keep track of balance before
      const vaultTotalBefore = await vault.totalStakedaoAsset();

      // approve and deposit 
      await frax3crv.connect(depositor2).approve(vault.address, amountfrax3crvDeposited);
      await vault.connect(depositor2).depositCrvLP(amountfrax3crvDeposited);


      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdfrax3crvBalance = await sdFrax3Crv.balanceOf(vault.address);
      const totalSharesMinted = vaultTotal.sub(vaultTotalBefore);

      // check the sdFrax3Crv token balances
      expect(vaultTotal.sub(vaultTotalBefore), 'internal accounting is incorrect').to.be.eq(sdFrax3crvDeposited);
      expect(vaultSdfrax3crvBalance).to.be.equal(
        vaultTotal, 'internal balance is incorrect'
      );

      // check the minted share balances
      expect((await vault.balanceOf(depositor2.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
    });

    it('tests getPrice in sdFrax3CrvPricer', async () => {
      await wethPricer.setPrice('400000000000'); // $4000
      const fraxPrice = await oracle.getPrice(frax.address);
      const sdFrax3CrvPrice = await oracle.getPrice(sdFrax3Crv.address);
      expect(fraxPrice.toNumber()).to.be.lessThanOrEqual(
        sdFrax3CrvPrice.toNumber()
      );
    });

    it('owner commits to the option', async () => {
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitOToken(otoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });

    it('owner mints options with sdFrax3Crv as collateral and sells them', async () => {
      // increase time
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      const vaultSdfrax3crvBalanceBefore = await sdFrax3Crv.balanceOf(vault.address);

      await vault.rollOver([(100 - reserveFactor) * 100]);

      const expectedSdfrax3crvBalanceInVault = vaultSdfrax3crvBalanceBefore.mul(reserveFactor).div(100)
      const collateralAmount = await sdFrax3Crv.balanceOf(action1.address)
      // This assumes premium was paid in frax3crv. This is the lower bount 
      const premiumInfrax3crv = premium.div(await frax3crv.get_virtual_price()).mul(utils.parseEther('1.0'));
      const premiumInSdfrax3crv = premiumInfrax3crv.mul(await stakedaoSdfrax3crvStrategy.totalSupply()).div(await stakedaoSdfrax3crvStrategy.balance());
      const expectedTotal = vaultSdfrax3crvBalanceBefore.add(premiumInSdfrax3crv);
      const expectedSdfrax3crvBalanceInAction = vaultSdfrax3crvBalanceBefore.sub(expectedSdfrax3crvBalanceInVault).add(premiumInSdfrax3crv);
      const sellAmount = (collateralAmount.div(otokenStrikePrice)).div(100).toString(); // needs to be in 1e8 units

      const marginPoolBalanceOfsdFrax3CrvBefore = await sdFrax3Crv.balanceOf(marginPoolAddess);

      const order = await getOrder(
        action1.address,
        otoken.address,
        sellAmount,
        counterpartyWallet.address,
        frax.address,
        premium.toString(),
        swapAddress,
        counterpartyWallet.privateKey
      );

      expect(
        (await action1.lockedAsset()).eq('0'),
        'collateral should not be locked'
      ).to.be.true;

      await action1.mintAndSellOToken(collateralAmount, sellAmount, order);

      const vaultSdfrax3crvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

      // check sdFrax3Crv balance in action and vault
      expect(vaultSdfrax3crvBalanceAfter).to.be.within(
        expectedSdfrax3crvBalanceInVault.sub(1) as any, expectedSdfrax3crvBalanceInVault.add(1) as any, "incorrect balance in vault"
      );

      expect((await vault.totalStakedaoAsset()).gte(expectedTotal), 'incorrect accounting in vault').to.be.true;
      expect((await sdFrax3Crv.balanceOf(action1.address)).gte(premiumInSdfrax3crv), 'incorrect sdFrax3Crv balance in action').to.be.true;
      expect(await (await action1.currentValue()).gte(expectedSdfrax3crvBalanceInAction), 'incorrect current value in action').to.be.true;
      expect((await action1.lockedAsset()), 'incorrect accounting in action').to.be.equal(collateralAmount);
      expect(await frax.balanceOf(action1.address)).to.be.equal('0');


      // check the otoken balance of counterparty
      expect(await otoken.balanceOf(counterpartyWallet.address), 'incorrect otoken balance sent to counterparty').to.be.equal(
        sellAmount
      );

      const marginPoolBalanceOfsdFrax3CrvAfter = await sdFrax3Crv.balanceOf(marginPoolAddess);

      // check sdFrax3Crv balance in opyn 
      expect(marginPoolBalanceOfsdFrax3CrvAfter, 'incorrect balance in Opyn').to.be.equal(marginPoolBalanceOfsdFrax3CrvBefore.add(collateralAmount));
    });

    it('p3 deposits FRAX3CRV', async () => {
      // calculating the ideal amount of sdCrvRenWsdFrax3Crv that should be deposited
      const amountfrax3crvDeposited = p3DepositAmount

      // multiplying by 10^10 to scale a 10^8 number to a 10^18 number
      const sdfrax3crvSupplyBefore = await stakedaoSdfrax3crvStrategy.totalSupply();
      const frax3crvBalanceInStakedao = await stakedaoSdfrax3crvStrategy.balance();
      const sdFrax3crvDeposited = amountfrax3crvDeposited.mul(sdfrax3crvSupplyBefore).div(frax3crvBalanceInStakedao);

      // keep track of balance before
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const sharesBefore = await vault.totalSupply();
      const vaultSdfrax3crvBalanceBefore = await sdFrax3Crv.balanceOf(vault.address);

      // approve and deposit 
      await frax3crv.connect(depositor3).approve(vault.address, amountfrax3crvDeposited);
      await vault.connect(depositor3).depositCrvLP(amountfrax3crvDeposited);


      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdfrax3crvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

      // check the sdFrax3Crv token balances
      expect(vaultTotal.sub(vaultTotalBefore), 'internal accounting is incorrect').to.be.eq(sdFrax3crvDeposited);
      expect(vaultSdfrax3crvBalanceAfter.sub(vaultSdfrax3crvBalanceBefore), 'internal balance is incorrect').to.be.equal(
        sdFrax3crvDeposited
      );

      // check the minted share balances
      const sharesMinted = sdFrax3crvDeposited.mul(sharesBefore).div(vaultTotalBefore)
      expect((await vault.balanceOf(depositor3.address)), 'incorrcect amount of shares minted').to.be.equal(sharesMinted)
    });


    it('p1 withdraws FRAX3CRV', async () => {
      // vault balance calculations
      const vaultTotalSdfrax3crvBefore = await vault.totalStakedaoAsset();
      const vaultSdFrax3CrvBalanceBefore = await sdFrax3Crv.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);

      // p1 balance calculations 
      const fee = sharesToWithdraw.mul(vaultTotalSdfrax3crvBefore).div(sharesBefore).mul(5).div(1000);
      const balanceOfP1Before = await frax3crv.balanceOf(depositor1.address);

      // calculate sdFrax3Crv Balances after
      const sdFrax3crvToWithdraw = vaultTotalSdfrax3crvBefore.mul(sharesToWithdraw).div(sharesBefore);

      // calculate crv3Frax balances after
      const sdfrax3crvSupplyBefore = await stakedaoSdfrax3crvStrategy.totalSupply();
      const frax3crvBalanceInStakedao = await stakedaoSdfrax3crvStrategy.balance();
      const sdFrax3crvToWithdrawMinusFee = vaultTotalSdfrax3crvBefore.mul(sharesToWithdraw).div(sharesBefore).mul(995).div(1000);
      const crv3FraxToWithdraw = sdFrax3crvToWithdrawMinusFee.mul(frax3crvBalanceInStakedao).div(sdfrax3crvSupplyBefore);

      // fee calculations 
      const balanceOfFeeRecipientBefore = await sdFrax3Crv.balanceOf(feeRecipient.address);


      await vault
        .connect(depositor1)
        .withdrawCrvLp(sharesToWithdraw);

      // get vault balances after
      const sharesAfter = await vault.totalSupply();
      const vaultTotalSdfrax3crvAfter = await vault.totalStakedaoAsset();
      const vaultSdFrax3CrvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await sdFrax3Crv.balanceOf(feeRecipient.address);
      const balanceOfP1After = await frax3crv.balanceOf(depositor1.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      // check vault balance 
      expect(vaultSdFrax3CrvBalanceAfter, 'incorrect change in vault balance').to.be.within(
        vaultSdFrax3CrvBalanceBefore.sub(sdFrax3crvToWithdraw).sub(1) as any,
        vaultSdFrax3CrvBalanceBefore.sub(sdFrax3crvToWithdraw).add(1) as any,
      );
      expect(vaultTotalSdfrax3crvBefore.sub(sdFrax3crvToWithdraw), 'incorrect change in vault total accounting').to.be.eq(vaultTotalSdfrax3crvAfter);


      // check p1 balance 
      expect(balanceOfP1After, 'incorrect frax3crv transferred to p1').to.be.eq(balanceOfP1Before.add(crv3FraxToWithdraw).add(1))
      expect(balanceOfP1After.gt(p1DepositAmount), 'p1 should have made a profit').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))
    });

    it('option expires', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
      await provider.send('evm_mine', []);

      // set settlement price
      await wethPricer.setExpiryPriceInOracle(weth.address, expiry, '3000000000000');
      await sdFrax3CrvPricer.setExpiryPriceInOracle(expiry);

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      const sdFrax3CrvControlledByActionBefore = await action1.currentValue();
      const sdFrax3CrvBalanceInVaultBefore = await sdFrax3Crv.balanceOf(vault.address);

      await vault.closePositions();

      const sdFrax3CrvBalanceInVaultAfter = await sdFrax3Crv.balanceOf(vault.address);
      const sdFrax3CrvBalanceInActionAfter = await sdFrax3Crv.balanceOf(action1.address);
      const sdFrax3CrvControlledByActionAfter = await action1.currentValue();
      const vaultTotal = await vault.totalStakedaoAsset();

      // check vault balances
      expect(vaultTotal, 'incorrect accounting in vault').to.be.equal(sdFrax3CrvBalanceInVaultAfter);
      expect(sdFrax3CrvBalanceInVaultAfter, 'incorrect balances in vault').to.be.equal(sdFrax3CrvBalanceInVaultBefore.add(sdFrax3CrvControlledByActionBefore));

      // check action balances
      expect(
        (await action1.lockedAsset()).eq('0'),
        'all collateral should be unlocked'
      ).to.be.true;
      expect(sdFrax3CrvBalanceInActionAfter, 'no sdFrax3Crv should be left in action').to.be.equal('0');
      expect(sdFrax3CrvControlledByActionAfter, 'no sdFrax3Crv should be controlled by action').to.be.equal('0');
    });

    it('p2 withdraws FRAX3CRV', async () => {
      // vault balance calculations
      const vaultTotalSdfrax3crvBefore = await vault.totalStakedaoAsset();
      const vaultSdFrax3CrvBalanceBefore = await sdFrax3Crv.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);

      // p2 balance calculations 
      const fee = sharesToWithdraw.mul(vaultTotalSdfrax3crvBefore).div(sharesBefore).mul(5).div(1000);
      const balanceOfP1Before = await frax3crv.balanceOf(depositor2.address);

      // calculate sdFrax3Crv Balances after
      const sdFrax3crvToWithdraw = vaultTotalSdfrax3crvBefore.mul(sharesToWithdraw).div(sharesBefore);

      // calculate crv3Frax balances after
      const sdfrax3crvSupplyBefore = await stakedaoSdfrax3crvStrategy.totalSupply();
      const frax3crvBalanceInStakedao = await stakedaoSdfrax3crvStrategy.balance();
      const sdFrax3crvToWithdrawMinusFee = vaultTotalSdfrax3crvBefore.mul(sharesToWithdraw).div(sharesBefore).mul(995).div(1000);
      const crv3FraxToWithdrawWithoutPremium = sdFrax3crvToWithdrawMinusFee.mul(frax3crvBalanceInStakedao).div(sdfrax3crvSupplyBefore);
      const crv3FraxToWithdraw = crv3FraxToWithdrawWithoutPremium

      // fee calculations 
      const balanceOfFeeRecipientBefore = await sdFrax3Crv.balanceOf(feeRecipient.address);


      await vault
        .connect(depositor2)
        .withdrawCrvLp(sharesToWithdraw);

      // get vault balances after
      const sharesAfter = await vault.totalSupply();
      const vaultTotalSdfrax3crvAfter = await vault.totalStakedaoAsset();
      const vaultSdFrax3CrvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await sdFrax3Crv.balanceOf(feeRecipient.address);
      const balanceOfP2After = await frax3crv.balanceOf(depositor2.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      // check vault balance 
      expect(vaultSdFrax3CrvBalanceAfter, 'incorrect change in vault balance').to.be.within(
        vaultSdFrax3CrvBalanceBefore.sub(sdFrax3crvToWithdraw).sub(1) as any,
        vaultSdFrax3CrvBalanceBefore.sub(sdFrax3crvToWithdraw).add(1) as any,
      );
      expect(vaultTotalSdfrax3crvBefore.sub(sdFrax3crvToWithdraw), 'incorrect change in vault total accounting').to.be.eq(vaultTotalSdfrax3crvAfter);


      // check p2 balance 
      expect(balanceOfP2After, 'incorrect frac3crv transferred to p2').to.be.eq(balanceOfP1Before.add(crv3FraxToWithdraw).add(1))
      expect(balanceOfP2After.gt(p2DepositAmount), 'p2 shoult have made a profit').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))
    });

    it('p3 withdraws FRAX3CRV', async () => {
      // vault balance calculations
      const vaultTotalSdfrax3crvBefore = await vault.totalStakedaoAsset();
      const vaultSdFrax3CrvBalanceBefore = await sdFrax3Crv.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor3.address);

      // p3 balance calculations 
      const fee = sharesToWithdraw.mul(vaultTotalSdfrax3crvBefore).div(sharesBefore).mul(5).div(1000);
      const balanceOfP1Before = await frax3crv.balanceOf(depositor3.address);

      // calculate sdFrax3Crv Balances after
      const sdFrax3crvToWithdraw = vaultTotalSdfrax3crvBefore.mul(sharesToWithdraw).div(sharesBefore);

      // calculate crv3Frax balances after
      const sdfrax3crvSupplyBefore = await stakedaoSdfrax3crvStrategy.totalSupply();
      const frax3crvBalanceInStakedao = await stakedaoSdfrax3crvStrategy.balance();
      const sdFrax3crvToWithdrawMinusFee = vaultTotalSdfrax3crvBefore.mul(sharesToWithdraw).div(sharesBefore).mul(995).div(1000);
      const crv3FraxToWithdrawWithoutPremium = sdFrax3crvToWithdrawMinusFee.mul(frax3crvBalanceInStakedao).div(sdfrax3crvSupplyBefore);
      const crv3FraxToWithdraw = crv3FraxToWithdrawWithoutPremium

      // fee calculations 
      const balanceOfFeeRecipientBefore = await sdFrax3Crv.balanceOf(feeRecipient.address);


      await vault
        .connect(depositor3)
        .withdrawCrvLp(sharesToWithdraw);

      // get vault balances after
      const sharesAfter = await vault.totalSupply();
      const vaultTotalSdfrax3crvAfter = await vault.totalStakedaoAsset();
      const vaultSdFrax3CrvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await sdFrax3Crv.balanceOf(feeRecipient.address);
      const balanceOfP3After = await frax3crv.balanceOf(depositor3.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      // check vault balance 
      expect(vaultSdFrax3CrvBalanceAfter, 'incorrect change in vault balance').to.be.within(
        vaultSdFrax3CrvBalanceBefore.sub(sdFrax3crvToWithdraw).sub(1) as any,
        vaultSdFrax3CrvBalanceBefore.sub(sdFrax3crvToWithdraw).add(1) as any,
      );
      expect(vaultTotalSdfrax3crvBefore.sub(sdFrax3crvToWithdraw), 'incorrect change in vault total accounting').to.be.eq(vaultTotalSdfrax3crvAfter);


      // check p3 balance 
      // TODO: why off by 2? 
      expect(balanceOfP3After, 'incorrect frac3crv transferred to p3').to.be.eq(balanceOfP1Before.add(crv3FraxToWithdraw).add(2));
      expect(balanceOfP3After, 'p3 should have made a loss').to.be.eq(p3DepositAmount.mul(995).div(1000));

      // check fee 
      expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))
    });
  });

  // describe('Test deposit underlying and withdraw underlying', async() => { 
  //   this.beforeAll('send everyone frax', async () => {
  //     const fraxWhale = '0x7AfaFe3C06F4D4864fE37E981bf73279B5f44218'
  
  //     // send everyone frax
  //     await provider.send('hardhat_impersonateAccount', [fraxWhale]);
  //     const signer = await ethers.provider.getSigner(fraxWhale);
  //     await frax.connect(signer).transfer(depositor1.address, p1DepositAmount);
  //     await provider.send('evm_mine', []);
  //     await provider.send('hardhat_stopImpersonatingAccount', [fraxWhale]);
  //   })

  //   this.beforeAll('send everyone usdc', async () => {
  //     const usdcWhale = '0x036B96EEA235880a9e82fb128E5f6c107dFe8f57'
  //     const usdcAmount = p1DepositAmount.div(1000000000000);
  
  //     // send everyone usdc
  //     await provider.send('hardhat_impersonateAccount', [usdcWhale]);
  //     const signer = await ethers.provider.getSigner(usdcWhale);
  //     await usdc.connect(signer).transfer(depositor1.address, usdcAmount);
  //     await provider.send('evm_mine', []);
  //     await provider.send('hardhat_stopImpersonatingAccount', [usdcWhale]);
  //   })

  //   this.beforeAll('send everyone usdt', async () => {
  //     const usdtWhale = '0x67aB29354a70732CDC97f372Be81d657ce8822cd'
  //     const usdtAmount = p1DepositAmount.div(1000000000000);
  
  //     // send everyone usdt
  //     await provider.send('hardhat_impersonateAccount', [usdtWhale]);
  //     const signer = await ethers.provider.getSigner(usdtWhale);
  //     await usdt.connect(signer).transfer(depositor1.address, usdtAmount);
  //     await provider.send('evm_mine', []);
  //     await provider.send('hardhat_stopImpersonatingAccount', [usdtWhale]);
  //   })

  //   it('p1 deposits frax', async () => {
  //     // balances before
  //     const amountFraxDeposited = p1DepositAmount
  //     const p1FraxBalanceBefore = await frax.balanceOf(depositor1.address);
  //     const totalVaultBalanceBefore = await vault.totalStakedaoAsset();

  //     // approve and deposit
  //     await frax.connect(depositor1).approve(vault.address, amountFraxDeposited);
  //     await vault.connect(depositor1).depositUnderlying(amountFraxDeposited, 0, 0);

  //     // balances after
  //     const p1FraxBalanceAfter = await frax.balanceOf(depositor1.address);
  //     const totalVaultBalanceAfter = await vault.totalStakedaoAsset();
  //     const vaultSdFraxCrvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

  //     expect(p1FraxBalanceAfter, 'incorrect p1 frax balance').to.be.eq('0')
  //     expect((p1FraxBalanceBefore).gte(totalVaultBalanceAfter), 'incorrect amount of frax deposited from p1').to.be.true 
  //     expect(totalVaultBalanceBefore, 'incorrect initial vault balance').to.be.eq('0')
  //     expect(totalVaultBalanceAfter.gt('0'), 'vault balance should have increased').to.be.true;
  //     expect(vaultSdFraxCrvBalanceAfter,'mismatch between vault recorded balance and actual balance').to.be.eq(totalVaultBalanceAfter);

  //     // // check the minted share balances
  //     // expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
  //   });

  //   it('p1 deposits usdc', async () => {
  //     // balances before
  //     const amountUsdcDeposited = p1DepositAmount.div(1000000000000)
  //     const p1UsdcBalanceBefore = await usdc.balanceOf(depositor1.address);
  //     const totalVaultBalanceBefore = await vault.totalStakedaoAsset();

  //     // approve and deposit
  //     await usdc.connect(depositor1).approve(vault.address, amountUsdcDeposited);
  //     await vault.connect(depositor1).depositUnderlying(amountUsdcDeposited, 0, 2);

  //     // balances after
  //     const p1UsdcBalanceAfter = await usdc.balanceOf(depositor1.address);
  //     const totalVaultBalanceAfter = await vault.totalStakedaoAsset();
  //     const vaultSdFraxCrvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

  //     // expect(p1UsdcBalanceAfter, 'incorrect p1 usdc balance').to.be.eq('0')
  //     // expect((p1UsdcBalanceBefore).gte(totalVaultBalanceAfter.div(1000000000000)), 'incorrect amount of usdc deposited from p1').to.be.true 
  //     // expect(totalVaultBalanceBefore, 'incorrect initial vault balance').to.be.eq('0')
  //     // expect(totalVaultBalanceAfter.gt('0'), 'vault balance should have increased').to.be.true;
  //     // expect(vaultSdFraxCrvBalanceAfter,'mismatch between vault recorded balance and actual balance').to.be.eq(totalVaultBalanceAfter);

  //     // // check the minted share balances
  //     // expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
  //   });

  //   it('p1 deposits usdt', async () => {
  //     // balances before
  //     const amountUsdtDeposited = p1DepositAmount.div(1000000000000)
  //     const p1UsdtBalanceBefore = await usdt.balanceOf(depositor1.address);
  //     const totalVaultBalanceBefore = await vault.totalStakedaoAsset();

  //     // approve and deposit
  //     await usdt.connect(depositor1).approve(vault.address, amountUsdtDeposited);
  //     await vault.connect(depositor1).depositUnderlying(amountUsdtDeposited, 0, 3);

  //     // balances after
  //     const p1UsdtBalanceAfter = await usdt.balanceOf(depositor1.address);
  //     const totalVaultBalanceAfter = await vault.totalStakedaoAsset();
  //     const vaultSdFraxCrvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

  //     // expect(p1UsdtBalanceAfter, 'incorrect p1 usdt balance').to.be.eq('0')
  //     // expect((p1UsdtBalanceBefore).gte(totalVaultBalanceAfter.div(1000000000000)), 'incorrect amount of usdt deposited from p1').to.be.true 
  //     // expect(totalVaultBalanceBefore, 'incorrect initial vault balance').to.be.eq('0')
  //     // expect(totalVaultBalanceAfter.gt('0'), 'vault balance should have increased').to.be.true;
  //     // expect(vaultSdFraxCrvBalanceAfter,'mismatch between vault recorded balance and actual balance').to.be.eq(totalVaultBalanceAfter);

  //     // // check the minted share balances
  //     // expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
  //   });

  //   it('p1 withdraws', async () => {
  //     // vault balance calculations
  //     const vaultTotalBefore = await vault.totalStakedaoAsset();
  //     const vaultSdECRVBalanceBefore = await sdFrax3Crv.balanceOf(vault.address);
  //     const sharesBefore = await vault.totalSupply();
  //     const sharesToWithdraw = await vault.balanceOf(depositor1.address);

  //     // // p1 balance calculations 
  //     // const denominator = p1DepositAmount.add(p2DepositAmount);
  //     // const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
  //     // const amountToWithdraw = p1DepositAmount.add(shareOfPremium);
  //     // const fee = sharesToWithdraw.mul(vaultTotalBefore).div(sharesBefore).mul(5).div(1000);
  //     // const amountTransferredToP1 = amountToWithdraw.mul(95).div(100);
  //     // const balanceOfP1Before = await frax.balanceOf(depositor1.address);

  //     // // fee calculations 
  //     // const balanceOfFeeRecipientBefore = await sdFrax3Crv.balanceOf(feeRecipient.address);


  //     await vault
  //       .connect(depositor1)
  //       .withdrawUnderlying(sharesToWithdraw, '0');

  //     // // vault balance variables 
  //     // const sharesAfter = await vault.totalSupply();
  //     // const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
  //     // const sdFrax3CrvWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
  //     // const vaultSdECRVBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

  //     // // fee variables 
  //     // const balanceOfFeeRecipientAfter = await sdFrax3Crv.balanceOf(feeRecipient.address);
  //     // const balanceOfP1After = await frax.balanceOf(depositor1.address);

  //     // expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

  //     // const vaultTotalSdfrax3crv = await vault.totalStakedaoAsset();
  //     // // check vault balance 
  //     // expect(
  //     //   vaultTotalSdfrax3crv).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
  //     //     'total asset should update'
  //     //   );
  //     // expect(vaultSdECRVBalanceAfter).to.be.within(
  //     //   vaultSdECRVBalanceBefore.sub(sdFrax3CrvWithdrawn).sub(1) as any,
  //     //   vaultSdECRVBalanceBefore.sub(sdFrax3CrvWithdrawn).add(1) as any,
  //     // );

  //     // // check p1 balance 
  //     // expect(balanceOfP1After.gte((balanceOfP1Before.add(amountTransferredToP1))), 'incorrect eth transferred to p1').to.be.true;

  //     // // check fee 
  //     // expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))
  //   });
  // })
});
