import { ethers, waffle } from "hardhat";
import { BigNumber, utils } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { getOrder } from "../utils/orders";
import {
  LongOToken,
  MockERC20,
  MockWhitelist,
  MockSwap,
  MockController,
  MockPool,
  MockOToken,
  MockOpynOracle,
  MockEasyAuction,
} from "../../typechain";
import * as fs from "fs";

const mnemonic = fs.existsSync(".secret")
  ? fs.readFileSync(".secret").toString().trim()
  : "test test test test test test test test test test test junk";

enum ActionState {
  Idle,
  Committed,
  Activated,
}

describe("LongAction: Buying Puts", function () {
  const provider = waffle.provider;

  const counterpartyWallet = ethers.Wallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/30");

  let action: LongOToken;
  // asset used by this action: in this case, weth
  let weth: MockERC20;
  //
  let usdc: MockERC20;

  // mock external contracts
  let swap: MockSwap;
  let auction: MockEasyAuction;

  let whitelist: MockWhitelist;
  let controller: MockController;
  let oracle: MockOpynOracle;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let vault: SignerWithAddress;

  let otokenBad: MockOToken;
  let otoken1: MockOToken;
  let otoken2: MockOToken;

  const wethPrice = 2500 * 1e8;
  const otokenBadStrikePrice = 2400 * 1e8; // strike too high
  const otoken1StrikePrice = 2000 * 1e8;
  const otoken2StrikePrice = 2100 * 1e8;

  let otoken1Expiry = BigNumber.from(0);
  let otoken2Expiry = BigNumber.from(0);

  // pretend to be gamma margin pool
  let pool: MockPool;

  this.beforeAll("Set accounts", async () => {
    accounts = await ethers.getSigners();
    const [_owner, _vault] = accounts;

    owner = _owner;
    vault = _vault;
  });

  this.beforeAll("Set timestamps", async () => {
    const blockNumber = await provider.getBlockNumber();
    const block = await provider.getBlock(blockNumber);
    const currentTimestamp = block.timestamp;
    // 7 days from now
    otoken1Expiry = BigNumber.from(parseInt(currentTimestamp.toString()) + 86400 * 7);
    otoken2Expiry = BigNumber.from(parseInt(currentTimestamp.toString()) + 86400 * 14);
  });

  this.beforeAll("Deploy Mock contracts", async () => {
    const ERC20 = await ethers.getContractFactory("MockERC20");
    weth = (await ERC20.deploy()) as MockERC20;
    await weth.init("WETH", "WETH", 18);

    usdc = (await ERC20.deploy()) as MockERC20;
    await usdc.init("USDC", "USDC", 6);

    // deploy mock swap and mock whitelist
    const Whitelist = await ethers.getContractFactory("MockWhitelist");
    whitelist = (await Whitelist.deploy()) as MockWhitelist;

    const Swap = await ethers.getContractFactory("MockSwap");
    swap = (await Swap.deploy()) as MockSwap;

    const Auction = await ethers.getContractFactory("MockEasyAuction");
    auction = (await Auction.deploy()) as MockEasyAuction;

    const MockPool = await ethers.getContractFactory("MockPool");
    pool = (await MockPool.deploy()) as MockPool;

    const MockOracle = await ethers.getContractFactory("MockOpynOracle");
    oracle = (await MockOracle.deploy()) as MockOpynOracle;

    const Controller = await ethers.getContractFactory("MockController");
    controller = (await Controller.deploy()) as MockController;

    await controller.setPool(pool.address);
    await controller.setWhitelist(whitelist.address);
    await controller.setOracle(oracle.address);
  });

  describe("deployment test", () => {
    it("deploy", async () => {
      const LongActionContract = await ethers.getContractFactory("LongOToken");
      action = (await LongActionContract.deploy(
        vault.address,
        usdc.address,
        swap.address,
        auction.address,
        controller.address
      )) as LongOToken;

      expect((await action.owner()) == owner.address).to.be.true;

      expect((await action.asset()) === usdc.address).to.be.true;

      expect((await usdc.allowance(action.address, vault.address)).eq(ethers.constants.MaxUint256)).to.be.true;

      // init state should be idle
      expect((await action.state()) === ActionState.Idle).to.be.true;

      // whitelist is set
      expect((await action.opynWhitelist()) === whitelist.address).to.be.true;
    });
  });

  const totalDepositInAction = 100000 * 1e6;

  describe("idle phase", () => {
    before("Mint some usdc to action", async () => {
      // mint 100000 usdc
      await usdc.mint(action.address, totalDepositInAction);
    });
    before("Deploy mock otokens", async () => {
      const MockOToken = await ethers.getContractFactory("MockOToken");
      otoken1 = (await MockOToken.deploy()) as MockOToken;
      await otoken1.init("oWETHUSDC-P", "oWETHUSDC-P", 18);
      await otoken1.initMockOTokenDetail(
        weth.address,
        usdc.address,
        usdc.address,
        otoken1StrikePrice,
        otoken1Expiry,
        true
      );

      otoken2 = (await MockOToken.deploy()) as MockOToken;
      await otoken2.init("oWETHUSDC-P", "oWETHUSDC-P", 18);
      await otoken2.initMockOTokenDetail(
        weth.address,
        usdc.address,
        usdc.address,
        otoken2StrikePrice,
        otoken2Expiry,
        true
      );

      otokenBad = (await MockOToken.deploy()) as MockOToken;
      await otokenBad.init("oWETHUSDC", "oWETHUSDC", 18);
      await otokenBad.initMockOTokenDetail(
        weth.address,
        usdc.address,
        usdc.address,
        otokenBadStrikePrice,
        otoken2Expiry,
        true
      );

      await oracle.setAssetPrice(weth.address, wethPrice); // 1000 USD
    });
    it("should revert if calling trade in idle phase", async () => {
      const premium = 5000 * 1e6;
      const buyAmount = 20 * 1e8;

      const order = await getOrder(
        action.address,
        usdc.address,
        premium,
        counterpartyWallet.address,
        otoken1.address,
        buyAmount,
        swap.address,
        counterpartyWallet.privateKey
      );
      await expect(action.connect(owner).tradeAirswapOTC(order)).to.be.revertedWith("!Activated");
    });
    it("should not be able to token with invalid strike price", async () => {
      await expect(action.connect(owner).commitOToken(otokenBad.address)).to.be.revertedWith("Bad Strike Price");
    });
    it("should be able to commit next token", async () => {
      await action.connect(owner).commitOToken(otoken1.address);
      expect((await action.nextOToken()) === otoken1.address);
      expect((await action.state()) === ActionState.Committed).to.be.true;
    });
    it("should revert if the vault is trying to rollover before min commit period is spent", async () => {
      await expect(action.connect(vault).rolloverPosition()).to.be.revertedWith("COMMIT_PHASE_NOT_OVER");
    });
  });

  describe("activating the action", () => {
    before("increase blocktime to get it over with minimal commit period", async () => {
      const minPeriod = await action.MIN_COMMIT_PERIOD();
      await provider.send("evm_increaseTime", [minPeriod.toNumber()]); // increase time
      await provider.send("evm_mine", []);
    });
    it("should revert if the vault is trying to rollover from non-vault address", async () => {
      await expect(action.connect(owner).rolloverPosition()).to.be.revertedWith("!VAULT");
    });
    it("should be able to roll over the position", async () => {
      await action.connect(vault).rolloverPosition();

      expect((await action.nextOToken()) === ethers.constants.AddressZero);
    });
    it("should get currentValue as total amount in gamma as ", async () => {
      expect((await action.currentValue()).eq(totalDepositInAction)).to.be.true;
    });
    describe("long with AirSwap", async () => {
      before("mint some option ", async () => {
        await otoken1.connect(owner).mint(counterpartyWallet.address, 20 * 1e8);
      });
      it("should be able to buy in this phase", async () => {
        const premium = 5000 * 1e6;
        const buyAmount = 20 * 1e8;
        const order = await getOrder(
          action.address,
          usdc.address,
          premium,
          counterpartyWallet.address,
          otoken1.address,
          buyAmount,
          swap.address,
          counterpartyWallet.privateKey
        );

        const usdcBalanceBefore = await usdc.balanceOf(action.address);
        await action.connect(owner).tradeAirswapOTC(order);
        const usdcBalanceAfter = await usdc.balanceOf(action.address);
        console.log(`usdcBalanceAfter`);
        expect(usdcBalanceBefore.sub(usdcBalanceAfter).eq(premium)).to.be.true;
      });
      it("should revert when trying to fill wrong order", async () => {
        const premium = 5000 * 1e6;
        const buyAmount = 20 * 1e8;
        const badOrder1 = await getOrder(
          action.address,
          weth.address, // this is wong
          premium,
          counterpartyWallet.address,
          otoken1.address,
          buyAmount,
          swap.address,
          counterpartyWallet.privateKey
        );
        await expect(action.connect(owner).tradeAirswapOTC(badOrder1)).to.be.revertedWith("Can only pay with asset");

        const badOrder2 = await getOrder(
          action.address,
          usdc.address,
          premium,
          counterpartyWallet.address,
          otoken2.address, // this is wrong
          buyAmount,
          swap.address,
          counterpartyWallet.privateKey
        );
        await expect(action.connect(owner).tradeAirswapOTC(badOrder2)).to.be.revertedWith("Can only buy otoken");
      });
    });
    // describe("short by starting an EasyAuction", async () => {
    //   let auctionDeadline: number;

    //   it("should be able to mint and start an auction phase", async () => {
    //     const collateralAmount = utils.parseUnits("10");
    //     const auctionOtokenBalanceBefore = await otoken1.balanceOf(auction.address);
    //     const mintAmount = 10 * 1e8;
    //     const sellAmount = 5 * 1e8;
    //     const minPremium = utils.parseUnits("1"); // 1 eth min premium

    //     const blockNumber = await provider.getBlockNumber();
    //     const block = await provider.getBlock(blockNumber);
    //     const currentTimestamp = block.timestamp;
    //     auctionDeadline = currentTimestamp + 86400 * 1;

    //     const minimalBidAmountPerOrder = 0.1 * 1e8; // min bid each order: 0.1 otoken
    //     const minFundingThreshold = 0;

    //     await action.connect(owner).mintAndStartAuction(
    //       collateralAmount,
    //       mintAmount,
    //       sellAmount,
    //       auctionDeadline, // order cancel deadline
    //       auctionDeadline,
    //       minPremium,
    //       minimalBidAmountPerOrder,
    //       minFundingThreshold,
    //       false
    //     );
    //     const auctionOtokenBalanceAfter = await otoken1.balanceOf(auction.address);
    //     expect(auctionOtokenBalanceAfter.sub(auctionOtokenBalanceBefore).eq(sellAmount)).to.be.true;
    //   });

    //   it("should start another auction with otoken left in the contract", async () => {
    //     const collateralAmount = 0;
    //     const auctionOtokenBalanceBefore = await otoken1.balanceOf(auction.address);
    //     const mintAmount = 0;
    //     const sellAmount = 5 * 1e8;
    //     const minPremium = utils.parseUnits("1"); // 1 eth min premium

    //     const blockNumber = await provider.getBlockNumber();
    //     const block = await provider.getBlock(blockNumber);
    //     const currentTimestamp = block.timestamp;
    //     auctionDeadline = currentTimestamp + 86400 * 1;

    //     const minimalBidAmountPerOrder = 0.1 * 1e8; // min bid each order: 0.1 otoken
    //     const minFundingThreshold = 0;

    //     await action
    //       .connect(owner)
    //       .mintAndStartAuction(
    //         collateralAmount,
    //         mintAmount,
    //         sellAmount,
    //         auctionDeadline,
    //         auctionDeadline,
    //         minPremium,
    //         minimalBidAmountPerOrder,
    //         minFundingThreshold,
    //         false
    //       );
    //     const auctionOtokenBalanceAfter = await otoken1.balanceOf(auction.address);
    //     expect(auctionOtokenBalanceAfter.sub(auctionOtokenBalanceBefore).eq(sellAmount)).to.be.true;
    //   });

    //   it('can short by participate in a "buy otoken auction"', async () => {
    //     const blockNumber = await provider.getBlockNumber();
    //     const block = await provider.getBlock(blockNumber);
    //     const currentTimestamp = block.timestamp;
    //     const auctionDeadline = currentTimestamp + 86400 * 1;
    //     // buyer create an auction to use 5 eth to buy 60 otokens
    //     const buyer = accounts[3];
    //     const sellAmount = utils.parseUnits("5");
    //     await token.mint(buyer.address, sellAmount);
    //     await token.connect(buyer).approve(auction.address, sellAmount);
    //     await auction.connect(buyer).initiateAuction(
    //       token.address,
    //       otoken1.address,
    //       auctionDeadline,
    //       auctionDeadline,
    //       sellAmount,
    //       60 * 1e8, // mint buy amount
    //       1e6, // minimumBiddingAmountPerOrder
    //       0, // minFundingThreshold
    //       false, // isAtomicClosureAllowed
    //       ethers.constants.AddressZero, // accessManagerContract
    //       "0x00" // accessManagerContractData
    //     );

    //     const auctionIdToParticipate = await auction.auctionCounter();

    //     // the action participate in the action
    //     const collateralAmount = utils.parseUnits("5");
    //     const mintAmount = 5 * 1e8;
    //     const minPremium = utils.parseUnits("0.2");

    //     const auctionOtokenBalanceBefore = await otoken1.balanceOf(auction.address);
    //     await action
    //       .connect(owner)
    //       .mintAndBidInAuction(
    //         auctionIdToParticipate,
    //         collateralAmount,
    //         mintAmount,
    //         [minPremium],
    //         [mintAmount],
    //         ["0x0000000000000000000000000000000000000000000000000000000000000001"],
    //         "0x00"
    //       );
    //     const auctionOtokenBalanceAfter = await otoken1.balanceOf(auction.address);
    //     expect(auctionOtokenBalanceAfter.sub(auctionOtokenBalanceBefore).eq(mintAmount)).to.be.true;
    //   });
    // });
    it("should not be able to commit next token", async () => {
      await expect(action.connect(owner).commitOToken(otoken2.address)).to.be.revertedWith("Activated");
    });
    it("should revert if the vault is trying to rollover", async () => {
      await expect(action.connect(vault).rolloverPosition()).to.be.revertedWith("!COMMITED");
    });
  });

  describe("close position", () => {
    before("increase blocktime to otoken expiry", async () => {
      await provider.send("evm_setNextBlockTimestamp", [otoken1Expiry.toNumber()]);
      await provider.send("evm_mine", []);
    });
    it("should revert if the vault is trying to close from non-vault address", async () => {
      await expect(action.connect(owner).closePosition()).to.be.revertedWith("!VAULT");
    });
    it("should be able to close the position", async () => {
      const actionBalanceBefore = await usdc.balanceOf(action.address);
      const redeemPayout = 4000 * 1e6;

      // mock payout asset
      await usdc.mint(pool.address, redeemPayout);
      await controller.setRedeemPayout(usdc.address, redeemPayout);

      await action.connect(vault).closePosition();
      const actionBalanceAfter = await usdc.balanceOf(action.address);
      expect(actionBalanceAfter.sub(actionBalanceBefore).eq(redeemPayout)).to.be.true;
      expect((await action.state()) === ActionState.Idle).to.be.true;
    });
    it("should revert if calling mint in idle phase", async () => {
      const premium = 5000 * 1e6;
      const buyAmount = 20 * 1e8;
      const order = await getOrder(
        action.address,
        usdc.address,
        premium,
        counterpartyWallet.address,
        otoken1.address,
        buyAmount,
        swap.address,
        counterpartyWallet.privateKey
      );
      await expect(action.connect(owner).tradeAirswapOTC(order)).to.be.revertedWith("!Activated");
    });
  });
});
