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

enum ActionState {
  Idle,
  Committed,
  Activated,
}

const QUEUE_START = '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('Mainnet Fork Tests for auction action', function () {
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

  this.beforeAll("Deploy pricer and update pricer in Opyn's oracle", async () => {
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

  /**
   * Test case: 
   * A short action start a auction to sell 72 4000-ETH-C.
   * In the first round: buyer1 participates and buys 20 with 1 eth
   * then auction ends
   * In the second auction: buyer2 participates and buys 42 with 3 eth
   * 
   * =======
   * todo1: write test when multiple buyers participate in the same auction. 
   * todo2: write test of buyer claiming oTokens after auction settlement
   * todo3: write test to cover cases where all the otoken are sold by the auction, and there are fees to consider.. etc
   * 
   */
  describe('profitable scenario', async () => {
    const p1DepositAmount = utils.parseEther('10');
    const p2DepositAmount = utils.parseEther('70');
    const minPremium = utils.parseEther('3');
    let totalAmountInVault: BigNumber;
    let actualAmountInVault: BigNumber;
    let otoken: IOToken;
    let expiry;
    let auctionId;
    let auction2Id;
    let auctionDeadline: number
    let auction2Deadline: number

    const buyer1BoughtAmount = 20 * 1e8 // 20 otoken
    const buyer1Premium = utils.parseEther('1')
    
    const buyer2BoughtAmount = 42 * 1e8 // 52 otoken
    const buyer2Premium = utils.parseEther('3')

    this.beforeAll('deploy otoken that will be sold', async () => {
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

    it('owner mints and starts auction', async () => {
      // increase time
      const minPeriod = await shortAuction.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);

      await vault.rollOver([(100 - reserveFactor) * 100]);

      const collateralAmount = totalAmountInVault.mul(100 - reserveFactor).div(100);

      actualAmountInVault = totalAmountInVault.sub(collateralAmount);

      // convert 1e18 to otoken amount (1e8)
      
      const sellAmount = collateralAmount.div(10000000000).toString();
      const mintAmount = sellAmount

      expect((await shortAuction.lockedAsset()).eq('0'), 'collateral should not be locked').to.be.true;

      const blockNumber = await provider.getBlockNumber();
      const block = await provider.getBlock(blockNumber);
      const currentTimestamp = block.timestamp;
      auctionDeadline = currentTimestamp + day * 1;

      const minimalBidAmountPerOrder = 0.1 * 1e8 // min bid each order: 0.1 otoken
      const minFundingThreshold = 0;

      const easyAuctionOTokenBefore = await otoken.balanceOf(easyAuctionAddress)

      // mint and sell 72 oTokens
      await shortAuction.mintAndStartAuction(
        collateralAmount,
        mintAmount,
        sellAmount,
        auctionDeadline, // order cancel deadline
        auctionDeadline,
        minPremium,
        minimalBidAmountPerOrder,
        minFundingThreshold,
        false
      );

      auctionId = await easyAuction.auctionCounter();      
      expect((await otoken.balanceOf(shortAuction.address)).isZero()).to.be.true
      const easyAuctionOTokenAfter = await otoken.balanceOf(easyAuctionAddress)
      expect(easyAuctionOTokenAfter.sub(easyAuctionOTokenBefore)).to.be.eq(sellAmount)
    });

    it('p1 participate in first auction', async() => {
      await weth.connect(buyer1).deposit({value: utils.parseEther('10')})
      await weth.connect(buyer1).approve(easyAuction.address, ethers.constants.MaxUint256)
      await easyAuction.connect(buyer1).registerUser(buyer1.address)
      
      await easyAuction.connect(buyer1).placeSellOrders(
        auctionId,
        [buyer1BoughtAmount], // 20 otoken
        [buyer1Premium], // 1 eth
        [QUEUE_START],
        '0x00'
      )
    })

    it('settle auction', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [auctionDeadline + 60]);
      await provider.send('evm_mine', []);

      const wethBalanceBefore = await weth.balanceOf(shortAuction.address)
      await easyAuction.connect(owner).settleAuction(auctionId)
      const wethBalanceAfter = await weth.balanceOf(shortAuction.address)
      expect(wethBalanceAfter.sub(wethBalanceBefore).eq(buyer1Premium)).to.be.true
    })

    it('buyer claim their tokens after auction', async() => {
      // const buyer1OtokenAfter = await otoken.balanceOf(buyer1.address)
    })

    it('can start another auction', async () => {
      const blockNumber = await provider.getBlockNumber();
      const block = await provider.getBlock(blockNumber);
      const currentTimestamp = block.timestamp;
      auction2Deadline = currentTimestamp + day * 1;

      const oTokenLeft = await otoken.balanceOf(shortAuction.address)
      
      const minimalBidAmountPerOrder = 0.1 * 1e8 // min bid each order: 0.1 otoken
      const minFundingThreshold = 0;

      await shortAuction.mintAndStartAuction(
        0, // no collateral,
        0,
        oTokenLeft,
        auction2Deadline, // order cancel deadline
        auction2Deadline,
        minPremium,
        minimalBidAmountPerOrder,
        minFundingThreshold,
        false
      )

      auction2Id = await easyAuction.auctionCounter()
    })

    it('p2 participate in second auction', async() => {
      await weth.connect(buyer2).deposit({value: utils.parseEther('10')})
      await weth.connect(buyer2).approve(easyAuction.address, ethers.constants.MaxUint256)
      await easyAuction.connect(buyer2).registerUser(buyer2.address)
      
      await easyAuction.connect(buyer2).placeSellOrders(
        auction2Id,
        [buyer2BoughtAmount], // 42 otoken
        [buyer2Premium], // 3 eth
        [QUEUE_START],
        '0x00'
      )
    })

    it('settle second auction', async () => {
      // increase time
      await provider.send('evm_setNextBlockTimestamp', [auction2Deadline + 60]);
      await provider.send('evm_mine', []);

      const wethBalanceBefore = await weth.balanceOf(shortAuction.address)
      await easyAuction.connect(owner).settleAuction(auction2Id)
      const wethBalanceAfter = await weth.balanceOf(shortAuction.address)
      expect(wethBalanceAfter.sub(wethBalanceBefore).eq(buyer2Premium)).to.be.true
    })
  });
});
