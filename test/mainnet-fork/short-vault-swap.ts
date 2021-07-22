import { ethers } from "hardhat";
import { utils, providers, constants } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import {
  MockERC20,
  OpynPerpVault,
  IWETH,
  IOtokenFactory,
  IOToken,
  MockPricer,
  IOracle,
  ShortOToken,
} from "../../typechain";
import * as fs from "fs";
import { getAirSwapOrder } from "../utils/orders";

const mnemonic = fs.existsSync(".secret")
  ? fs.readFileSync(".secret").toString().trim()
  : "test test test test test test test test test test test junk";

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

describe("Mainnet: Short Call with Airswap", function () {
  let counterpartyWallet = ethers.Wallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/30");
  let action1: ShortOToken;
  // asset used by this action: in this case, weth
  let weth: IWETH;
  let usdc: MockERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let random: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  let pricer: MockPricer;
  let oracle: IOracle;
  let provider: providers.JsonRpcProvider;

  /**
   *
   * CONSTANTS
   *
   */
  const day = 86400;
  const controllerAddress = "0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72";
  const swapAddress = "0x4572f2554421Bd64Bef1c22c8a81840E8D496BeA";
  const oracleAddress = "0x789cD7AB3742e23Ce0952F6Bc3Eb3A73A0E08833";
  const opynOwner = "0x638E5DA0EEbbA58c67567bcEb4Ab2dc8D34853FB";
  const otokenFactoryAddress = "0x7C06792Af1632E77cb27a558Dc0885338F4Bdf8E";
  const usdcAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const wethAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

  /**
   *
   * Setup
   *
   */

  this.beforeAll("Set accounts", async () => {
    accounts = await ethers.getSigners();
    const [_owner, _feeRecipient, _depositor1, _depositor2, _depositor3, _random] = accounts;

    owner = _owner;
    feeRecipient = _feeRecipient;

    depositor1 = _depositor1;
    depositor2 = _depositor2;
    depositor3 = _depositor3;
    random = _random;
  });

  this.beforeAll("Connect to mainnet contracts", async () => {
    weth = (await ethers.getContractAt("IWETH", wethAddress)) as IWETH;
    usdc = (await ethers.getContractAt("MockERC20", usdcAddress)) as MockERC20;
    otokenFactory = (await ethers.getContractAt("IOtokenFactory", otokenFactoryAddress)) as IOtokenFactory;
    oracle = (await ethers.getContractAt("IOracle", oracleAddress)) as IOracle;
  });

  this.beforeAll("Deploy vault and sell ETH calls action", async () => {
    const VaultContract = await ethers.getContractFactory("OpynPerpVault");
    vault = (await VaultContract.deploy()) as OpynPerpVault;

    // deploy the short action contract
    const ShortActionContract = await ethers.getContractFactory("ShortOToken");
    action1 = (await ShortActionContract.deploy(
      vault.address,
      weth.address,
      swapAddress,
      ethers.constants.AddressZero,
      controllerAddress,
      0 // type 0 vault
    )) as ShortOToken;

    await vault
      .connect(owner)
      .init(weth.address, owner.address, feeRecipient.address, weth.address, 18, "OpynPerpShortVault share", "sOPS", [
        action1.address,
      ]);
  });

  this.beforeAll("Deploy pricer and update pricer in opyn's oracle", async () => {
    provider = ethers.provider;

    const PricerContract = await ethers.getContractFactory("MockPricer");
    pricer = (await PricerContract.deploy(oracleAddress)) as MockPricer;

    // impersonate owner and change the pricer
    await owner.sendTransaction({ to: opynOwner, value: utils.parseEther("1.0") });
    await provider.send("hardhat_impersonateAccount", [opynOwner]);
    const signer = await ethers.provider.getSigner(opynOwner);
    await oracle.connect(signer).setAssetPricer(weth.address, pricer.address);
    await provider.send("evm_mine", []);
    await provider.send("hardhat_stopImpersonatingAccount", [opynOwner]);
  });

  describe("check the admin setup", async () => {
    it("contract is initialized correctly", async () => {
      // initial state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalAsset()).isZero(), "total asset should be zero").to.be.true;
      expect((await vault.WETH()) === weth.address).to.be.true;
    });
  });

  describe("profitable scenario", async () => {
    const p1DepositAmount = utils.parseEther("10");
    const p2DepositAmount = utils.parseEther("70");
    const premium = utils.parseEther("1");
    let otoken: IOToken;
    let expiry: number;
    this.beforeAll("deploy otoken that will be sold and set up counterparty", async () => {
      const otokenStrikePrice = 500000000000;
      const blockNumber = await provider.getBlockNumber();
      const block = await provider.getBlock(blockNumber);
      const currentTimestamp = block.timestamp;
      expiry = (Math.floor(currentTimestamp / day) + 10) * day + 28800;

      await otokenFactory.createOtoken(weth.address, usdc.address, weth.address, otokenStrikePrice, expiry, false);

      const otokenAddress = await otokenFactory.getOtoken(
        weth.address,
        usdc.address,
        weth.address,
        otokenStrikePrice,
        expiry,
        false
      );

      otoken = (await ethers.getContractAt("IOToken", otokenAddress)) as IOToken;

      // prepare counterparty
      counterpartyWallet = counterpartyWallet.connect(provider);
      await owner.sendTransaction({ to: counterpartyWallet.address, value: utils.parseEther("2") });
      await weth.connect(counterpartyWallet).deposit({ value: premium });
      await weth.connect(counterpartyWallet).approve(swapAddress, premium);
    });
    it("p1 deposits", async () => {
      await weth.connect(depositor1).deposit({ value: p1DepositAmount });
      await weth.connect(depositor1).approve(vault.address, constants.MaxUint256);
      await vault.connect(depositor1).deposit(p1DepositAmount);
      expect((await vault.totalAsset()).eq(p1DepositAmount), "total asset should update").to.be.true;
      expect(await weth.balanceOf(vault.address)).to.be.equal(p1DepositAmount);
    });

    it("p2 deposits", async () => {
      const existingAmount = await weth.balanceOf(vault.address);
      await weth.connect(depositor2).deposit({ value: p2DepositAmount });
      await weth.connect(depositor2).approve(vault.address, constants.MaxUint256);
      await vault.connect(depositor2).deposit(p2DepositAmount);
      const newBalance = existingAmount.add(p2DepositAmount);
      expect((await vault.totalAsset()).eq(newBalance), "total asset should update").to.be.true;
      expect(await weth.balanceOf(vault.address)).to.be.equal(newBalance);
    });

    it("owner commits to the option", async () => {
      // set live price as 3000
      await pricer.setPrice("300000000000");
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitOToken(otoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });

    it("owner mints and sells options", async () => {
      // increase time
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send("evm_increaseTime", [minPeriod.toNumber()]); // increase time
      await provider.send("evm_mine", []);

      await vault.rollOver([10000]);

      const collateralAmount = await weth.balanceOf(action1.address);

      const sellAmount = collateralAmount.div(10000000000).toNumber();

      const order = await getAirSwapOrder(
        action1.address,
        otoken.address,
        sellAmount,
        counterpartyWallet.address,
        weth.address,
        premium.toString(),
        swapAddress,
        counterpartyWallet.privateKey
      );

      expect((await action1.lockedAsset()).eq("0"), "collateral should not be locked").to.be.true;

      await action1.mintAndTradeAirSwapOTC(collateralAmount, sellAmount, order);

      expect(await otoken.balanceOf(counterpartyWallet.address)).to.be.equal(sellAmount);
      expect(await weth.balanceOf(action1.address)).to.be.equal(premium);
      expect((await action1.lockedAsset()).eq(collateralAmount), "collateral should be locked").to.be.true;
    });

    it("option expires", async () => {
      // increase time
      await provider.send("evm_setNextBlockTimestamp", [expiry + day]);
      await provider.send("evm_mine", []);

      // set settlement price
      await pricer.setExpiryPriceInOracle(weth.address, expiry, "200000000000");

      // increase time
      await provider.send("evm_increaseTime", [day]); // increase time
      await provider.send("evm_mine", []);

      await vault.closePositions();

      expect((await action1.lockedAsset()).eq("0"), "all collateral should be unlocked").to.be.true;
    });

    // it("p1 withdraws", async () => {
    //   const denominator = p1DepositAmount.add(p2DepositAmount);
    //   const shareOfPremium = p1DepositAmount.mul(premium).div(denominator);
    //   const amountToWithdraw = p1DepositAmount.add(shareOfPremium);
    //   const fee = amountToWithdraw.mul(5).div(1000);
    //   const amountTransferredToP1 = amountToWithdraw.sub(fee);

    //   const balanceOfFeeRecipientBefore = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP1Before = await weth.balanceOf(depositor1.address);

    //   await vault.connect(depositor1).withdraw(await vault.balanceOf(depositor1.address));

    //   const balanceOfFeeRecipientAfter = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP1After = await weth.balanceOf(depositor1.address);

    //   expect(balanceOfFeeRecipientBefore.add(fee)).to.be.equal(balanceOfFeeRecipientAfter);
    //   expect(balanceOfP1Before.add(amountTransferredToP1)).to.be.equal(balanceOfP1After);
    // });

    // it("p2 withdraws", async () => {
    //   const denominator = p1DepositAmount.add(p2DepositAmount);
    //   const shareOfPremium = p2DepositAmount.mul(premium).div(denominator);
    //   const amountToWithdraw = p2DepositAmount.add(shareOfPremium);

    //   const balanceOfFeeRecipientBefore = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP2Before = await weth.balanceOf(depositor2.address);

    //   await vault.connect(depositor2).withdraw(await vault.balanceOf(depositor2.address));

    //   const balanceOfFeeRecipientAfter = await weth.balanceOf(feeRecipient.address);
    //   const balanceOfP2After = await weth.balanceOf(depositor2.address);

    //   expect(balanceOfFeeRecipientBefore.add(fee)).to.be.equal(balanceOfFeeRecipientAfter);
    //   expect(balanceOfP2Before.add(amountTransferredToP2)).to.be.equal(balanceOfP2After);
    // });
  });
});
