import { ethers, waffle } from "hardhat";
import { utils } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { MockCErc20, MockCEth, MockComptroller, MockERC20, MockWETH, CompoundUtilsTester } from "../../../typechain";

describe("CompoundUtils", function () {
  let usdc: MockERC20;
  let weth: MockWETH;
  let cusdc: MockCErc20;
  let ceth: MockCEth;
  let comptroller: MockComptroller;

  let testerWithWETH: CompoundUtilsTester;
  let testerWithUSDC: CompoundUtilsTester;

  let account: SignerWithAddress;

  this.beforeAll("set accounts", async () => {
    const [_account1] = await ethers.getSigners();
    account = _account1;
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

    // mint usdc to cUSDC contract
    await usdc.mint(cusdc.address, "100000000000000000");

    // send eth to cETH contract
    account.sendTransaction({ to: ceth.address, value: utils.parseEther("5") });

    const ComptrollerContract = await ethers.getContractFactory("MockComptroller");
    comptroller = (await ComptrollerContract.deploy()) as MockComptroller;
  });

  describe("tester contract with WETH in it", () => {
    const ethAmount = utils.parseEther("10");
    const borrowAmount = 50 * 1e6;
    it("deploy tester and supply it with some WETH", async () => {
      const Tester = await ethers.getContractFactory("CompoundUtilsTester");
      testerWithWETH = (await Tester.deploy()) as CompoundUtilsTester;
      await testerWithWETH.initCompoundUtils(comptroller.address, weth.address, ceth.address);

      await weth.connect(account).deposit({ value: ethAmount });
      await weth.connect(account).transfer(testerWithWETH.address, ethAmount);
    });

    it("can supply WETH", async () => {
      await testerWithWETH.supplyWeth(ethAmount);
      const cTokenBalance = await ceth.balanceOf(testerWithWETH.address);
      expect(cTokenBalance.gt(0)).to.be.true;
    });

    it("can borrow USDC", async () => {
      await testerWithWETH.borrowERC20(cusdc.address, borrowAmount);
      const testerUSDC = await usdc.balanceOf(testerWithWETH.address);
      expect(testerUSDC.gt(0)).to.be.true;
    });

    it("can repay USDC", async () => {
      await testerWithWETH.repayERC20(usdc.address, cusdc.address, borrowAmount);
      const testerUSDC = await usdc.balanceOf(testerWithWETH.address);
      expect(testerUSDC.isZero()).to.be.true;
    });
    it("can redeem WETH", async () => {
      const cTokenBalance = await ceth.balanceOf(testerWithWETH.address);
      await testerWithWETH.redeemWETH(cTokenBalance);
      const wethBalance = await weth.balanceOf(testerWithWETH.address);
      expect(wethBalance.eq(ethAmount)).to.be.true;
    });
  });
  describe("tester contract with USDC in it", () => {
    const usdcAmount = 10000 * 1e6;
    const borrowAmount = utils.parseEther("0.5");
    it("deploy another tester and supply it with some USDC", async () => {
      const Tester = await ethers.getContractFactory("CompoundUtilsTester");
      testerWithUSDC = (await Tester.deploy()) as CompoundUtilsTester;
      await testerWithUSDC.initCompoundUtils(comptroller.address, weth.address, ceth.address);

      await usdc.connect(account).mint(testerWithUSDC.address, usdcAmount);
    });
    it("can supply USDC", async () => {
      await testerWithUSDC.supplyERC20(cusdc.address, usdc.address, usdcAmount);
      const cTokenBalance = await cusdc.balanceOf(testerWithUSDC.address);
      expect(cTokenBalance.gt(0)).to.be.true;
    });

    it("can borrow WETH", async () => {
      await testerWithUSDC.borrowWeth(borrowAmount);
      const testerWETH = await weth.balanceOf(testerWithUSDC.address);
      expect(testerWETH.eq(borrowAmount)).to.be.true;
    });

    it("can repay WETH", async () => {
      await testerWithUSDC.repayWETH(borrowAmount);
      const testerWETH = await weth.balanceOf(testerWithUSDC.address);
      expect(testerWETH.isZero()).to.be.true;
    });
    it("can redeem USDC", async () => {
      const cTokenBalance = await cusdc.balanceOf(testerWithUSDC.address);
      await testerWithUSDC.redeemERC20(cusdc.address, cTokenBalance);
      const usdcBalance = await usdc.balanceOf(testerWithUSDC.address);
      expect(usdcBalance.eq(usdcAmount)).to.be.true;
    });
  });
});
