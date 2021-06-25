import { ethers, waffle } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { getAirSwapOrder } from "../utils/orders";

import { expect } from "chai";
import {
  MockOToken,
  CTokenTreasury,
  LongOTokenWithCToken,
  MockERC20,
  OpynPerpVault,
  MockWETH,
  CTokenProxy,
  MockCErc20,
  MockSwap,
  MockController,
  MockWhitelist,
  MockOpynOracle,
  MockPool,
} from "../../typechain";
import { BigNumber } from "ethers";
import * as fs from "fs";

const mnemonic = fs.existsSync(".secret")
  ? fs.readFileSync(".secret").toString().trim()
  : "test test test test test test test test test test test junk";

enum VaultState {
  Locked,
  Unlocked,
  Emergency,
}

describe("PPN Vault", function () {
  const counterpartyWallet = ethers.Wallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/30");

  const provider = waffle.provider;

  const ethPrice = 2000 * 1e8;
  const putStrikePrice = 1800 * 1e8;

  // core components
  let proxy: CTokenProxy;
  let vault: OpynPerpVault;
  let action1: CTokenTreasury;
  let action2: LongOTokenWithCToken;

  // asset used by this action: in this case, weth
  let cusdc: MockCErc20;
  let weth: MockWETH;
  let usdc: MockERC20;

  let otoken1: MockOToken;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let optionSeller: SignerWithAddress;
  let feeRecipient: SignerWithAddress;

  // mock external contracts
  let swap: MockSwap;
  let controller: MockController;
  let whitelist: MockWhitelist;
  let oracle: MockOpynOracle;
  let pool: MockPool;

  this.beforeAll("Set accounts", async () => {
    accounts = await ethers.getSigners();
    const [_owner, _feeRecipient, _depositor1, _depositor2, _seller] = accounts;
    owner = _owner;
    feeRecipient = _feeRecipient;
    depositor1 = _depositor1;
    depositor2 = _depositor2;
    optionSeller = _seller;
  });

  this.beforeAll("Deploy Mock Token contracts", async () => {
    const MockWETHContract = await ethers.getContractFactory("MockWETH");
    weth = (await MockWETHContract.deploy()) as MockWETH;
    await weth.init("WETH", "WETH", 18);

    const ERC20 = await ethers.getContractFactory("MockERC20");
    usdc = (await ERC20.deploy()) as MockERC20;
    await usdc.init("USDC", "USDC", 6);

    // setup cusdc
    const MockCERC20Contract = await ethers.getContractFactory("MockCErc20");
    cusdc = (await MockCERC20Contract.deploy(usdc.address, "compound USDC", "cUSDC", 8)) as MockCErc20;

    await cusdc.setExchangeRate("240000000000000");
    await usdc.mint(cusdc.address, "1000000000000");
  });

  this.beforeAll("Deploy Mock external contracts", async () => {
    const Swap = await ethers.getContractFactory("MockSwap");
    swap = (await Swap.deploy()) as MockSwap;

    const Controller = await ethers.getContractFactory("MockController");
    controller = (await Controller.deploy()) as MockController;

    const Whitelist = await ethers.getContractFactory("MockWhitelist");
    whitelist = (await Whitelist.deploy()) as MockWhitelist;

    const MockPool = await ethers.getContractFactory("MockPool");
    pool = (await MockPool.deploy()) as MockPool;

    const MockOracle = await ethers.getContractFactory("MockOpynOracle");
    oracle = (await MockOracle.deploy()) as MockOpynOracle;

    await controller.setPool(pool.address);
    await controller.setWhitelist(whitelist.address);
    await controller.setOracle(oracle.address);

    await oracle.setAssetPrice(weth.address, ethPrice);

    await usdc.mint(pool.address, "1000000000000");
  });

  this.beforeAll("Mint USDC for participants", async () => {
    await usdc.mint(depositor1.address, 1000000 * 1e6);
    await usdc.mint(depositor2.address, 1000000 * 1e6);
  });

  this.beforeAll("Deploy vault and actions", async () => {
    const VaultContract = await ethers.getContractFactory("OpynPerpVault");
    vault = (await VaultContract.deploy()) as OpynPerpVault;

    const ProxyContract = await ethers.getContractFactory("CTokenProxy");
    proxy = (await ProxyContract.deploy(vault.address, usdc.address, cusdc.address)) as CTokenProxy;

    // deploy 2 mock actions
    const CTokenTreasuryContract = await ethers.getContractFactory("CTokenTreasury");
    action1 = (await CTokenTreasuryContract.deploy(vault.address, cusdc.address)) as CTokenTreasury;

    const LongOToken = await ethers.getContractFactory("LongOTokenWithCToken");
    action2 = (await LongOToken.deploy(
      vault.address,
      cusdc.address,
      usdc.address,
      action1.address, // treasury address
      swap.address,
      controller.address,
      true // put
    )) as LongOTokenWithCToken;
  });

  describe("init", async () => {
    it("should init the contract successfully", async () => {
      await vault
        .connect(owner)
        .init(cusdc.address, owner.address, feeRecipient.address, cusdc.address, 18, "PPN share", "sPPN", [
          action1.address,
          action2.address,
        ]);
      // init state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalAsset()).isZero(), "total asset should be zero").to.be.true;
    });
  });

  describe("Round 0, vault unlocked", async () => {
    const depositAmount = "10000000000"; // 10000 USDC

    it("unlocked state checks", async () => {
      expect(await vault.state()).to.eq(VaultState.Unlocked);
      expect(await vault.round()).to.eq(0);
    });
    it("should be able to deposit cUSDC", async () => {
      await usdc.connect(depositor1).approve(cusdc.address, ethers.constants.MaxUint256);
      await cusdc.connect(depositor1).mint(depositAmount);
      const cusdcBalance = await cusdc.balanceOf(depositor1.address);
      const shares1Before = await vault.balanceOf(depositor1.address);
      const expectedShares = await vault.getSharesByDepositAmount(cusdcBalance);

      // depositor 1 deposits 10000 cUSDC directly
      await cusdc.connect(depositor1).approve(vault.address, ethers.constants.MaxUint256);
      await vault.connect(depositor1).deposit(cusdcBalance);

      const shares1After = await vault.balanceOf(depositor1.address);
      expect(shares1After.sub(shares1Before).eq(expectedShares)).to.be.true;
    });

    it("should be able to deposit USDC through Proxy", async () => {
      await usdc.connect(depositor2).approve(proxy.address, ethers.constants.MaxUint256);
      // depositor 2 deposits 10000 USDC through proxy
      await proxy.connect(depositor2).depositUnderlying(depositAmount);
      const d2Shares = await vault.balanceOf(depositor2.address);
      const d1Shares = await vault.balanceOf(depositor1.address);
      expect(d2Shares.lt(d1Shares)).to.be.true;
    });

    it("should rollover to the first round without committing otoken", async () => {
      const vaultBalanceBefore = await cusdc.balanceOf(vault.address);
      const action1BalanceBefore = await cusdc.balanceOf(action1.address);
      const action2BalanceBefore = await cusdc.balanceOf(action2.address);
      const totalValueBefore = await vault.totalAsset();

      // Distribution:
      // 100% - action1
      // 0% - action2
      await vault.connect(owner).rollOver([10000, 0]);

      const vaultBalanceAfter = await cusdc.balanceOf(vault.address);
      const action1BalanceAfter = await cusdc.balanceOf(action1.address);
      const action2BalanceAfter = await cusdc.balanceOf(action2.address);
      const totalValueAfter = await vault.totalAsset();

      expect(action1BalanceAfter.sub(action1BalanceBefore).eq(vaultBalanceBefore)).to.be.true;
      expect(action2BalanceAfter.sub(action2BalanceBefore).isZero()).to.be.true;

      expect(vaultBalanceAfter.isZero()).to.be.true;
      expect(totalValueAfter.eq(totalValueBefore), "total value should stay unaffected").to.be.true;
    });
  });
  describe("Round 0, vault Locked", async () => {
    it("increase exchange rate over time", async () => {
      const oldExchangeRate = (await cusdc.exchangeRateStored()).toNumber();
      // cusdc value increase by 1%
      await cusdc.setExchangeRate(Math.floor(oldExchangeRate * 1.01));
    });
    it("should be able to close position, once there's interest to collect ", async () => {
      const vaultBalanceBefore = await cusdc.balanceOf(vault.address);
      const action1BalanceBefore = await cusdc.balanceOf(action1.address);

      await vault.connect(owner).closePositions();

      const vaultBalanceAfter = await cusdc.balanceOf(vault.address);
      const action1BalanceAfter = await cusdc.balanceOf(action1.address);
      expect(vaultBalanceAfter.sub(vaultBalanceBefore).eq(action1BalanceBefore.sub(action1BalanceAfter))).to.be.true;

      const profit = await action1.lastRoundProfit();
      expect(profit.gt(0)).to.be.true;
    });
  });

  describe("Round 1: vault Unlocked", async () => {
    it("should be able to commit to an otoken to buy with the interest", async () => {
      const blockNumber = await provider.getBlockNumber();
      const block = await provider.getBlock(blockNumber);
      const currentTimestamp = block.timestamp;
      const expiry = currentTimestamp + 86400 * 7;

      const MockOToken = await ethers.getContractFactory("MockOToken");
      otoken1 = (await MockOToken.deploy()) as MockOToken;
      await otoken1.init("oWETHUSDP", "oWETHUSDP", 18);
      await otoken1.initMockOTokenDetail(weth.address, usdc.address, usdc.address, putStrikePrice, expiry, true);

      await action2.connect(owner).commitOToken(otoken1.address);

      // pass commit period
      const minPeriod = await action2.MIN_COMMIT_PERIOD();
      await provider.send("evm_increaseTime", [minPeriod.toNumber()]); // increase time
      await provider.send("evm_mine", []);
    });
    it("should revert when trying to rollover with incorrect percentage", async () => {
      await expect(vault.connect(owner).rollOver([9850, 150])).to.be.revertedWith("too many cTokens");
    });
    it("should be able to rollover again", async () => {
      const action1BalanceBefore = await cusdc.balanceOf(action1.address);
      const action2BalanceBefore = await cusdc.balanceOf(action2.address);
      const totalValueBefore = await vault.totalAsset();
      // Distribution:
      // 99% - action1
      // 1% - action2
      await vault.connect(owner).rollOver([9900, 100]);

      const action1BalanceAfter = await cusdc.balanceOf(action1.address);
      const action2BalanceAfter = await cusdc.balanceOf(action2.address);

      expect(action1BalanceAfter.sub(action1BalanceBefore).eq(totalValueBefore.mul(99).div(100))).to.be.true;
      expect(action2BalanceAfter.sub(action2BalanceBefore).eq(totalValueBefore.mul(1).div(100))).to.be.true;
    });
  });

  describe("Round 1: vault Locked", async () => {
    it("should be able to buy otoken", async () => {
      const premium = 12 * 1e6; // 12 USD
      const buyAmount = 0.2 * 1e8;
      const order = await getAirSwapOrder(
        action2.address,
        usdc.address,
        premium,
        counterpartyWallet.address,
        otoken1.address,
        buyAmount,
        swap.address,
        counterpartyWallet.privateKey
      );

      const cTokenBefore = await cusdc.balanceOf(action2.address);
      await action2.connect(owner).tradeAirswapOTC(order);

      const cTokenAfter = await cusdc.balanceOf(action2.address);
      expect(cTokenBefore.gt(cTokenAfter)).to.be.true;
    });

    it("increase exchange rate over time", async () => {
      const oldExchangeRate = (await cusdc.exchangeRateStored()).toNumber();
      // cusdc value increase by 1%
      await cusdc.setExchangeRate(Math.floor(oldExchangeRate * 1.01));
    });

    it("should close a round with profit in cusdc", async () => {
      const payout = 100 * 1e6;

      const expiry = (await otoken1.expiryTimestamp()).toNumber();
      await provider.send("evm_setNextBlockTimestamp", [expiry + 60]);
      await provider.send("evm_mine", []);

      const totalAssetBefore = await vault.totalAsset();

      await controller.setRedeemPayout(usdc.address, payout);
      await vault.connect(owner).closePositions();

      const totalAssetAfter = await vault.totalAsset();
      expect(totalAssetAfter.gt(totalAssetBefore)).to.be.true;
    });
  });
});
