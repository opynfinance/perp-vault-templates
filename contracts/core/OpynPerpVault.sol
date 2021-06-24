// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IAction} from "../interfaces/IAction.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

contract OpynPerpVault is ERC20Upgradeable, ReentrancyGuardUpgradeable, OwnableUpgradeable {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  enum VaultState {Locked, Unlocked, Emergency}

  VaultState public state;

  VaultState public stateBeforePause;

  // @dev 100%, use to represent fee, allocation percentage
  uint256 public constant BASE = 10000;

  // @dev how many percentage of profit go to the fee recipient
  uint256 public performanceFeeInPercent = 100; // 1%

  // @dev percentage of total asset charged as management fee every year.
  uint256 public managementFeeInPercent = 50; // 0.5%

  /// @dev amount of asset that's been registered to be withdrawn. this amount will alwasys be reserved in the vault.
  uint256 public withdrawQueueAmount;

  /// @dev amount of asset that's been deposited into the vault, but hadn't mint share yet.
  uint256 public pendingDeposit;

  address public WETH;

  address public asset;

  address public feeRecipient;

  /// @dev actions that build up this strategy (vault)
  address[] public actions;

  uint256 public currentRoundStartTimestamp;

  /// @dev keep tracks of how much capital the current round start with
  uint256 public currentRoundStartingAmount;

  /// @dev Cap for the vault. hardcoded at 1000 for initial release
  uint256 public constant CAP = 1000 ether;

  /// @dev the current round
  uint256 public round;

  /// @dev
  mapping(uint256 => uint256) roundFee;

  /// @dev user's share in withdraw queue for a round
  mapping(address => mapping(uint256 => uint256)) public userRoundQueuedWithdrawShares;

  /// @dev user's asset amount in deposit queue for a round
  mapping(address => mapping(uint256 => uint256)) public userRoundQueuedDepositAmount;

  /// @dev total registered shares per round
  mapping(uint256 => uint256) public roundTotalQueuedWithdrawShares;

  /// @dev total asset recorded at end of each round
  mapping(uint256 => uint256) public roundTotalAsset;

  /// @dev total share supply recorded at end of each round
  mapping(uint256 => uint256) public roundTotalShare;

  /*=====================
   *       Events       *
   *====================*/

  event Deposit(address account, uint256 amountDeposited, uint256 shareMinted);

  event Withdraw(address account, uint256 amountWithdrawn, uint256 shareBurned);

  event WithdrawFromQueue(address account, uint256 amountWithdrawn, uint256 round);

  event Rollover(uint256[] allocations);

  event StateUpdated(VaultState state);

  /*=====================
   *     Modifiers      *
   *====================*/

  /**
   * @dev can only be executed and unlock state. which bring the state back to 'Locked'
   */
  modifier locker {
    require(state == VaultState.Unlocked, "!Unlocked");
    _;
    state = VaultState.Locked;
    emit StateUpdated(VaultState.Locked);
  }

  /**
   * @dev can only be executed in locked state. which bring the state back to "unlocked"
   */
  modifier unlocker {
    require(state == VaultState.Locked, "!Locked");
    _;

    state = VaultState.Unlocked;
    emit StateUpdated(VaultState.Unlocked);
  }

  /**
   * @dev can only be executed if vault is not in emergency state.
   */
  modifier notEmergency {
    require(state != VaultState.Emergency, "Emergency");
    _;
  }

  /*=====================
   * external function *
   *====================*/

  /**
   * @dev init the vault.
   * this will set the "action" for this strategy vault and won't be able to change
   */
  function init(
    address _asset,
    address _owner,
    address _feeRecipient,
    address _weth,
    uint8 _decimals,
    string memory _tokenName,
    string memory _tokenSymbol,
    address[] memory _actions
  ) public initializer {
    __ReentrancyGuard_init();
    __ERC20_init(_tokenName, _tokenSymbol);
    _setupDecimals(_decimals);
    __Ownable_init();
    transferOwnership(_owner);

    asset = _asset;
    feeRecipient = _feeRecipient;
    WETH = _weth;

    // assign actions
    for (uint256 i = 0; i < _actions.length; i++) {
      // check all items before actions[i], does not equal to action[i]
      for (uint256 j = 0; j < i; j++) {
        require(_actions[i] != _actions[j], "duplicated action");
      }
      actions.push(_actions[i]);
    }

    state = VaultState.Unlocked;

    currentRoundStartTimestamp = block.timestamp;
  }

  /**
   * total assets controlled by this vault
   */
  function totalAsset() external view returns (uint256) {
    return _totalAsset();
  }

  /**
   * @dev return how many shares you can get if you deposit asset into the pool
   * @notice this number will change when someone register a withdraw when the vault is locked
   * @param _amount amount of asset you deposit
   */
  function getSharesByDepositAmount(uint256 _amount) external view returns (uint256) {
    return _getSharesByDepositAmount(_amount, _totalAsset());
  }

  /**
   * @dev return how many asset you can get if you burn the number of shares, after charging the fee.
   */
  function getWithdrawAmountByShares(uint256 _shares) external view returns (uint256) {
    return _getWithdrawAmountByShares(_shares);
  }

  /**
   * @dev deposit ERC20 asset and get shares
   */
  function deposit(uint256 _amount) external {
    require(state == VaultState.Unlocked, "!Unlocked");
    IERC20(asset).safeTransferFrom(msg.sender, address(this), _amount);
    _deposit(_amount);
  }

  /**
   * @dev register for a fair deposit with ERC20
   */
  function registerDeposit(uint256 _amount, address _shareRecipient) external {
    require(state == VaultState.Locked, "!Locked");
    IERC20(asset).safeTransferFrom(msg.sender, address(this), _amount);
    userRoundQueuedDepositAmount[_shareRecipient][round] = userRoundQueuedWithdrawShares[_shareRecipient][round].add(
      _amount
    );
    pendingDeposit = pendingDeposit.add(_amount);
  }

  /**
   * anyone can call this function and claim the shares
   */
  function claimShares(address _depositor, uint256 _round) external {
    require(_round < round, "Invalid round");
    uint256 amountDeposited = userRoundQueuedDepositAmount[_depositor][_round];

    userRoundQueuedDepositAmount[_depositor][_round] = 0;

    uint256 equivilentShares = amountDeposited.mul(roundTotalShare[_round]).div(roundTotalAsset[_round]);

    // transfer shares from vault to user
    _transfer(address(this), _depositor, equivilentShares);
  }

  /**
   * @notice Withdraws asset from vault using vault shares.
   * @param _shares is the number of vault shares to be burned
   */
  function withdraw(uint256 _shares) external nonReentrant {
    require(state == VaultState.Unlocked, "!Unlocked");
    uint256 withdrawAmount = _regularWithdraw(_shares);
    IERC20(asset).safeTransfer(msg.sender, withdrawAmount);
  }

  /**
   * @dev register for a fair withdraw that can be executed after this round ends
   */
  function registerWithdraw(uint256 _shares) external {
    require(state == VaultState.Locked, "!Locked");
    _burn(msg.sender, _shares);
    userRoundQueuedWithdrawShares[msg.sender][round] = userRoundQueuedWithdrawShares[msg.sender][round].add(_shares);
    roundTotalQueuedWithdrawShares[round] = roundTotalQueuedWithdrawShares[round].add(_shares);
  }

  /**
   * @notice Withdraws asset from the withdraw queue
   * @param _round the round you registered a queue withdraw
   */
  function withdrawFromQueue(uint256 _round) external nonReentrant notEmergency {
    uint256 withdrawAmount = _withdrawFromQueue(_round);
    IERC20(asset).safeTransfer(msg.sender, withdrawAmount);
  }

  /**
   * @dev anyone can call this to close out the previous round by calling "closePositions" on all actions
   */
  function closePositions() public unlocker {
    _closeAndWithdraw();

    _payRoundFee();

    _snapshotShareAndAsset();

    round = round.add(1);
    currentRoundStartTimestamp = block.timestamp;
  }

  /**
   * @dev distribute funds to each action
   */
  function rollOver(uint256[] calldata _allocationPercentages) external virtual onlyOwner locker {
    require(_allocationPercentages.length == actions.length, "INVALID_INPUT");

    emit Rollover(_allocationPercentages);

    _distribute(_allocationPercentages);
  }

  /**
   * @dev set the state to "Emergency", which disable all withdraw and deposit
   */
  function emergencyPause() external onlyOwner {
    stateBeforePause = state;
    state = VaultState.Emergency;
    emit StateUpdated(VaultState.Emergency);
  }

  /**
   * @dev set the state from "Emergency", which disable all withdraw and deposit
   */
  function resumeFromPause() external onlyOwner {
    require(state == VaultState.Emergency, "!Emergency");
    state = stateBeforePause;
    emit StateUpdated(stateBeforePause);
  }

  /*=====================
   * Internal functions *
   *====================*/

  /**
   * @dev total assets controlled by this vault, which is effective balance + all the balance in the actions
   */
  function _totalAsset() internal view returns (uint256) {
    return _effectiveBalance().add(_totalDebt());
  }

  /**
   * @dev returns asset balance of the vault that's not registered to be withdrawn.
   */
  function _effectiveBalance() internal view returns (uint256) {
    return IERC20(asset).balanceOf(address(this)).sub(pendingDeposit).sub(withdrawQueueAmount);
  }

  /**
   * @dev estimate amount of assets in all the actions
   * this function iterates through all actions and sum up the currentValue reported by each action.
   */
  function _totalDebt() internal view returns (uint256) {
    uint256 debt = 0;
    for (uint256 i = 0; i < actions.length; i++) {
      debt = debt.add(IAction(actions[i]).currentValue());
    }
    return debt;
  }

  /**
   * @dev mint the shares to depositor, and emit the deposit event
   */
  function _deposit(uint256 _amount) internal {
    // the asset is already deposited into the contract at this point, need to substract it from total
    uint256 totalWithDepositedAmount = _totalAsset();
    require(totalWithDepositedAmount < CAP, "Cap exceeded");
    uint256 totalBeforeDeposit = totalWithDepositedAmount.sub(_amount);

    uint256 share = _getSharesByDepositAmount(_amount, totalBeforeDeposit);

    emit Deposit(msg.sender, _amount, share);

    _mint(msg.sender, share);
  }

  /**
   * @dev iterrate through each action, close position and withdraw funds
   */
  function _closeAndWithdraw() internal {
    for (uint8 i = 0; i < actions.length; i = i + 1) {
      // 1. close position. this should revert if any position is not ready to be closed.
      IAction(actions[i]).closePosition();

      // 2. withdraw assets
      uint256 actionBalance = IERC20(asset).balanceOf(actions[i]);
      if (actionBalance > 0) IERC20(asset).safeTransferFrom(actions[i], address(this), actionBalance);
    }
  }

  /**
   * @dev redistribute all funds to diff actions
   */
  function _distribute(uint256[] memory _percentages) internal nonReentrant {
    uint256 totalBalance = _effectiveBalance();

    currentRoundStartingAmount = totalBalance;

    // keep track of total percentage to make sure we're summing up to 100%
    uint256 sumPercentage;
    for (uint8 i = 0; i < actions.length; i = i + 1) {
      sumPercentage = sumPercentage.add(_percentages[i]);
      require(sumPercentage <= BASE, "PERCENTAGE_SUM_EXCEED_MAX");

      uint256 newAmount = totalBalance.mul(_percentages[i]).div(BASE);

      if (newAmount > 0) {
        IERC20(asset).safeTransfer(actions[i], newAmount);
        IAction(actions[i]).rolloverPosition();
      }
    }

    require(sumPercentage == BASE, "PERCENTAGE_DOESNT_ADD_UP");
  }

  /**
   * @dev calculate withdraw amount from queued shares, return withdraw amount to be handled by queueWithdraw or queueWithdrawETH
   * @param _round the round you registered a queue withdraw
   */
  function _withdrawFromQueue(uint256 _round) internal returns (uint256) {
    require(_round < round, "Invalid round");

    uint256 queuedShares = userRoundQueuedWithdrawShares[msg.sender][_round];
    uint256 withdrawAmount = queuedShares.mul(roundTotalAsset[_round]).div(roundTotalShare[_round]);

    // remove user's queued shares
    userRoundQueuedWithdrawShares[msg.sender][_round] = 0;
    // decrease total asset we reserved for withdraw
    withdrawQueueAmount = withdrawQueueAmount.sub(withdrawAmount);

    emit WithdrawFromQueue(msg.sender, withdrawQueueAmount, _round);

    return withdrawAmount;
  }

  /**
   * @dev burn shares, return withdraw amount handle by withdraw or withdrawETH
   * @param _share amount of shares burn to withdraw asset.
   */
  function _regularWithdraw(uint256 _share) internal returns (uint256) {
    uint256 withdrawAmount = _getWithdrawAmountByShares(_share);

    _burn(msg.sender, _share);

    emit Withdraw(msg.sender, withdrawAmount, _share);

    return withdrawAmount;
  }

  /**
   * @dev return how many shares you can get if you deposit {_amount} asset
   * @param _amount amount of token depositing
   * @param _totalAssetAmount amount of asset already in the pool before deposit
   */
  function _getSharesByDepositAmount(uint256 _amount, uint256 _totalAssetAmount) internal view returns (uint256) {
    uint256 shareSupply = totalSupply().add(roundTotalQueuedWithdrawShares[round]);

    uint256 shares = shareSupply == 0 ? _amount : _amount.mul(shareSupply).div(_totalAssetAmount);
    return shares;
  }

  /**
   * @dev return how many asset you can get if you burn the number of shares
   */
  function _getWithdrawAmountByShares(uint256 _share) internal view returns (uint256) {
    uint256 effectiveShares = totalSupply();
    return _share.mul(_totalAsset()).div(effectiveShares);
  }

  /**
   * @dev pay fee to fee recipient after we pull all assets back to the vault
   */
  function _payRoundFee() internal {
    // don't need to call totalAsset() because actions are empty now.
    uint256 newTotal = _effectiveBalance();
    uint256 profit;

    if (newTotal > currentRoundStartingAmount) profit = newTotal.sub(currentRoundStartingAmount);

    uint256 performanceFee = profit.mul(performanceFeeInPercent).div(BASE);

    uint256 managementFee =
      currentRoundStartingAmount
        .mul(managementFeeInPercent)
        .mul((block.timestamp.sub(currentRoundStartTimestamp)))
        .div(365 days)
        .div(BASE);
    uint256 totalFee = performanceFee.add(managementFee);
    if (totalFee > profit) totalFee = profit;

    currentRoundStartingAmount = 0;

    IERC20(asset).transfer(feeRecipient, totalFee);
  }

  /**
   * @dev snapshot last round's total shares and balance, excluding pending deposits.
   * this function is called after withdrawing from action contracts
   */
  function _snapshotShareAndAsset() internal {
    uint256 vaultBalance = _effectiveBalance();
    uint256 outStandingShares = totalSupply();
    uint256 sharesBurned = roundTotalQueuedWithdrawShares[round];

    uint256 totalShares = outStandingShares.add(sharesBurned);

    // store this round's balance and shares
    roundTotalShare[round] = totalShares;
    roundTotalAsset[round] = vaultBalance;

    // === Handle withdraw queue === //
    // withdrawQueueAmount was keeping track of total amount that should be reserved for withdraws, not including this round
    // add this round's reserved asset into withdrawQueueAmount, which will stay in the vault for withdraw

    uint256 roundReservedAsset = sharesBurned.mul(vaultBalance).div(totalShares);
    withdrawQueueAmount = withdrawQueueAmount.add(roundReservedAsset);

    // === Handle deposit queue === //
    // pendingDeposit is amount of deposit accepted in this round, which was in the vault all the time.
    // we will calculate how much shares this amount can mint, mint it at once to the vault,
    // and reset the pendingDeposit, so that this amount can be used in the next round.
    uint256 sharesToMint = pendingDeposit.mul(totalShares).div(vaultBalance);
    _mint(address(this), sharesToMint);
    pendingDeposit = 0;
  }
}
