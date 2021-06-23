import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
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
} from "../../typechain";

enum VaultState {
  Locked,
  Unlocked,
  Emergency,
}

describe("PPN Vault", function () {
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

    await cusdc.setExchangeRate(240000000000000);
  });

  this.beforeAll("Deploy Mock external contracts", async () => {
    const Swap = await ethers.getContractFactory("MockSwap");
    swap = (await Swap.deploy()) as MockSwap;

    const Controller = await ethers.getContractFactory("MockController");
    controller = (await Controller.deploy()) as MockController;
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
      swap.address,
      controller.address,
      false
    )) as LongOTokenWithCToken;
  });

  describe("init", async () => {
    it("should init the contract successfully", async () => {
      await vault
        .connect(owner)
        .init(cusdc.address, owner.address, feeRecipient.address, weth.address, 18, "PPN share", "sPPN", [
          action1.address,
          action2.address,
        ]);
      // init state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalAsset()).isZero(), "total asset should be zero").to.be.true;
    });
  });

  describe("Round 0, vault unlocked", async () => {
    const depositAmount = "1000000000"; // 1000 USDC

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

      // depositor 1 deposits 1000 cUSDC directly
      await cusdc.connect(depositor1).approve(vault.address, ethers.constants.MaxUint256);
      await vault.connect(depositor1).deposit(cusdcBalance);

      const shares1After = await vault.balanceOf(depositor1.address);
      expect(shares1After.sub(shares1Before).eq(expectedShares)).to.be.true;
    });

    it("should be able to deposit USDC through Proxy", async () => {
      await usdc.connect(depositor2).approve(proxy.address, ethers.constants.MaxUint256);
      // depositor 2 deposits 1000 USDC through proxy
      await proxy.connect(depositor2).depositUnderlying(depositAmount);
      const d2Shares = await vault.balanceOf(depositor2.address);
      const d1Shares = await vault.balanceOf(depositor1.address);
      expect(d2Shares.lt(d1Shares)).to.be.true;
    });

    it("should rollover to the first round without committing otoken", async () => {
      const vaultBalanceBefore = await weth.balanceOf(vault.address);
      const action1BalanceBefore = await weth.balanceOf(action1.address);
      const action2BalanceBefore = await weth.balanceOf(action2.address);
      const totalValueBefore = await vault.totalAsset();

      // Distribution:
      // 100% - action1
      // 0% - action2
      await vault.connect(owner).rollOver([10000, 0]);

      const vaultBalanceAfter = await weth.balanceOf(vault.address);
      const action1BalanceAfter = await weth.balanceOf(action1.address);
      const action2BalanceAfter = await weth.balanceOf(action2.address);
      const totalValueAfter = await vault.totalAsset();

      expect(action1BalanceAfter.sub(action1BalanceBefore).eq(vaultBalanceBefore)).to.be.true;
      expect(action2BalanceAfter.sub(action2BalanceBefore).isZero()).to.be.true;

      expect(vaultBalanceAfter.isZero()).to.be.true;
      expect(totalValueAfter.eq(totalValueBefore), "total value should stay unaffected").to.be.true;
    });
  });
  // describe("Round 0, vault Locked", async () => {
  //   const depositAmount = utils.parseUnits("10");
  //   it("locked state checks", async () => {
  //     expect(await vault.state()).to.eq(VaultState.Locked);
  //     expect(await vault.round()).to.eq(0);
  //   });
  //   it("should revert when trying to call rollover again", async () => {
  //     await expect(vault.connect(owner).rollOver([6000, 4000])).to.be.revertedWith("!Unlocked");
  //   });
  //   it("should revert when trying to withdraw", async () => {
  //     const depositor1Shares = await vault.balanceOf(depositor1.address);
  //     await vault.connect(depositor1).approve(proxy.address, constants.MaxUint256);
  //     await expect(proxy.connect(depositor1).withdrawETH(depositor1Shares)).to.be.revertedWith("!Unlocked");

  //     await expect(vault.connect(depositor1).withdraw(depositor1Shares)).to.be.revertedWith("!Unlocked");
  //   });
  //   it("should revert when trying to deposit", async () => {
  //     await expect(vault.connect(depositor1).deposit(depositAmount)).to.be.revertedWith("!Unlocked");
  //     await expect(proxy.connect(depositor1).depositETH({ value: depositAmount })).to.be.revertedWith("!Unlocked");
  //   });

  //   it("should be able to register a withdraw", async () => {
  //     const amountTestDeposit = utils.parseUnits("1");

  //     const d1Shares = await vault.balanceOf(depositor1.address);

  //     const testAmountToGetBefore = await vault.getSharesByDepositAmount(amountTestDeposit);
  //     await vault.connect(depositor1).registerWithdraw(d1Shares);

  //     const testAmountToGetAfter = await vault.getSharesByDepositAmount(amountTestDeposit);
  //     const d1SharesAfter = await vault.balanceOf(depositor1.address);
  //     expect(d1SharesAfter.isZero()).to.be.true;
  //     expect(testAmountToGetAfter.eq(testAmountToGetBefore)).to.be.true;

  //     const round = await vault.round();
  //     const d1QueuedShares = await vault.userRoundQueuedWithdrawShares(depositor1.address, round);
  //     expect(d1QueuedShares.eq(d1Shares)).to.be.true;
  //     const totalQueuedShares = await vault.roundTotalQueuedWithdrawShares(round);
  //     expect(totalQueuedShares.eq(d1Shares)).to.be.true;

  //     // let depositor 2 register withdraw
  //     const d2Shares = await vault.balanceOf(depositor2.address);
  //     await vault.connect(depositor2).registerWithdraw(d2Shares);
  //     const d2SharesAfter = await vault.balanceOf(depositor2.address);
  //     expect(d2SharesAfter.isZero()).to.be.true;

  //     // depositor 3 register half his shares
  //     const d3Shares = await vault.balanceOf(depositor3.address);
  //     await vault.connect(depositor3).registerWithdraw(d3Shares.div(2));

  //     // depositor 4 register all his shares
  //     const d4Shares = await vault.balanceOf(depositor4.address);
  //     await vault.connect(depositor4).registerWithdraw(d4Shares);
  //   });
  //   it("should be able to schedule a deposit with ETH", async () => {
  //     const totalAssetBefore = await vault.totalAsset();
  //     const sharesBefore = await vault.balanceOf(depositor5.address);
  //     const vaultWethBefore = await weth.balanceOf(vault.address);
  //     const testAmountToGetBefore = await vault.getSharesByDepositAmount(depositAmount);

  //     await proxy.connect(depositor5).registerDepositETH({ value: depositAmount });

  //     const totalAssetAfter = await vault.totalAsset();
  //     const sharesAfter = await vault.balanceOf(depositor5.address);
  //     const vaultWethAfter = await weth.balanceOf(vault.address);
  //     const testAmountToGetAfter = await vault.getSharesByDepositAmount(depositAmount);

  //     expect(sharesAfter.eq(sharesBefore), "should not mint shares").to.be.true;
  //     expect(vaultWethAfter.sub(vaultWethBefore).eq(depositAmount)).to.be.true;
  //     expect(totalAssetAfter.eq(totalAssetBefore), "should not affect totalAsset").to.be.true;
  //     expect(testAmountToGetAfter.eq(testAmountToGetBefore)).to.be.true;
  //   });

  //   it("should be able to schedule a deposit with WETH", async () => {
  //     await weth.connect(depositor6).deposit({ value: depositAmount });
  //     await weth.connect(depositor6).approve(vault.address, ethers.constants.MaxUint256);

  //     const totalAssetBefore = await vault.totalAsset();
  //     const sharesBefore = await vault.balanceOf(depositor6.address);
  //     const vaultWethBefore = await weth.balanceOf(vault.address);
  //     const testAmountToGetBefore = await vault.getSharesByDepositAmount(depositAmount);

  //     await vault.connect(depositor6).registerDeposit(depositAmount, depositor6.address);

  //     const totalAssetAfter = await vault.totalAsset();
  //     const sharesAfter = await vault.balanceOf(depositor6.address);
  //     const vaultWethAfter = await weth.balanceOf(vault.address);
  //     const testAmountToGetAfter = await vault.getSharesByDepositAmount(depositAmount);

  //     expect(sharesAfter.eq(sharesBefore), "should not mint shares").to.be.true;
  //     expect(vaultWethAfter.sub(vaultWethBefore).eq(depositAmount)).to.be.true;
  //     expect(totalAssetAfter.eq(totalAssetBefore), "should not affect totalAsset").to.be.true;
  //     expect(testAmountToGetAfter.eq(testAmountToGetBefore)).to.be.true;
  //   });
  //   it("should revert if trying to get withdraw from queue now", async () => {
  //     await expect(vault.connect(depositor1).withdrawFromQueue(0)).to.be.revertedWith("Invalid round");
  //   });
  //   it("should revert if trying to get claim shares now", async () => {
  //     await expect(vault.connect(depositor1).claimShares(depositor5.address, 0)).to.be.revertedWith("Invalid round");
  //   });
  //   it("should revert if calling resumeFrom pause when vault is normal", async () => {
  //     await expect(vault.connect(owner).resumeFromPause()).to.be.revertedWith("!Emergency");
  //   });
  //   it("should be able to set vault to emergency state", async () => {
  //     const stateBefore = await vault.state();
  //     await vault.connect(owner).emergencyPause();
  //     expect((await vault.state()) === VaultState.Emergency).to.be.true;

  //     await expect(proxy.connect(depositor1).depositETH({ value: utils.parseUnits("1") })).to.be.revertedWith(
  //       "!Unlocked"
  //     );

  //     await expect(vault.connect(depositor1).withdrawFromQueue(0)).to.be.revertedWith("Emergency");

  //     await vault.connect(owner).resumeFromPause();
  //     expect((await vault.state()) === stateBefore).to.be.true;
  //   });
  //   it("should be able to close position", async () => {
  //     // mint 1 weth and send it to action1
  //     await weth.connect(random).deposit({ value: utils.parseUnits("1") });
  //     await weth.connect(random).transfer(action1.address, utils.parseUnits("1"));

  //     const totalAssetBefore = await vault.totalAsset();
  //     const vaultBalanceBefore = await weth.balanceOf(vault.address);
  //     const pendingDeposit = await vault.pendingDeposit();

  //     const action1BalanceBefore = await weth.balanceOf(action1.address);
  //     const action2BalanceBefore = await weth.balanceOf(action2.address);
  //     const feeRecipientBalanceBefore = await weth.balanceOf(feeRecipient.address);

  //     await vault.connect(owner).closePositions();

  //     const totalAssetAfter = await vault.totalAsset();

  //     const totalReservedForQueueWithdraw = await vault.withdrawQueueAmount();
  //     const vaultBalanceAfter = await weth.balanceOf(vault.address);
  //     const action1BalanceAfter = await weth.balanceOf(action1.address);
  //     const action2BalanceAfter = await weth.balanceOf(action2.address);
  //     const feeRecipientBalanceAfter = await weth.balanceOf(feeRecipient.address);
  //     const fee = feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore);
  //     // after calling rollover, total asset will exclude amount reserved for queue withdraw
  //     expect(
  //       totalAssetBefore.add(pendingDeposit).sub(fee).eq(totalAssetAfter.add(totalReservedForQueueWithdraw)),
  //       "total asset mismatch"
  //     ).to.be.true;
  //     expect(
  //       vaultBalanceAfter
  //         .add(fee)
  //         .sub(vaultBalanceBefore)
  //         .eq(action2BalanceBefore.sub(action2BalanceAfter).add(action1BalanceBefore.sub(action1BalanceAfter))),
  //       "erc20 balance mismatch"
  //     ).to.be.true;
  //   });
  // });

  // describe("Round 1: vault Unlocked", async () => {
  //   it("unlocked state checks", async () => {
  //     expect(await vault.state()).to.eq(VaultState.Unlocked);
  //     expect(await vault.round()).to.eq(1);
  //   });
  //   it("should revert if calling closePositions again", async () => {
  //     await expect(vault.connect(owner).closePositions()).to.be.revertedWith("!Locked");
  //   });
  //   it("should have correct reserved for withdraw", async () => {
  //     const totalInWithdrawQueue = await vault.withdrawQueueAmount();
  //     const pendingDeposit = await vault.pendingDeposit();
  //     const vaultTotalWeth = await weth.balanceOf(vault.address);
  //     const totalAsset = await vault.totalAsset();
  //     expect(vaultTotalWeth.sub(totalInWithdrawQueue).eq(totalAsset)).to.be.true;
  //     expect(pendingDeposit.isZero()).to.be.true;
  //   });

  // it('should be able to commit a call option to sell', async () => {

  //   otoken1 = (await MockOToken.deploy()) as MockOToken;
  //   await otoken1.init("oWETHUSDC", "oWETHUSDC", 18);
  //   await otoken1.initMockOTokenDetail(
  //     token.address,
  //     usdc.address,
  //     token.address,
  //     otoken2StrikePrice,
  //     otoken2Expiry,
  //     false
  //   );
  // })

  //
  //   it("should be able to rollover again", async () => {
  //     const action1BalanceBefore = await weth.balanceOf(action1.address);
  //     const action2BalanceBefore = await weth.balanceOf(action2.address);
  //     const totalValueBefore = await vault.totalAsset();

  //     // Distribution:
  //     // 70% - action1
  //     // 30% - action2
  //     await vault.connect(owner).rollOver([7000, 3000]);

  //     const action1BalanceAfter = await weth.balanceOf(action1.address);
  //     const action2BalanceAfter = await weth.balanceOf(action2.address);
  //     const totalValueAfter = await vault.totalAsset();

  //     expect(action1BalanceAfter.sub(action1BalanceBefore).eq(totalValueBefore.mul(7).div(10))).to.be.true;
  //     expect(action2BalanceAfter.sub(action2BalanceBefore).eq(totalValueBefore.mul(3).div(10))).to.be.true;

  //     expect(totalValueAfter.eq(totalValueBefore), "total value should stay unaffected").to.be.true;
  //   });
  // });

  // describe("Round 1: vault Locked", async () => {
  //   it("should be able to call withdrawQueue", async () => {
  //     const wethBefore = await weth.balanceOf(depositor4.address);
  //     await vault.connect(depositor4).withdrawFromQueue(0);

  //     const wethAfter = await weth.balanceOf(depositor4.address);
  //     expect(round0FullShareWithdrawAmount.eq(wethAfter.sub(wethBefore))).to.be.true;
  //   });

  //   it("should be able to close a non-profitable round", async () => {
  //     const smallProfit = utils.parseUnits("0.00000001");
  //     await weth.connect(random).deposit({ value: smallProfit });
  //     await weth.connect(random).transfer(action1.address, smallProfit);
  //     const feeRecipientBalanceBefore = await weth.balanceOf(feeRecipient.address);
  //     await vault.connect(owner).closePositions();
  //     const feeRecipientBalanceAfter = await weth.balanceOf(feeRecipient.address);
  //     const fee = feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore);
  //     expect(fee.eq(smallProfit), "fee mismatch").to.be.true;
  //   });

  //   it("should be able to withdraw full amount if the round is not profitable", async () => {
  //     // depositor 7 should get back 10eth he deposited, since this round is not profitable
  //     const depositAmount = utils.parseUnits("10");
  //     const shares = await vault.balanceOf(depositor7.address);
  //     const wethBalanceBefore = await weth.balanceOf(depositor7.address);

  //     vault.connect(depositor7).withdraw(shares);

  //     const wethBalanceAfter = await weth.balanceOf(depositor7.address);
  //     expect(wethBalanceAfter.sub(wethBalanceBefore).eq(depositAmount), "malicious vault!");
  //   });
  // });
});
