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
  let frax3crv: IERC20;
  let sdFrax3Crv: IERC20;

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
  const curvePoolAddress = '0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B';
  const frax3crvAddress = '0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B';
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddess = '0x5934807cC0654d46755eBd2848840b616256C6Ef';

  /** Test Scenario Params */
  const p1DepositAmount = utils.parseEther('1000');
  const p2DepositAmount = utils.parseEther('7000');
  const p3DepositAmount = utils.parseEther('2000');
  const premium = utils.parseEther('2');

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
    frax3crv = (await ethers.getContractAt('IERC20', frax3crvAddress)) as IERC20;
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
        curvePoolAddress
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

  this.beforeAll('send everyone frax', async () => {
    const fraxWhale = '0x7AfaFe3C06F4D4864fE37E981bf73279B5f44218'

    // send everyone frax
    await provider.send('hardhat_impersonateAccount', [fraxWhale]);
    const signer = await ethers.provider.getSigner(fraxWhale);
    await frax.connect(signer).transfer(counterpartyWallet.address, premium);
    await frax.connect(signer).transfer(depositor1.address, p1DepositAmount);
    await frax.connect(signer).transfer(depositor2.address, p2DepositAmount);
    await frax.connect(signer).transfer(depositor3.address, p3DepositAmount);
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [fraxWhale]);
  })

  this.beforeAll('send everyone frax3crv', async() => { 
    const frax3crvWhale = '0xAef01e64B1F59B99208b93a7D8A09F9f175d79Fa'
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

    xit('p1 deposits', async () => {
      // calculating the ideal amount of sdCrvRenWsbtc that should be deposited
      const frax3crvTofrax = await curvePool.get_virtual_price();
      const amountCrvRenWsbtcDeposited = p1DepositAmount.mul(utils.parseEther('1.0')).div(frax3crvTofrax);
      const sdCrvRenWsbtcToCrvRenWsbtc = await stakedaoSdfrax3crvStrategy.getPricePerFullShare();
      const amountSdCrvRenWsbtcDeposited = amountCrvRenWsbtcDeposited.mul(utils.parseEther('1.0')).div(sdCrvRenWsbtcToCrvRenWsbtc);

      // multiplying by 10^10 to scale a 10^8 number to a 10^18 number
      const upperBoundOfSdCrvRenWsbtcDeposited = amountSdCrvRenWsbtcDeposited.mul(10000000000)
      // 1% slippage from the ideal is acceptable at most
      const lowerBoundOfSdCrvRenWsbtcDeposited = amountSdCrvRenWsbtcDeposited.mul(99).div(100).mul(10000000000);


      await frax.connect(depositor1).approve(vault.address, p1DepositAmount);
      await vault.connect(depositor1).depositUnderlying(p1DepositAmount, lowerBoundOfSdCrvRenWsbtcDeposited);


      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdfrax3crvBalance = await sdFrax3Crv.balanceOf(vault.address);
      const totalSharesMinted = vaultSdfrax3crvBalance;


      // check the sdFrax3Crv token balances
      expect(vaultTotal, 'internal accounting is incorrect').to.be.within(lowerBoundOfSdCrvRenWsbtcDeposited as any, upperBoundOfSdCrvRenWsbtcDeposited as any);
      expect(vaultSdfrax3crvBalance).to.be.equal(
        vaultTotal, 'internal balance is incorrect'
      );

      // check the minted share balances
      expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
    });

    it('p1 deposits FRAX3CRV', async () => {
      // calculating the ideal amount of sdCrvRenWsbtc that should be deposited
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

    xit('p2 deposits', async () => {
      // Calculate lower and upper bounds
      // calculating the ideal amount of sdCrvRenWsbtc that should be deposited
      const frax3crvTofrax = await curvePool.get_virtual_price();
      const amountCrvRenWsbtcDeposited = p2DepositAmount.mul(utils.parseEther('1.0')).div(frax3crvTofrax);
      const sdCrvRenWsbtcToCrvRenWsbtc = await stakedaoSdfrax3crvStrategy.getPricePerFullShare();
      const amountSdCrvRenWsbtcDeposited = amountCrvRenWsbtcDeposited.mul(utils.parseEther('1.0')).div(sdCrvRenWsbtcToCrvRenWsbtc);
      // multiplying by 10^10 to scale a 10^8 number to a 10^18 number
      const upperBoundOfSdCrvRenWsbtcDeposited = amountSdCrvRenWsbtcDeposited.mul(10000000000)
      // 1% slippage from the ideal is acceptable at most
      const lowerBoundOfSdCrvRenWsbtcDeposited = amountSdCrvRenWsbtcDeposited.mul(99).div(100).mul(10000000000);


      // keep track of shares before
      const sharesBefore = await vault.totalSupply();
      const vaultSdfrax3crvBalanceBefore = await sdFrax3Crv.balanceOf(vault.address);

      // Approve and deposit underlying
      await frax.connect(depositor2).approve(vault.address, p2DepositAmount);
      await vault.connect(depositor2).depositUnderlying(p2DepositAmount, lowerBoundOfSdCrvRenWsbtcDeposited);

      const vaultTotal = await vault.totalStakedaoAsset();
      const vaultSdfrax3crvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);
      const sdFrax3CrvDeposited = vaultSdfrax3crvBalanceAfter.sub(vaultSdfrax3crvBalanceBefore);

      // check the sdFrax3Crv token balances
      // there is no accurate way of estimating this, so just approximating for now
      expect(sdFrax3CrvDeposited, 'internal accounting is incorrect').to.be.within(lowerBoundOfSdCrvRenWsbtcDeposited as any, upperBoundOfSdCrvRenWsbtcDeposited as any);
      expect(vaultTotal).to.be.equal(
        vaultSdfrax3crvBalanceAfter, 'internal balance is incorrect'
      );

      // check the minted share balances
      const shares = sharesBefore.div(vaultSdfrax3crvBalanceBefore).mul(sdFrax3CrvDeposited)
      expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted').to.be.equal(shares)
    });

    it('p2 deposits FRAX3CRV', async () => {
      // calculating the ideal amount of sdCrvRenWsbtc that should be deposited
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
      console.log(vaultTotal.toString())
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
      let expectedSdfrax3crvBalanceInAction = vaultSdfrax3crvBalanceBefore.sub(expectedSdfrax3crvBalanceInVault)
      const collateralAmount = await sdFrax3Crv.balanceOf(action1.address)
      const premiumInSdfrax3crv = premium.mul(95).div(100);
      const expectedTotal = vaultSdfrax3crvBalanceBefore.add(premiumInSdfrax3crv);
      expectedSdfrax3crvBalanceInAction = expectedSdfrax3crvBalanceInVault.add(premiumInSdfrax3crv);
      const sellAmount = (collateralAmount.div(otokenStrikePrice)).div(100).toString();

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

      // const vaultSdfrax3crvBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

      // // check sdFrax3Crv balance in action and vault
      // expect(vaultSdfrax3crvBalanceAfter).to.be.within(
      //   expectedSdfrax3crvBalanceInVault.sub(1) as any, expectedSdfrax3crvBalanceInVault.add(1) as any, "incorrect balance in vault"
      // );
      // expect(
      //   (await vault.totalStakedaoAsset()).gte(expectedTotal),
      //   'incorrect accounting in vault'
      // ).to.be.true;
      // expect(((await sdFrax3Crv.balanceOf(action1.address)).gte(expectedSdfrax3crvBalanceInAction), 'incorrect sdcrvRenWSBTC balance in action'))
      // expect((await action1.lockedAsset()), 'incorrect accounting in action').to.be.equal(collateralAmount)
      // expect(await frax.balanceOf(action1.address)).to.be.equal('0');


      // // check the otoken balance of counterparty
      // expect(await otoken.balanceOf(counterpartyWallet.address), 'incorrect otoken balance sent to counterparty').to.be.equal(
      //   sellAmount
      // );

      // const marginPoolBalanceOfsdFrax3CrvAfter = await sdFrax3Crv.balanceOf(marginPoolAddess);

      // // check sdcrvRenWSBTC balance in opyn 
      // expect(marginPoolBalanceOfsdFrax3CrvAfter, 'incorrect balance in Opyn').to.be.equal(marginPoolBalanceOfsdFrax3CrvBefore.add(collateralAmount));
    });

    xit('p3 deposits', async () => {
      const effectiveP3deposit = p3DepositAmount.mul(95).div(100)
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const expectedTotal = vaultTotalBefore.add(effectiveP3deposit);
      const sharesBefore = await vault.totalSupply();
      const actualAmountInVaultBefore = await sdFrax3Crv.balanceOf(vault.address);

      await frax.connect(depositor3).approve(vault.address, p3DepositAmount);
      await vault.connect(depositor3).depositUnderlying(p3DepositAmount, '0');

      const vaultTotalAfter = await vault.totalStakedaoAsset();
      const sdFrax3CrvDeposited = vaultTotalAfter.sub(vaultTotalBefore);
      actualAmountInVault = await sdFrax3Crv.balanceOf(vault.address);
      // check the sdFrax3Crv token balances
      // there is no accurate way of estimating this, so just approximating for now
      expect(
        (await vault.totalStakedaoAsset()).gte(expectedTotal),
        'internal accounting is incorrect'
      ).to.be.true;
      expect(actualAmountInVault).to.be.equal(
        actualAmountInVaultBefore.add(sdFrax3CrvDeposited), 'internal accounting should match actual balance'
      );

      // check the minted share balances
      const shares = sdFrax3CrvDeposited.mul(sharesBefore).div(vaultTotalBefore)
      expect((await vault.balanceOf(depositor3.address))).to.be.equal(shares)
    });

    xit('p1 withdraws', async () => {
      // vault balance calculations
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultSdECRVBalanceBefore = await sdFrax3Crv.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor1.address);

      // p1 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p1DepositAmount.add(shareOfPremium);
      const fee = sharesToWithdraw.mul(vaultTotalBefore).div(sharesBefore).mul(5).div(1000);
      const amountTransferredToP1 = amountToWithdraw.mul(95).div(100);
      const balanceOfP1Before = await frax.balanceOf(depositor1.address);

      // fee calculations 
      const balanceOfFeeRecipientBefore = await sdFrax3Crv.balanceOf(feeRecipient.address);


      await vault
        .connect(depositor1)
        .withdrawUnderlying(sharesToWithdraw, amountTransferredToP1);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const sdFrax3CrvWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultSdECRVBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await sdFrax3Crv.balanceOf(feeRecipient.address);
      const balanceOfP1After = await frax.balanceOf(depositor1.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalSdfrax3crv = await vault.totalStakedaoAsset();
      // check vault balance 
      expect(
        vaultTotalSdfrax3crv).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
          'total asset should update'
        );
      expect(vaultSdECRVBalanceAfter).to.be.within(
        vaultSdECRVBalanceBefore.sub(sdFrax3CrvWithdrawn).sub(1) as any,
        vaultSdECRVBalanceBefore.sub(sdFrax3CrvWithdrawn).add(1) as any,
      );

      // check p1 balance 
      expect(balanceOfP1After.gte((balanceOfP1Before.add(amountTransferredToP1))), 'incorrect eth transferred to p1').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))
    });

    xit('option expires', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
      await provider.send('evm_mine', []);

      // set settlement price
      await wethPricer.setExpiryPriceInOracle(frax.address, expiry, '3000000000000');
      await sdFrax3CrvPricer.setExpiryPriceInOracle(expiry);

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      const sbtcControlledByActionBefore = await action1.currentValue();
      const sbtcBalanceInVaultBefore = await sdFrax3Crv.balanceOf(vault.address);

      await vault.closePositions();

      const sbtcBalanceInVaultAfter = await sdFrax3Crv.balanceOf(vault.address);
      const sbtcBalanceInActionAfter = await sdFrax3Crv.balanceOf(action1.address);
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

    xit('p2 withdraws', async () => {
      // vault balance calculations
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const vaultSdECRVBalanceBefore = await sdFrax3Crv.balanceOf(vault.address);
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor2.address);

      // p2 balance calculations 
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p2DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p2DepositAmount.add(shareOfPremium);
      const fee = sharesToWithdraw.mul(vaultTotalBefore).div(sharesBefore).mul(5).div(1000);
      const amountTransferredToP2 = amountToWithdraw.mul(95).div(100);
      const balanceOfP2Before = await frax.balanceOf(depositor2.address);

      // fee calculations 
      const balanceOfFeeRecipientBefore = await sdFrax3Crv.balanceOf(feeRecipient.address);


      await vault
        .connect(depositor2)
        .withdrawUnderlying(sharesToWithdraw, amountTransferredToP2);

      // vault balance variables 
      const sharesAfter = await vault.totalSupply();
      const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
      const sdFrax3CrvWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
      const vaultSdECRVBalanceAfter = await sdFrax3Crv.balanceOf(vault.address);

      // fee variables 
      const balanceOfFeeRecipientAfter = await sdFrax3Crv.balanceOf(feeRecipient.address)
      const balanceOfP2After = await frax.balanceOf(depositor2.address);

      expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))

      const vaultTotalSdfrax3crv = await vault.totalStakedaoAsset();

      // check vault balance 
      expect(
        vaultTotalSdfrax3crv).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(50) as any,
          'total asset should update'
        );
      expect(vaultSdECRVBalanceAfter).to.be.within(
        vaultSdECRVBalanceBefore.sub(sdFrax3CrvWithdrawn).sub(1) as any,
        vaultSdECRVBalanceBefore.sub(sdFrax3CrvWithdrawn).add(1) as any,
      );

      // check p2 balance 
      expect(balanceOfP2After.gte((balanceOfP2Before.add(amountTransferredToP2))), 'incorrect underlying transferred to p2').to.be.true;

      // check fee 
      expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))
    });

    xit('p3 withdraws', async () => {
      const vaultTotalBefore = await vault.totalStakedaoAsset();
      const sharesBefore = await vault.totalSupply();
      const sharesToWithdraw = await vault.balanceOf(depositor3.address);

      // balance calculations 
      const amountToWithdraw = p3DepositAmount;
      const fee = sharesToWithdraw.mul(vaultTotalBefore).div(sharesBefore).mul(5).div(1000);
      const amountTransferredToP3 = amountToWithdraw.mul(95).div(100);
      const balanceOfP3Before = await frax.balanceOf(depositor3.address);

      // fee calculations
      const balanceOfFeeRecipientBefore = await sdFrax3Crv.balanceOf(feeRecipient.address);

      await vault
        .connect(depositor3)
        .withdrawUnderlying(await vault.balanceOf(depositor3.address), amountTransferredToP3);

      const balanceOfFeeRecipientAfter = await sdFrax3Crv.balanceOf(feeRecipient.address);
      const balanceOfP3After = await frax.balanceOf(depositor3.address);

      expect(
        (await vault.totalStakedaoAsset()).eq('0'),
        'total in vault should be empty'
      ).to.be.true;
      expect(await sdFrax3Crv.balanceOf(vault.address), 'total in vault should be empty').to.be.equal(
        '0'
      );

      // check fee 
      expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(fee))

      // check p3 balance 
      expect(balanceOfP3After.gte((balanceOfP3Before.add(amountTransferredToP3))), 'incorrect underlying transferred to p3').to.be.true;
    });
  });
});
