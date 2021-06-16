import { ethers } from "hardhat";
import { utils } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { MockAction, MockERC20, OpynPerpVault, MockWETH } from "../../typechain";

enum VaultState {
  Locked,
  Unlocked,
  Emergency,
}

describe("OpynPerpVault Tests", function () {
  let action1: MockAction;
  let action2: MockAction;
  // asset used by this action: in this case, weth
  let weth: MockWETH;
  let usdc: MockERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let depositor4: SignerWithAddress;
  let depositor5: SignerWithAddress;
  let depositor6: SignerWithAddress;
  let random: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;

  //
  let round0FullShareWithdrawAmount;

  this.beforeAll("Set accounts", async () => {
    accounts = await ethers.getSigners();
    const [
      _owner,
      _feeRecipient,
      _depositor1,
      _depositor2,
      _depositor3,
      _depositor4,
      _depositor5,
      _depositor6,
      _random,
    ] = accounts;

    owner = _owner;
    feeRecipient = _feeRecipient;

    depositor1 = _depositor1;
    depositor2 = _depositor2;
    depositor3 = _depositor3;
    depositor4 = _depositor4;

    // scheduled depositors
    depositor5 = _depositor5;
    depositor6 = _depositor6;
    random = _random;
  });

  this.beforeAll("Deploy Mock contracts", async () => {
    const MockWETHContract = await ethers.getContractFactory("MockWETH");
    weth = (await MockWETHContract.deploy()) as MockWETH;
    await weth.init("WETH", "WETH", 18);

    const ERC20 = await ethers.getContractFactory("MockERC20");
    usdc = (await ERC20.deploy()) as MockERC20;
    await usdc.init("USDC", "USDC", 6);
  });

  this.beforeAll("Deploy vault and mock actions", async () => {
    const VaultContract = await ethers.getContractFactory("OpynPerpVault");
    vault = (await VaultContract.deploy()) as OpynPerpVault;

    // deploy 2 mock actions
    const MockActionContract = await ethers.getContractFactory("MockAction");
    action1 = (await MockActionContract.deploy(vault.address, weth.address)) as MockAction;
    action2 = (await MockActionContract.deploy(vault.address, weth.address)) as MockAction;
  });

  describe("init", async () => {
    it("should revert when trying to init with duplicated actions", async () => {
      await expect(
        vault
          .connect(owner)
          .init(
            weth.address,
            owner.address,
            feeRecipient.address,
            weth.address,
            18,
            "OpynPerpShortVault share",
            "sOPS",
            [action1.address, action2.address, action2.address]
          )
      ).to.be.revertedWith("duplicated action");

      await expect(
        vault
          .connect(owner)
          .init(
            weth.address,
            owner.address,
            feeRecipient.address,
            weth.address,
            18,
            "OpynPerpShortVault share",
            "sOPS",
            [action1.address, action2.address, action1.address]
          )
      ).to.be.revertedWith("duplicated action");
    });
    it("should init the contract successfully", async () => {
      await vault
        .connect(owner)
        .init(weth.address, owner.address, feeRecipient.address, weth.address, 18, "OpynPerpShortVault share", "sOPS", [
          action1.address,
          action2.address,
        ]);
      // init state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalAsset()).isZero(), "total asset should be zero").to.be.true;
      expect((await vault.WETH()) === weth.address).to.be.true;
    });

    it("should revert if someone tries to send ETH to the vault", async () => {
      await expect(depositor1.sendTransaction({ to: vault.address, value: utils.parseUnits("1") })).to.be.revertedWith(
        "Cannot receive ETH"
      );
    });
  });

  describe("Round 0, vault unlocked", async () => {
    const depositAmount = utils.parseUnits("10");
    before("mint some WETH for depositor 2", async () => {
      // deposit 10 eth into weth
      await weth.connect(depositor2).deposit({ value: depositAmount });
      await weth.connect(depositor2).approve(vault.address, ethers.constants.MaxUint256);
    });
    it("unlocked state checks", async () => {
      expect(await vault.state()).to.eq(VaultState.Unlocked);
      expect(await vault.round()).to.eq(0);
    });
    it("should revert if calling depositETH with no value", async () => {
      await expect(vault.connect(depositor1).depositETH()).to.be.revertedWith("!VALUE");
    });
    it("should be able to deposit ETH and WETH", async () => {
      const shares1Before = await vault.balanceOf(depositor1.address);
      const expectedShares = await vault.getSharesByDepositAmount(depositAmount);

      // depositor 1 deposits 10 eth
      await vault.connect(depositor1).depositETH({ value: depositAmount });
      expect((await vault.totalAsset()).eq(depositAmount), "total asset should update").to.be.true;

      const shares1After = await vault.balanceOf(depositor1.address);
      expect(shares1After.sub(shares1Before).eq(expectedShares)).to.be.true;

      // depositor 2 deposits 10 weth
      await vault.connect(depositor2).deposit(depositAmount);

      // depositor 3 deposits 10 eth
      await vault.connect(depositor3).depositETH({ value: depositAmount });
    });
    it("should be able to withdraw eth", async () => {
      // depositor 4 deposit 10 eth and withdraw 10 eth
      await vault.connect(depositor4).depositETH({ value: depositAmount });
      await vault.connect(depositor4).withdrawETH(depositAmount);
      expect((await vault.balanceOf(depositor4.address)).isZero()).to.be.true;

      // deposit 10 eth back
      await vault.connect(depositor4).depositETH({ value: depositAmount });
    });

    it("should revert when trying to register a queue withdraw", async () => {
      const shares = await vault.balanceOf(depositor3.address);
      await expect(vault.connect(depositor3).registerWithdraw(shares)).to.be.revertedWith("!Locked");
    });
    it("should revert when calling closePosition", async () => {
      await expect(vault.connect(owner).closePositions()).to.be.revertedWith("!Locked");
    });
    it("should revert if rollover is called with total percentage > 100", async () => {
      // max percentage sum should be 90% (9000) because 10% is set for reserve
      await expect(vault.connect(owner).rollOver([5000, 6000])).to.be.revertedWith("PERCENTAGE_SUM_EXCEED_MAX");
    });
    it("should revert if rollover is called with invalid percentage array", async () => {
      await expect(vault.connect(owner).rollOver([5000])).to.be.revertedWith("INVALID_INPUT");
    });
    it("should rollover to the next round", async () => {
      const vaultBalanceBefore = await weth.balanceOf(vault.address);
      const action1BalanceBefore = await weth.balanceOf(action1.address);
      const action2BalanceBefore = await weth.balanceOf(action2.address);
      const totalValueBefore = await vault.totalAsset();

      // Distribution:
      // 60% - action1
      // 40% - action2
      await vault.connect(owner).rollOver([6000, 4000]);

      const vaultBalanceAfter = await weth.balanceOf(vault.address);
      const action1BalanceAfter = await weth.balanceOf(action1.address);
      const action2BalanceAfter = await weth.balanceOf(action2.address);
      const totalValueAfter = await vault.totalAsset();

      expect(action1BalanceAfter.sub(action1BalanceBefore).eq(vaultBalanceBefore.mul(6).div(10))).to.be.true;
      expect(action2BalanceAfter.sub(action2BalanceBefore).eq(vaultBalanceBefore.mul(4).div(10))).to.be.true;

      expect(vaultBalanceAfter.isZero()).to.be.true;
      expect(totalValueAfter.eq(totalValueBefore), "total value should stay unaffected").to.be.true;
    });
  });
  describe("Round 0, vault Locked", async () => {
    const depositAmount = utils.parseUnits("10");
    it("locked state checks", async () => {
      expect(await vault.state()).to.eq(VaultState.Locked);
      expect(await vault.round()).to.eq(0);
    });
    it("should revert when trying to call rollover again", async () => {
      await expect(vault.connect(owner).rollOver([6000, 4000])).to.be.revertedWith("!Unlocked");
    });
    it("should revert when trying to withdraw", async () => {
      const depositor1Shares = await vault.balanceOf(depositor1.address);
      await expect(vault.connect(depositor1).withdrawETH(depositor1Shares)).to.be.revertedWith("!Unlocked");

      await expect(vault.connect(depositor1).withdraw(depositor1Shares)).to.be.revertedWith("!Unlocked");
    });
    it("should revert when trying to deposit", async () => {
      await expect(vault.connect(depositor1).deposit(depositAmount)).to.be.revertedWith("!Unlocked");
      await expect(vault.connect(depositor1).depositETH({ value: depositAmount })).to.be.revertedWith("!Unlocked");
    });

    it("should be able to register a withdraw", async () => {
      const amountTestDeposit = utils.parseUnits("1");

      const d1Shares = await vault.balanceOf(depositor1.address);

      const testAmountToGetBefore = await vault.getSharesByDepositAmount(amountTestDeposit);
      await vault.connect(depositor1).registerWithdraw(d1Shares);

      const testAmountToGetAfter = await vault.getSharesByDepositAmount(amountTestDeposit);
      const d1SharesAfter = await vault.balanceOf(depositor1.address);
      expect(d1SharesAfter.isZero()).to.be.true;
      expect(testAmountToGetAfter.eq(testAmountToGetBefore)).to.be.true;

      const round = await vault.round();
      const d1QueuedShares = await vault.userRoundQueuedWithdrawShares(depositor1.address, round);
      expect(d1QueuedShares.eq(d1Shares)).to.be.true;
      const totalQueuedShares = await vault.roundTotalQueuedWithdrawShares(round);
      expect(totalQueuedShares.eq(d1Shares)).to.be.true;

      // let depositor 2 register withdraw
      const d2Shares = await vault.balanceOf(depositor2.address);
      await vault.connect(depositor2).registerWithdraw(d2Shares);
      const d2SharesAfter = await vault.balanceOf(depositor2.address);
      expect(d2SharesAfter.isZero()).to.be.true;

      // depositor 3 register half his shares
      const d3Shares = await vault.balanceOf(depositor3.address);
      await vault.connect(depositor3).registerWithdraw(d3Shares.div(2));

      // depositor 4 register all his shares
      const d4Shares = await vault.balanceOf(depositor4.address);
      await vault.connect(depositor4).registerWithdraw(d4Shares);
    });
    it("should be able to schedule a deposit with ETH", async () => {
      const totalAssetBefore = await vault.totalAsset();
      const sharesBefore = await vault.balanceOf(depositor5.address);
      const vaultWethBefore = await weth.balanceOf(vault.address);

      await vault.connect(depositor5).registerDepositETH({ value: depositAmount });

      const totalAssetAfter = await vault.totalAsset();
      const sharesAfter = await vault.balanceOf(depositor5.address);
      const vaultWethAfter = await weth.balanceOf(vault.address);

      expect(sharesAfter.eq(sharesBefore), "should not mint shares").to.be.true;
      expect(vaultWethAfter.sub(vaultWethBefore).eq(depositAmount)).to.be.true;
      expect(totalAssetAfter.eq(totalAssetBefore), "should not affect totalAsset").to.be.true;
    });

    it("should be able to schedule a deposit with ETH", async () => {
      const sharesBefore = await vault.balanceOf(depositor5.address);
      const vaultWethBefore = await weth.balanceOf(vault.address);
      await vault.connect(depositor5).registerDepositETH({ value: depositAmount });
      const sharesAfter = await vault.balanceOf(depositor5.address);
      const vaultWethAfter = await weth.balanceOf(vault.address);
      expect(sharesAfter.sub(sharesBefore).isZero(), "should not mint shares").to.be.true;
      expect(vaultWethAfter.sub(vaultWethBefore).eq(depositAmount)).to.be.true;
    });
    it("should revert if trying to get withdraw from queue now", async () => {
      await expect(vault.connect(depositor1).withdrawFromQueue(0)).to.be.revertedWith("Invalid round");
    });
    it("should revert if calling resumeFrom pause when vault is normal", async () => {
      await expect(vault.connect(owner).resumeFromPause()).to.be.revertedWith("!Emergency");
    });
    it("should be able to set vault to emergency state", async () => {
      const stateBefore = await vault.state();
      await vault.connect(owner).emergencyPause();
      expect((await vault.state()) === VaultState.Emergency).to.be.true;

      await expect(vault.connect(depositor1).depositETH({ value: utils.parseUnits("1") })).to.be.revertedWith(
        "!Unlocked"
      );

      await vault.connect(owner).resumeFromPause();
      expect((await vault.state()) === stateBefore).to.be.true;
    });
    it("should be able to close position", async () => {
      // mint 1 weth and send it to action1
      await weth.connect(random).deposit({ value: utils.parseUnits("1") });
      await weth.connect(random).transfer(action1.address, utils.parseUnits("1"));

      const totalAssetBefore = await vault.totalAsset();
      const vaultBalanceBefore = await weth.balanceOf(vault.address);
      const pendingDeposit = await vault.pendingDeposit();

      const action1BalanceBefore = await weth.balanceOf(action1.address);
      const action2BalanceBefore = await weth.balanceOf(action2.address);

      await vault.connect(owner).closePositions();

      const totalAssetAfter = await vault.totalAsset();

      const totalReservedForQueueWithdraw = await vault.withdrawQueueAmount();

      const vaultBalanceAfter = await weth.balanceOf(vault.address);
      const action1BalanceAfter = await weth.balanceOf(action1.address);
      const action2BalanceAfter = await weth.balanceOf(action2.address);

      // after calling rollover, total asset will exclude amount reserved for queue withdraw
      expect(
        totalAssetBefore.add(pendingDeposit).eq(totalAssetAfter.add(totalReservedForQueueWithdraw)),
        "total asset mismatch"
      ).to.be.true;
      expect(
        vaultBalanceAfter
          .sub(vaultBalanceBefore)
          .eq(action2BalanceBefore.sub(action2BalanceAfter).add(action1BalanceBefore.sub(action1BalanceAfter))),
        "erc20 balance mismatch"
      ).to.be.true;
    });
  });
  describe("Round 1: vault Unlocked", async () => {
    it("unlocked state checks", async () => {
      expect(await vault.state()).to.eq(VaultState.Unlocked);
      expect(await vault.round()).to.eq(1);
    });
    it("should revert if calling closePositions again", async () => {
      await expect(vault.connect(owner).closePositions()).to.be.revertedWith("!Locked");
    });
    it("should have correct reserved for withdraw", async () => {
      const totalInWithdrawQueue = await vault.withdrawQueueAmount();
      const pendingDeposit = await vault.pendingDeposit();
      const vaultTotalWeth = await weth.balanceOf(vault.address);
      const totalAsset = await vault.totalAsset();
      expect(vaultTotalWeth.sub(totalInWithdrawQueue).eq(totalAsset)).to.be.true;
      expect(pendingDeposit.isZero()).to.be.true;
    });

    it("should allow queue withdraw weth", async () => {
      // depositor1 use withdrawFromQueue to withdraw weth
      const wethBefore = await weth.balanceOf(depositor1.address);
      const reserveBefore = await vault.withdrawQueueAmount();

      const amountTestDeposit = utils.parseUnits("1");
      const testAmountToGetBefore = await vault.getSharesByDepositAmount(amountTestDeposit);
      const feeRecipientBalanceBefore = await weth.balanceOf(feeRecipient.address);

      await vault.connect(depositor1).withdrawFromQueue(0);

      const wethAfter = await weth.balanceOf(depositor1.address);
      const reserveAfter = await vault.withdrawQueueAmount();
      const testAmountToGetAfter = await vault.getSharesByDepositAmount(amountTestDeposit);
      const feeRecipientBalanceAfter = await weth.balanceOf(feeRecipient.address);
      const fee = feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore);

      expect(wethAfter.add(fee).sub(wethBefore).eq(reserveBefore.sub(reserveAfter))).to.be.true;
      expect(testAmountToGetAfter.eq(testAmountToGetBefore), "shares from deposit should remain the same").to.be.true;

      // store how much depositor 1 get
      round0FullShareWithdrawAmount = wethAfter.sub(wethBefore);
    });

    it("should allow queue withdraw eth", async () => {
      // depositor2 use withdrawETHFromQueue
      const ethBefore = await depositor2.getBalance();
      const reserveBefore = await vault.withdrawQueueAmount();

      const amountTestDeposit = utils.parseUnits("1");
      const testAmountToGetBefore = await vault.getSharesByDepositAmount(amountTestDeposit);
      const feeRecipientBalanceBefore = await weth.balanceOf(feeRecipient.address);

      await vault.connect(depositor2).withdrawETHFromQueue(0, { gasPrice: 0 });

      const ethAfter = await depositor2.getBalance();
      const reserveAfter = await vault.withdrawQueueAmount();
      const testAmountToGetAfter = await vault.getSharesByDepositAmount(amountTestDeposit);
      const feeRecipientBalanceAfter = await weth.balanceOf(feeRecipient.address);
      const fee = feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore);

      expect(ethAfter.add(fee).sub(ethBefore).eq(reserveBefore.sub(reserveAfter))).to.be.true;
      expect(testAmountToGetAfter.eq(testAmountToGetBefore), "shares from deposit should remain the same").to.be.true;
    });

    it("queue withdraw and normal withdraw should act the same now", async () => {
      // depositor 3 has half registered as queued withdraw, half as pure share
      // using both withdraw method should give him the same result now.

      // execute queue withdraw
      const wethBefore = await weth.balanceOf(depositor3.address);
      await vault.connect(depositor3).withdrawFromQueue(0);
      const wethAfterQueueWithdraw = await weth.balanceOf(depositor3.address);

      // withdraw by normal withdraw

      const shares = await vault.balanceOf(depositor3.address);
      const amountToGetNormalWithdraw = await vault.getWithdrawAmountByShares(shares);
      await vault.connect(depositor3).withdraw(shares);
      const wethAfter = await weth.balanceOf(depositor3.address);
      expect(amountToGetNormalWithdraw.eq(wethAfter.sub(wethAfterQueueWithdraw))).to.be.true;

      // compare 2 kind of withdraw
      const amountFromQueueWithdraw = wethAfterQueueWithdraw.sub(wethBefore);
      const amountFromWithdraw = wethAfter.sub(wethAfterQueueWithdraw);

      // error < 10000 wei
      expect(amountFromWithdraw.sub(amountFromQueueWithdraw).abs().lt(10000)).to.be.true;
    });

    it("should be able to rollover again", async () => {
      // const totalInWithdrawQueue = await vault.withdrawQueueAmount();
      const totalInDepositQueue = await vault.withdrawQueueAmount();

      const action1BalanceBefore = await weth.balanceOf(action1.address);
      const action2BalanceBefore = await weth.balanceOf(action2.address);
      const totalValueBefore = await vault.totalAsset();

      // Distribution:
      // 70% - action1
      // 30% - action2
      await vault.connect(owner).rollOver([7000, 3000]);

      const action1BalanceAfter = await weth.balanceOf(action1.address);
      const action2BalanceAfter = await weth.balanceOf(action2.address);
      const totalValueAfter = await vault.totalAsset();

      expect(action1BalanceAfter.sub(action1BalanceBefore).eq(totalValueBefore.mul(7).div(10))).to.be.true;
      expect(action2BalanceAfter.sub(action2BalanceBefore).eq(totalValueBefore.mul(3).div(10))).to.be.true;

      expect(totalValueAfter.eq(totalValueBefore), "total value should stay unaffected").to.be.true;
    });
  });
  describe("Round 1: vault Locked", async () => {
    it("should be able to call withdrawQueue", async () => {
      const wethBefore = await weth.balanceOf(depositor4.address);
      await vault.connect(depositor4).withdrawFromQueue(0);

      const wethAfter = await weth.balanceOf(depositor4.address);
      expect(round0FullShareWithdrawAmount.eq(wethAfter.sub(wethBefore))).to.be.true;
    });
  });
});
