import {ethers} from 'hardhat';
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
  Locked,
  Unlocked,
  Emergency
}

enum ActionState {
  Idle,
  Committed,
  Activated
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
  let random: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  let otokenWhitelist: IWhitelist;
  let sdecrvPricer: StakedaoEcrvPricer;
  let wethPricer: MockPricer;
  let oracle: IOracle;
  let provider;

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
      _random
    ] = accounts;

    owner = _owner;
    feeRecipient = _feeRecipient;

    depositor1 = _depositor1;
    depositor2 = _depositor2;
    depositor3 = _depositor3;
    random = _random;
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
    vault = (await VaultContract.deploy()) as OpynPerpVault;

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
      weth.address
    )) as ShortOTokenActionWithSwap;

    await vault.connect(owner).init(
      stakeDaoTokenAddress,
      weth.address,
      curveAddress,
      owner.address,
      feeRecipient.address,
      weth.address,
      18,
      'OpynPerpShortVault share',
      'sOPS',
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
        value: utils.parseEther('1.0')
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

  this.beforeAll('whitelist stakedao LP in the Opyn system', async () => {
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
      expect((await vault.totalAsset()).isZero(), 'total asset should be zero')
        .to.be.true;
      expect((await vault.WETH()) === weth.address).to.be.true;
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
    let totalAmountInVault;
    let actualAmountInVault;
    let actualAmountInAction;
    let otoken: IOToken;
    let expiry;
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
          value: utils.parseEther('3')
        });
        await weth.connect(counterpartyWallet).deposit({ value: premium });
        await weth.connect(counterpartyWallet).approve(swapAddress, premium);
      }
    );
    it('p1 deposits', async () => {
      totalAmountInVault = p1DepositAmount;
      actualAmountInVault = totalAmountInVault;
      await vault.connect(depositor1).depositETH({value: p1DepositAmount});
      expect(
        (await vault.totalAsset()).gte(totalAmountInVault.mul(0.95)),
        'total asset should update'
      ).to.be.true;
      // expect(await stakeDaoLP.balanceOf(vault.address)).to.be.equal(
      //   actualAmountInVault
      // );
    });

    it('p2 deposits', async () => {
      totalAmountInVault = totalAmountInVault.add(p2DepositAmount);
      actualAmountInVault = totalAmountInVault;
      await vault.connect(depositor2).depositETH({value: p2DepositAmount});
      expect(
        (await vault.totalAsset()).eq(totalAmountInVault),
        'total asset should update'
      ).to.be.true;
      expect(await weth.balanceOf(vault.address)).to.be.equal(
        actualAmountInVault
      );
    });

    xit('tests getPrice in sdecrvPricer', async () => {
      await wethPricer.setPrice('2000');
      const wethPrice = await oracle.getPrice(weth.address);
      const stakeDaoLPPrice = await oracle.getPrice(stakeDaoLP.address);
      expect(wethPrice.toNumber()).to.be.lessThanOrEqual(
        stakeDaoLPPrice.toNumber()
      );
    });

    xit('owner commits to the option', async () => {
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitOToken(otoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });

    xit('owner deposits ecrv to stakedao, mints options and sells them', async () => {
      // increase time
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      await vault.rollOver([(100 - reserveFactor) * 100]);

      const collateralAmount = totalAmountInVault
        .mul(100 - reserveFactor)
        .div(100);
      actualAmountInVault = totalAmountInVault.sub(collateralAmount);
      // TODO: cannot sell full amount because in all the conversions we end up with less than the actual amount
      const sellAmount = collateralAmount.div(1000000000000).mul(95).toString(); // 95% of 72 * 10^ 8
      expect((await stakeDaoLP.balanceOf(marginPoolAddess)).eq('0')).to.be.true;

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

      totalAmountInVault = totalAmountInVault.add(premium);

      expect(await otoken.balanceOf(counterpartyWallet.address)).to.be.equal(
        sellAmount
      );
      expect((await stakeDaoLP.balanceOf(marginPoolAddess)).gt('0')).to.be.true;
      expect(await weth.balanceOf(action1.address)).to.be.equal(premium);
      expect(await weth.balanceOf(vault.address)).to.be.equal(
        actualAmountInVault
      );
      expect(
        (await vault.totalAsset()).eq(totalAmountInVault),
        'total asset should have increased'
      ).to.be.true;

      expect(
        (await action1.lockedAsset()).eq(collateralAmount),
        'collateral should be locked'
      ).to.be.true;
    });

    xit('p3 deposits', async () => {
      totalAmountInVault = totalAmountInVault.add(p3DepositAmount);
      actualAmountInVault = actualAmountInVault.add(p3DepositAmount);

      await vault.connect(depositor3).depositETH({value: p3DepositAmount});
      expect(
        (await vault.totalAsset()).eq(totalAmountInVault),
        'total asset should update'
      ).to.be.true;
      expect(await weth.balanceOf(vault.address)).to.be.equal(
        actualAmountInVault
      );
    });

    xit('p1 withdraws', async () => {
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p1DepositAmount.add(shareOfPremium);
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP1 = amountToWithdraw.sub(fee);

      totalAmountInVault = totalAmountInVault.sub(amountToWithdraw);
      actualAmountInVault = actualAmountInVault.sub(amountToWithdraw);

      const balanceOfFeeRecipientBefore = await weth.balanceOf(
        feeRecipient.address
      );
      const balanceOfP1Before = await weth.balanceOf(depositor1.address);

      await vault
        .connect(depositor1)
        .withdrawETH(await vault.balanceOf(depositor1.address));

      const balanceOfFeeRecipientAfter = await weth.balanceOf(
        feeRecipient.address
      );
      const balanceOfP1After = await weth.balanceOf(depositor1.address);

      expect(
        (await vault.totalAsset()).eq(totalAmountInVault),
        'total asset should update'
      ).to.be.true;
      expect(await weth.balanceOf(vault.address)).to.be.equal(
        actualAmountInVault
      );
      expect(balanceOfFeeRecipientBefore.add(fee)).to.be.equal(
        balanceOfFeeRecipientAfter
      );
      expect(balanceOfP1Before.add(amountTransferredToP1)).to.be.equal(
        balanceOfP1After
      );
    });

    xit('option expires', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
      await provider.send('evm_mine', []);

      // set settlement price
      await wethPricer.setExpiryPriceInOracle(weth.address, expiry, '1000');
      await sdecrvPricer.setExpiryPriceInOracle(expiry);

      // increase time
      await provider.send('evm_increaseTime', [day]); // increase time
      await provider.send('evm_mine', []);

      actualAmountInVault = totalAmountInVault;

      await vault.closePositions();

      // @dev: it is a little hard to estimate exactly how much we get back. This just tests that we get back at least original deposit amount. 
      expect(
        (await vault.totalAsset()).gte(totalAmountInVault.sub(premium)),
        'total asset should be same'
      ).to.be.true;
      expect(await weth.balanceOf(vault.address)).gte(
        actualAmountInVault.sub(premium)
      );
      expect(
        (await action1.lockedAsset()).eq('0'),
        'all collateral should be unlocked'
      ).to.be.true;
    });

    xit('p2 withdraws', async () => {
      const denominator = p1DepositAmount.add(p2DepositAmount);
      const shareOfPremium = p2DepositAmount.mul(premium).div(denominator);
      const amountToWithdraw = p2DepositAmount.add(shareOfPremium);
      const fee = amountToWithdraw.mul(5).div(1000);
      const amountTransferredToP2 = amountToWithdraw.sub(fee);

      totalAmountInVault = totalAmountInVault.sub(amountToWithdraw);
      actualAmountInVault = actualAmountInVault.sub(amountToWithdraw);

      const balanceOfFeeRecipientBefore = await weth.balanceOf(
        feeRecipient.address
      );
      const balanceOfP2Before = await weth.balanceOf(depositor2.address);

      await vault
        .connect(depositor2)
        .withdrawETH(await vault.balanceOf(depositor2.address));

      const balanceOfFeeRecipientAfter = await weth.balanceOf(
        feeRecipient.address
      );
      const balanceOfP2After = await weth.balanceOf(depositor2.address);

      expect(
        (await vault.totalAsset()).gte(totalAmountInVault.sub(premium)),
        'total asset should be same'
      ).to.be.true;
      expect(await weth.balanceOf(vault.address)).gte(
        actualAmountInVault.sub(premium)
      );
      // @dev: it is a little hard to estimate exactly how much we get back. This just tests that we get back at least original deposit amount. 
      expect(balanceOfFeeRecipientAfter.gte(balanceOfFeeRecipientBefore), 'not profitable').to.be.true;
      expect((balanceOfP2After).gte(p2DepositAmount), 'not profitable, user lost money').to.be.true;
    });

    xit('p3 withdraws', async () => {
      const amountToWithdraw = p3DepositAmount;
      const fee = amountToWithdraw.mul(5).div(1000);
      // Assuming some bound of loss. 
      const curveImbalanceFactor = amountToWithdraw.mul(1).div(100)
      const amountTransferredToP3 = amountToWithdraw.sub(fee).sub(curveImbalanceFactor);

      totalAmountInVault = '0';
      actualAmountInVault = '0';

      const balanceOfFeeRecipientBefore = await weth.balanceOf(
        feeRecipient.address
      );
      const balanceOfP3Before = await weth.balanceOf(depositor3.address);

      await vault
        .connect(depositor3)
        .withdrawETH(await vault.balanceOf(depositor3.address));

      const balanceOfFeeRecipientAfter = await weth.balanceOf(
        feeRecipient.address
      );
      const balanceOfP3After = await weth.balanceOf(depositor3.address);

      expect(
        (await vault.totalAsset()).eq(totalAmountInVault),
        'total asset should update'
      ).to.be.true;
      expect(await weth.balanceOf(vault.address)).to.be.equal(
        actualAmountInVault
      );
      // @dev: it is a little hard to estimate exactly how much we get back. This just tests that we get back at least original deposit amount. 
      expect(balanceOfFeeRecipientAfter.gte(balanceOfFeeRecipientBefore), 'not profitable').to.be.true;
      expect((balanceOfP3After).gte(amountTransferredToP3), 'not profitable, user lost money').to.be.true;
    });
  });
});
