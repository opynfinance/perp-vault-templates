import { ethers } from 'hardhat';
import { utils, BigNumber } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import {
  MockERC20,
  OpynPerpVault,
  IWETH,
  IEasyAuction,
  ShortOTokenWithAuction,
  IOtokenFactory,
  IOToken,
  MockPricer,
  IOracle,
} from '../../typechain';

enum VaultState {
  Locked,
  Unlocked,
  Emergency,
}

enum ActionState {
  Idle,
  Committed,
  Activated,
}

const QUEUE_START = '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('Mainnet Fork Tests for auction action', function () {
  // let counterpartyWallet = ethers.Wallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/30");
  let shortAuction: ShortOTokenWithAuction;
  // asset used by this action: in this case, weth
  let weth: IWETH;
  let usdc: MockERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let buyer1: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let random: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  let pricer: MockPricer;
  let oracle: IOracle;
  let easyAuction: IEasyAuction;
  let provider;

  /**
   *
   * CONSTANTS
   *
   */
  const day = 86400;
  const controllerAddress = '0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72';
  const whitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';

  const easyAuctionAddress = '0x0b7fFc1f4AD541A4Ed16b40D8c37f0929158D101';

  const oracleAddress = '0xc497f40D1B7db6FA5017373f1a0Ec6d53126Da23';
  const opynOwner = '0x638E5DA0EEbbA58c67567bcEb4Ab2dc8D34853FB';
  const otokenFactoryAddress = '0x7C06792Af1632E77cb27a558Dc0885338F4Bdf8E';
  const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

  const reserveFactor = 10;

  /**
   *
   * Setup
   *
   */

  this.beforeAll('Set accounts', async () => {
    accounts = await ethers.getSigners();
    const [_owner, _feeRecipient, _depositor1, _depositor2, _buyer1, _buyer2, _random] = accounts;

    owner = _owner;
    feeRecipient = _feeRecipient;

    depositor1 = _depositor1;
    depositor2 = _depositor2;
    buyer1 = _buyer1;
    buyer2 = _buyer2
    random = _random;
  });

  this.beforeAll('Connect to mainnet contracts', async () => {
    weth = (await ethers.getContractAt('IWETH', wethAddress)) as IWETH;
    usdc = (await ethers.getContractAt('MockERC20', usdcAddress)) as MockERC20;
    otokenFactory = (await ethers.getContractAt(
      'IOtokenFactory',
      otokenFactoryAddress
    )) as IOtokenFactory;
    oracle = (await ethers.getContractAt('IOracle', oracleAddress)) as IOracle;

    easyAuction = (await ethers.getContractAt('IEasyAuction', easyAuctionAddress)) as IEasyAuction;
  });

  this.beforeAll('Deploy vault and sell ETH calls action', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy()) as OpynPerpVault;

    // deploy the short action contract
    const ShortActionContract = await ethers.getContractFactory('ShortOTokenWithAuction');
    shortAuction = (await ShortActionContract.deploy(
      vault.address,
      weth.address,
      easyAuctionAddress,
      whitelistAddress,
      controllerAddress,
      0 // type 0 vault
    )) as ShortOTokenWithAuction;

    await vault
      .connect(owner)
      .init(
        weth.address,
        owner.address,
        feeRecipient.address,
        weth.address,
        18,
        'OpynPerpShortVault share',
        'sOPS',
        [shortAuction.address]
      );
  });

  this.beforeAll("Deploy pricer and update pricer in opyn's oracle", async () => {
    provider = ethers.provider;

    const PricerContract = await ethers.getContractFactory('MockPricer');
    pricer = (await PricerContract.deploy(oracleAddress)) as MockPricer;

    // impersonate owner and change the pricer
    await owner.sendTransaction({ to: opynOwner, value: utils.parseEther('1.0') });
    await provider.send('hardhat_impersonateAccount', [opynOwner]);
    const signer = await ethers.provider.getSigner(opynOwner);
    await oracle.connect(signer).setAssetPricer(weth.address, pricer.address);
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
  });

  describe('check the admin setup', async () => {
    it('should set fee reserve', async () => {
      // 10% reserve
      await vault.connect(owner).setWithdrawReserve(reserveFactor * 100);
      expect((await vault.withdrawReserve()).toNumber() == reserveFactor * 100).to.be.true;
    });
  });

  describe('profitable scenario', async () => {
    const p1DepositAmount = utils.parseEther('10');
    const p2DepositAmount = utils.parseEther('70');
    const premium = utils.parseEther('1');
    let totalAmountInVault: BigNumber;
    let actualAmountInVault: BigNumber;
    let actualAmountInAction;
    let otoken: IOToken;
    let expiry;
    let auctionId;

    this.beforeAll('deploy otoken that will be sold and set up counterparty', async () => {
      const otokenStrikePrice = 400000000000;
      const blockNumber = await provider.getBlockNumber();
      const block = await provider.getBlock(blockNumber);
      const currentTimestamp = block.timestamp;
      expiry = (Math.floor(currentTimestamp / day) + 10) * day + 28800;

      await otokenFactory.createOtoken(
        weth.address,
        usdc.address,
        weth.address,
        otokenStrikePrice,
        expiry,
        false
      );

      const otokenAddress = await otokenFactory.getOtoken(
        weth.address,
        usdc.address,
        weth.address,
        otokenStrikePrice,
        expiry,
        false
      );

      otoken = (await ethers.getContractAt('IOToken', otokenAddress)) as IOToken;
    });

    it('p1 deposits', async () => {
      totalAmountInVault = p1DepositAmount;
      actualAmountInVault = totalAmountInVault;
      await vault.connect(depositor1).depositETH({ value: p1DepositAmount });
      expect((await vault.totalAsset()).eq(totalAmountInVault), 'total asset should update').to.be
        .true;
      expect(await weth.balanceOf(vault.address)).to.be.equal(actualAmountInVault);
    });

    it('p2 deposits', async () => {
      totalAmountInVault = totalAmountInVault.add(p2DepositAmount);
      actualAmountInVault = totalAmountInVault;
      await vault.connect(depositor2).depositETH({ value: p2DepositAmount });
      expect((await vault.totalAsset()).eq(totalAmountInVault), 'total asset should update').to.be
        .true;
      expect(await weth.balanceOf(vault.address)).to.be.equal(actualAmountInVault);
    });

    it('owner commits to the option', async () => {
      // set live price as 3000
      await pricer.setPrice('300000000000');
      expect(await shortAuction.state()).to.be.equal(ActionState.Idle);
      await shortAuction.commitOToken(otoken.address);
      expect(await shortAuction.state()).to.be.equal(ActionState.Committed);
    });

    it('owner mints and start auction', async () => {
      // increase time
      const minPeriod = await shortAuction.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      await vault.rollOver([(100 - reserveFactor) * 100]);

      const collateralAmount = totalAmountInVault.mul(100 - reserveFactor).div(100);

      actualAmountInVault = totalAmountInVault.sub(collateralAmount);

      // convert 1e18 to otoken amount (1e8)
      const sellAmount = collateralAmount.div(10000000000).toString();

      expect((await shortAuction.lockedAsset()).eq('0'), 'collateral should not be locked').to.be.true;

      const blockNumber = await provider.getBlockNumber();
      const block = await provider.getBlock(blockNumber);
      const currentTimestamp = block.timestamp;
      const auctionExpiry = currentTimestamp + day * 1;

      const minimalBidAmountPerOrder = 0.1 * 1e8 // min bid each order: 0.1 otoken
      const minFundingThreshold = 0;

      const easyAuctionOTokenBefore = await otoken.balanceOf(easyAuctionAddress)

      // mint and sell 72 otokens
      await shortAuction.mintAndStartAuction(
        collateralAmount,
        sellAmount,
        auctionExpiry, // order cancel deadline
        auctionExpiry,
        premium,
        minimalBidAmountPerOrder,
        minFundingThreshold,
        false
      );

      auctionId = await shortAuction.auctionId();      
      
      expect((await otoken.balanceOf(shortAuction.address)).isZero()).to.be.true

      const easyAuctionOTokenAfter = await otoken.balanceOf(easyAuctionAddress)
      
      expect(easyAuctionOTokenAfter.sub(easyAuctionOTokenBefore)).to.be.eq(sellAmount)
      
    });

    it('p1 participate in auction', async() => {
      await weth.connect(buyer1).deposit({value: utils.parseEther('10')})
      await weth.connect(buyer1).approve(easyAuction.address, ethers.constants.MaxUint256)
      await easyAuction.connect(buyer1).registerUser(buyer1.address)
      
      await easyAuction.connect(buyer1).placeSellOrders(
        auctionId,
        [(10 * 1e8).toString()], // 10 otoken
        [utils.parseEther('1')],
        [QUEUE_START],
        '0x00'
      )
    })

    it('p2 participate in auction', async() => {
      await weth.connect(buyer2).deposit({value: utils.parseEther('10')})
      await weth.connect(buyer2).approve(easyAuction.address, ethers.constants.MaxUint256)
      await easyAuction.connect(buyer2).registerUser(buyer2.address)
      
      await easyAuction.connect(buyer2).placeSellOrders(
        auctionId,
        [(100 * 1e8).toString()], // 100 otoken
        [utils.parseEther('5')], // total 5 eth
        [QUEUE_START],
        '0x00'
      )
    })

    // it('p1 withdraws', async () => {
    //   const denominator = p1DepositAmount.add(p2DepositAmount);
    //   const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
    //   const amountToWithdraw = p1DepositAmount.add(shareOfPremium);
    //   const fee = amountToWithdraw.mul(5).div(1000);
    //   const amountTransferredToP1 = amountToWithdraw.sub(fee);

    //   totalAmountInVault = totalAmountInVault.sub(amountToWithdraw);
    //   actualAmountInVault = actualAmountInVault.sub(amountToWithdraw);

    //   const balanceOfFeeRecipientBefore = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP1Before = await weth.balanceOf(depositor1.address);

    //   await vault.connect(depositor1).withdraw(await vault.balanceOf(depositor1.address));

    //   const balanceOfFeeRecipientAfter = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP1After = await weth.balanceOf(depositor1.address);

    //   expect((await vault.totalAsset()).eq(totalAmountInVault), 'total asset should update').to.be
    //     .true;
    //   expect(await weth.balanceOf(vault.address)).to.be.equal(actualAmountInVault);
    //   expect(balanceOfFeeRecipientBefore.add(fee)).to.be.equal(balanceOfFeeRecipientAfter);
    //   expect(balanceOfP1Before.add(amountTransferredToP1)).to.be.equal(balanceOfP1After);
    // });

    // it('option expires', async () => {
    //   // increase time
    //   await provider.send('evm_setNextBlockTimestamp', [expiry + day]);
    //   await provider.send('evm_mine', []);

    //   // set settlement price
    //   await pricer.setExpiryPriceInOracle(weth.address, expiry, '200000000000');

    //   // increase time
    //   await provider.send('evm_increaseTime', [day]); // increase time
    //   await provider.send('evm_mine', []);

    //   actualAmountInVault = totalAmountInVault;

    //   await vault.closePositions();

    //   expect((await vault.totalAsset()).eq(totalAmountInVault), 'total asset should be same').to.be
    //     .true;
    //   expect(await weth.balanceOf(vault.address)).to.be.equal(actualAmountInVault);
    //   expect((await shortAuction.lockedAsset()).eq('0'), 'all collateral should be unlocked').to.be.true;
    // });

    // it('p2 withdraws', async () => {
    //   const denominator = p1DepositAmount.add(p2DepositAmount);
    //   const shareOfPremium = p2DepositAmount.mul(premium).div(denominator);
    //   const amountToWithdraw = p2DepositAmount.add(shareOfPremium);
    //   const fee = amountToWithdraw.mul(5).div(1000);
    //   const amountTransferredToP2 = amountToWithdraw.sub(fee);

    //   totalAmountInVault = totalAmountInVault.sub(amountToWithdraw);
    //   actualAmountInVault = actualAmountInVault.sub(amountToWithdraw);

    //   const balanceOfFeeRecipientBefore = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP2Before = await weth.balanceOf(depositor2.address);

    //   await vault.connect(depositor2).withdraw(await vault.balanceOf(depositor2.address));

    //   const balanceOfFeeRecipientAfter = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP2After = await weth.balanceOf(depositor2.address);

    //   expect((await vault.totalAsset()).eq(totalAmountInVault), 'total asset should update').to.be
    //     .true;
    //   expect(await weth.balanceOf(vault.address)).to.be.equal(actualAmountInVault);
    //   expect(balanceOfFeeRecipientBefore.add(fee)).to.be.equal(balanceOfFeeRecipientAfter);
    //   expect(balanceOfP2Before.add(amountTransferredToP2)).to.be.equal(balanceOfP2After);
    // });

    // it('p3 withdraws', async () => {
    //   const amountToWithdraw = p3DepositAmount;
    //   const fee = amountToWithdraw.mul(5).div(1000);
    //   const amountTransferredToP3 = amountToWithdraw.sub(fee);

    //   totalAmountInVault = '0';
    //   actualAmountInVault = '0';

    //   const balanceOfFeeRecipientBefore = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP3Before = await weth.balanceOf(depositor3.address);

    //   await vault.connect(depositor3).withdraw(await vault.balanceOf(depositor3.address));

    //   const balanceOfFeeRecipientAfter = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP3After = await weth.balanceOf(depositor3.address);

    //   expect((await vault.totalAsset()).eq(totalAmountInVault), 'total asset should update').to.be
    //     .true;
    //   expect(await weth.balanceOf(vault.address)).to.be.equal(actualAmountInVault);
    //   expect(balanceOfFeeRecipientBefore.add(fee)).to.be.equal(balanceOfFeeRecipientAfter);
    //   expect(balanceOfP3Before.add(amountTransferredToP3)).to.be.equal(balanceOfP3After);
    // });
  });
});
