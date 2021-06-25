import { ethers, waffle } from "hardhat";
import { BigNumber, utils } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { getAirSwapOrder } from "../../utils/orders";
import {
  ShortPutWithETH,
  MockERC20,
  MockWhitelist,
  MockSwap,
  MockController,
  MockPool,
  MockOToken,
  MockWETH,
  MockCErc20,
  MockCEth,
  MockComptroller,
} from "../../../typechain";
import { parseUnits } from "@ethersproject/units";

import * as fs from "fs";
const mnemonic = fs.existsSync(".secret")
  ? fs.readFileSync(".secret").toString().trim()
  : "test test test test test test test test test test test junk";

enum ActionState {
  Idle,
  Committed,
  Activated,
}

describe("Short Put with ETH Action", function () {
  const provider = waffle.provider;

  const counterpartyWallet = ethers.Wallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/30");

  let action: ShortPutWithETH;
  // asset used by this action: in this case, weth
  let usdc: MockERC20;
  let weth: MockWETH;
  let cusdc: MockCErc20;
  let ceth: MockCEth;
  let comptroller: MockComptroller;
  let swap: MockSwap;

  let whitelist: MockWhitelist;
  let controller: MockController;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let vault: SignerWithAddress;

  let otoken1: MockOToken;
  let otoken1Expiry: BigNumber;
  const otoken1StrikePriceHumanReadable = 2000;
  const otoken1StrikePrice = otoken1StrikePriceHumanReadable * 1e8;

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
  });

  this.beforeAll("Deploy Mock contracts", async () => {
    const ERC20 = await ethers.getContractFactory("MockERC20");
    const WETH = await ethers.getContractFactory("MockWETH");

    weth = (await WETH.deploy()) as MockWETH;
    await weth.init("WETH", "WETH", 18);

    usdc = (await ERC20.deploy()) as MockERC20;
    await usdc.init("USDC", "USDC", 6);

    const MockCERC20Contract = await ethers.getContractFactory("MockCErc20");
    cusdc = (await MockCERC20Contract.deploy(usdc.address, "compound USDC", "cUSDC", 8)) as MockCErc20;

    await cusdc.setExchangeRate(240000000000000);

    const MockCETHContract = await ethers.getContractFactory("MockCEth");
    ceth = (await MockCETHContract.deploy()) as MockCEth;

    // once we mock ceth exchange rate
    // await ceth.setExchangeRate(249136934438441580419980843)

    const Swap = await ethers.getContractFactory("MockSwap");
    swap = (await Swap.deploy()) as MockSwap;

    // deploy mock swap and mock whitelist
    const Whitelist = await ethers.getContractFactory("MockWhitelist");
    whitelist = (await Whitelist.deploy()) as MockWhitelist;

    const MockPool = await ethers.getContractFactory("MockPool");
    pool = (await MockPool.deploy()) as MockPool;

    const Controller = await ethers.getContractFactory("MockController");
    controller = (await Controller.deploy()) as MockController;

    const Comptroller = await ethers.getContractFactory("MockComptroller");
    comptroller = (await Comptroller.deploy()) as MockComptroller;

    await controller.setPool(pool.address);
    await controller.setWhitelist(whitelist.address);
  });

  describe("deployment ", () => {
    it("deploy short put action example ", async () => {
      const ShortActionContract = await ethers.getContractFactory("ShortPutWithETH");
      action = (await ShortActionContract.deploy(
        vault.address,
        weth.address,
        ceth.address,
        usdc.address,
        cusdc.address,
        swap.address,
        controller.address,
        comptroller.address
      )) as ShortPutWithETH;

      expect((await action.owner()) == owner.address).to.be.true;

      expect((await action.asset()) === weth.address).to.be.true;

      expect(await controller.vaultOpened()).to.be.true;

      expect((await usdc.allowance(action.address, pool.address)).eq(ethers.constants.MaxUint256)).to.be.true;
      expect((await weth.allowance(action.address, vault.address)).eq(ethers.constants.MaxUint256)).to.be.true;

      // init state should be idle
      expect((await action.state()) === ActionState.Idle).to.be.true;
    });
  });

  const totalDepositInAction = utils.parseEther("20");

  describe("idle phase", () => {
    before("Mint some eth to action", async () => {
      // transfer 100 weth to the action contract
      await weth.deposit({ value: totalDepositInAction });
      await weth.transfer(action.address, totalDepositInAction);
    });
    before("mint some usdc to cUSDC contract", async () => {
      await usdc.mint(cusdc.address, 1000000 * 1e6);
    });
    before("Deploy mock otoken", async () => {
      const MockOToken = await ethers.getContractFactory("MockOToken");
      otoken1 = (await MockOToken.deploy()) as MockOToken;
      await otoken1.init("oWETHUSDC", "oWETHUSDC", 18);
      await otoken1.initMockOTokenDetail(
        weth.address,
        usdc.address,
        usdc.address,
        otoken1StrikePrice,
        otoken1Expiry,
        true
      );
    });
    it("should revert if calling mint + sell in idle phase", async () => {
      const wethSupply = utils.parseUnits("10");
      const amountOTokenToMintHumanReadable = 10;
      const usdcAmountToBorrow = otoken1StrikePriceHumanReadable * 1e6 * amountOTokenToMintHumanReadable;
      const amountOTokenToMint = amountOTokenToMintHumanReadable * 1e8;
      const premium = parseUnits("1");
      const order = await getAirSwapOrder(
        action.address,
        otoken1.address,
        amountOTokenToMint,
        counterpartyWallet.address,
        weth.address,
        premium.toString(),
        swap.address,
        counterpartyWallet.privateKey
      );
      await expect(
        action.connect(owner).borrowMintAndTradeOTC(wethSupply, usdcAmountToBorrow, amountOTokenToMint, order)
      ).to.be.revertedWith("!Activated");
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
    it("should execute the trade with borrowed eth", async () => {
      const wethSupply = utils.parseUnits("10");
      const amountOTokenToMintHumanReadable = 10;
      const usdcAmountToBorrow = otoken1StrikePriceHumanReadable * 1e6 * amountOTokenToMintHumanReadable;
      const amountOTokenToMint = amountOTokenToMintHumanReadable * 1e8;
      const premium = parseUnits("1");
      const order = await getAirSwapOrder(
        action.address,
        otoken1.address,
        amountOTokenToMint,
        counterpartyWallet.address,
        weth.address,
        premium.toString(),
        swap.address,
        counterpartyWallet.privateKey
      );
      await action.connect(owner).borrowMintAndTradeOTC(wethSupply, usdcAmountToBorrow, amountOTokenToMint, order);
      const counterPartyOToken = await otoken1.balanceOf(counterpartyWallet.address);
      expect(counterPartyOToken.eq(amountOTokenToMint)).to.be.true;
    });
    it("should not be able to commit next token", async () => {
      await expect(action.connect(owner).commitOToken(usdc.address)).to.be.revertedWith("Activated");
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
      await controller.setCollateralAsset(usdc.address);
      const actionBalanceBefore = await weth.balanceOf(action.address);

      // assume we get back full usdc
      const mockPayout = otoken1StrikePriceHumanReadable * 10 * 1e6;

      await controller.setSettlePayout(mockPayout);
      await action.connect(vault).closePosition();

      const wethSupplied = utils.parseUnits("10");
      const actionBalanceAfter = await weth.balanceOf(action.address);

      const amountGotBack = actionBalanceAfter.sub(actionBalanceBefore);

      expect(amountGotBack.eq(wethSupplied.mul(995).div(1000))).to.be.true;
      expect((await action.state()) === ActionState.Idle).to.be.true;
    });
  });
});
