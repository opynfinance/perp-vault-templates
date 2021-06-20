import { ethers } from "hardhat";
import { utils, Wallet, constants } from "ethers";
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
  LongOToken,
  IController,
} from "../../typechain";
import * as fs from "fs";
import { get0xLimitOrder, get0xRFQOrder } from "../utils/orders";
import { parseUnits } from "ethers/lib/utils";

const PROTOCOL_FEE_MULTIPLIER = 70000;

enum ActionType {
  OpenVault,
  MintShortOption,
  BurnShortOption,
  DepositLongOption,
  WithdrawLongOption,
  DepositCollateral,
  WithdrawCollateral,
  SettleVault,
  Redeem,
  Call,
  InvalidAction,
}

const mnemonic = fs.existsSync(".secret")
  ? fs.readFileSync(".secret").toString().trim()
  : "test test test test test test test test test test test junk";

enum ActionState {
  Idle,
  Committed,
  Activated,
}

describe("Mainnet: Long ETH Call with 0x RFQ", function () {
  let counterpartyWallet: Wallet = ethers.Wallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/30");
  let action1: LongOToken;
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
  let controller: IController;

  /**
   *
   * CONSTANTS
   *
   */
  const day = 86400;
  const controllerAddress = "0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72";
  const swapAddress = "0x4572f2554421Bd64Bef1c22c8a81840E8D496BeA";
  const zeroXExchange = "0xdef1c0ded9bec7f1a1670819833240f027b25eff";
  const oracleAddress = "0xc497f40D1B7db6FA5017373f1a0Ec6d53126Da23";
  const opynOwner = "0x638E5DA0EEbbA58c67567bcEb4Ab2dc8D34853FB";
  const otokenFactoryAddress = "0x7C06792Af1632E77cb27a558Dc0885338F4Bdf8E";
  const usdcAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const wethAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const easyAuctionAddress = "0x0b7fFc1f4AD541A4Ed16b40D8c37f0929158D101";
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
    controller = (await ethers.getContractAt("IController", controllerAddress)) as IController;
  });

  this.beforeAll("Deploy vault and long action to long eth call", async () => {
    const VaultContract = await ethers.getContractFactory("OpynPerpVault");
    vault = (await VaultContract.deploy()) as OpynPerpVault;

    // deploy the short action contract
    const LongOTokenContract = await ethers.getContractFactory("LongOToken");
    action1 = (await LongOTokenContract.deploy(
      vault.address,
      weth.address,
      swapAddress,
      zeroXExchange,
      easyAuctionAddress,
      controllerAddress
    )) as LongOToken;

    await vault
      .connect(owner)
      .init(weth.address, owner.address, feeRecipient.address, weth.address, 18, "OpynPerpLongVault share", "sOPS", [
        action1.address,
      ]);
  });

  this.beforeAll("Deploy pricer and update pricer in opyn's oracle", async () => {
    const provider = ethers.provider;

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

  describe("profitable scenario", async () => {
    const p1DepositAmount = utils.parseEther("10");
    const premium = 1e18; // utils.parseEther("1");

    let otoken: IOToken;
    let expiry: number;

    const otokenAmount = 5 * 1e8;
    const collateralAmount = utils.parseEther("5");

    this.beforeAll("deploy otoken that will be bought ", async () => {
      const provider = ethers.provider;
      const otokenStrikePrice = 4000 * 1e8;

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
    });

    this.beforeAll("mint otoken from counterparty wallet", async () => {
      const provider = ethers.provider;
      // prepare counterparty: minting 10 calls
      counterpartyWallet = counterpartyWallet.connect(provider);
      // send 20 eth to counter party
      await owner.sendTransaction({ to: counterpartyWallet.address, value: utils.parseEther("20") });

      await weth.connect(counterpartyWallet).deposit({ value: collateralAmount });

      const poolAddress = await controller.pool();
      await weth.connect(counterpartyWallet).approve(poolAddress, constants.MaxUint256);

      const actionArgs = [
        {
          actionType: ActionType.OpenVault,
          owner: counterpartyWallet.address,
          secondAddress: constants.AddressZero,
          asset: constants.AddressZero,
          vaultId: "1",
          amount: "0",
          index: "0",
          data: constants.AddressZero,
        },
        {
          actionType: ActionType.MintShortOption,
          owner: counterpartyWallet.address,
          secondAddress: counterpartyWallet.address,
          asset: otoken.address,
          vaultId: 1,
          amount: otokenAmount,
          index: "0",
          data: constants.AddressZero,
        },
        {
          actionType: ActionType.DepositCollateral,
          owner: counterpartyWallet.address,
          secondAddress: counterpartyWallet.address,
          asset: weth.address,
          vaultId: 1,
          amount: collateralAmount,
          index: "0",
          data: constants.AddressZero,
        },
      ];

      await controller.connect(counterpartyWallet).operate(actionArgs);
      await otoken.connect(counterpartyWallet).approve(zeroXExchange, constants.MaxUint256);
    });
    it("p1 deposits", async () => {
      await vault.connect(depositor1).depositETH({ value: p1DepositAmount });
      expect((await vault.totalAsset()).eq(p1DepositAmount), "total asset should update").to.be.true;
      expect(await weth.balanceOf(vault.address)).to.be.equal(p1DepositAmount);
    });

    it("owner commits to the option", async () => {
      // set live price as 3000
      await pricer.setPrice(3000 * 1e8);
      expect(await action1.state()).to.be.equal(ActionState.Idle);
      await action1.commitOToken(otoken.address);
      expect(await action1.state()).to.be.equal(ActionState.Committed);
    });
    it("rollover", async () => {
      // increase time
      const provider = ethers.provider;
      const minPeriod = await action1.MIN_COMMIT_PERIOD();
      await provider.send("evm_increaseTime", [minPeriod.toNumber()]); // increase time
      await provider.send("evm_mine", []);

      await vault.rollOver([10000]);
    });

    it("owner buys options with Limit Order", async () => {
      // sell half of otoken with limit order

      const order = await get0xLimitOrder(
        otoken.address, // maker token
        weth.address, // taker token
        otokenAmount / 2, // maker amount
        premium / 2, // taker amount
        counterpartyWallet.address,
        counterpartyWallet.privateKey
      );
      const gasPriceWei = parseUnits("50", "gwei");
      const balanceBefore = await weth.balanceOf(counterpartyWallet.address);

      await action1.connect(owner).trade0xLimit(order, order.signature, premium.toString(), {
        value: gasPriceWei.mul(PROTOCOL_FEE_MULTIPLIER),
        gasPrice: gasPriceWei,
      });

      const balanceAfter = await weth.balanceOf(counterpartyWallet.address);
      expect(balanceAfter.sub(balanceBefore).eq((premium / 2).toString())).to.be.true;
    });

    it("owner buys options with RFQ Order", async () => {
      const balanceBefore = await weth.balanceOf(counterpartyWallet.address);
      const oTokenBalanceBefore = await otoken.balanceOf(counterpartyWallet.address);
      const order = await get0xRFQOrder(
        otoken.address, // maker token
        weth.address, // taker token
        otokenAmount / 2, // maker amount
        premium / 2,
        counterpartyWallet.address,
        owner.address, // tx origin
        counterpartyWallet.privateKey
      );
      await action1.connect(owner).trade0xRFQ(order, order.signature, premium.toString());

      const balanceAfter = await weth.balanceOf(counterpartyWallet.address);
      const oTokenBalanceAfter = await otoken.balanceOf(counterpartyWallet.address);
      expect(balanceAfter.sub(balanceBefore).eq((premium / 2).toString())).to.be.true;
      expect(oTokenBalanceBefore.sub(oTokenBalanceAfter).eq((otokenAmount / 2).toString()));
    });
  });
});
