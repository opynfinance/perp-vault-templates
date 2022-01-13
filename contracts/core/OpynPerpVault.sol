// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import { SafeMath } from '@openzeppelin/contracts/math/SafeMath.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { SafeERC20 } from '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';

import { IAction } from '../interfaces/IAction.sol';

import "hardhat/console.sol";

/**
 * Error Codes
 * O1: actions for the vault have not been initialized
 * O2: cannot execute transaction, vault is in emergency state
 * O3: cannot call setActions, actions have already been initialized
 * O4: action being set is using an invalid address
 * O5: action being set is a duplicated action
 * O6: deposited underlying (msg.value) must be greater than 0
 * O7: cannot accept underlying deposit, total underlying controlled by the vault would exceed vault cap
 * O8: unable to withdraw underlying, underlying to withdraw would exceed or be equal to the current vault underlying balance
 * O9: unable to withdraw underlying, underlying fee transfer to fee recipient (feeRecipient) failed
 * O10: unable to withdraw underlying, underlying withdrawal to user (msg.sender) failed
 * O11: cannot close vault positions, vault is not in locked state (VaultState.Locked)
 * O12: unable to rollover vault, length of allocation percentages (_allocationPercentages) passed is not equal to the initialized actions length
 * O13: unable to rollover vault, vault is not in unlocked state (VaultState.Unlocked)
 * O14: unable to rollover vault, the calculated percentage sum (sumPercentage) is greater than the base (BASE)
 * O15: unable to rollover vault, the calculated percentage sum (sumPercentage) is not equal to the base (BASE)
 * O16: withdraw reserve percentage must be less than 50% (5000)
 * O17: cannot call emergencyPause, vault is already in emergency state
 * O18: cannot call resumeFromPause, vault is not in emergency state
 * O19: cannot accept underlying deposit, accounting before and after deposit does not match
 * O20: unable to withdraw underlying, accounting before and after withdrawal does not match
 */

/** 
 * @title OpynPerpVault
 * @author Opyn Team
 * @dev implementation of the Opyn Perp Vault contract for covered calls using as collateral the underlying.
 */

contract OpynPerpVault is ERC20, ReentrancyGuard, Ownable {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  enum VaultState {
    Emergency,
    Locked,
    Unlocked
  }

  /// @dev actions that build up this strategy (vault)
  address[] public actions;

  /// @dev address to which all withdrawal fees are sent
  address public feeWithdrawalRecipient;

  /// @dev address to which all performance fees are sent
  address public feePerformanceRecipient;

  /// @dev address of the underlying address
  address public underlying;

  uint256 public constant BASE = 10000; // 100%

  /// @dev Cap for the vault. hardcoded at 1000 for initial release
  uint256 public cap = 1000 ether;

  /// @dev withdrawal fee percentage. 50 being 0.5%
  uint256 public withdrawalFeePercentage = 50;

  /// @dev what percentage should be reserved in vault for withdraw. 1000 being 10%
  uint256 public withdrawReserve = 0;

   /// @dev performance fee percentage. 1000 being 10%
  uint256 public performanceFeePercentage = 1000;

  VaultState public state;
  VaultState public stateBeforePause;

  /*=====================
   *       Events       *
   *====================*/

  event CapUpdated(uint256 newCap);

  event Deposit(address account, uint256 amountDeposited, uint256 shareMinted);

  event Rollover(uint256[] allocations);

  event StateUpdated(VaultState state);

  event FeeSent(uint256 amount, address feeRecipient);

  event Withdraw(address account, uint256 amountWithdrawn, uint256 shareBurned);

  /*=====================
   *     Modifiers      *
   *====================*/

  /** 
   * @dev can only be called if actions are initialized 
   */
  function actionsInitialized() private view {
    require(actions.length > 0, "O1");
  }
  
  /**
   * @dev can only be executed if vault is not in emergency state
   */
  function notEmergency() private view {
    require(state != VaultState.Emergency, "O2");
  }

  /*=====================
   * external function *
   *====================*/

  constructor (
    address _underlying,
    address _feeWithdrawalRecipient,
    address _feePerformanceRecipient,
    string memory _tokenName,
    string memory _tokenSymbol
    ) ERC20(_tokenName, _tokenSymbol) {
    underlying = _underlying;
    feeWithdrawalRecipient = _feeWithdrawalRecipient;
    feePerformanceRecipient = _feePerformanceRecipient;
    state = VaultState.Unlocked;
  }

  function setActions(address[] memory _actions) external onlyOwner {
    require(actions.length == 0, "O3");

    // assign actions
    for(uint256 i = 0 ; i < _actions.length; i++ ) {
      // check all items before actions[i], does not equal to action[i]
      require(_actions[i] != address(0), "O4");

      for(uint256 j = 0; j < i; j++) {
        require(_actions[i] != _actions[j], "O5");
      }

      actions.push(_actions[i]);
    }
  }

  /** 
   * @notice allows owner to change the cap
   */
   function setCap(uint256 _newCap) external onlyOwner {
     cap = _newCap;

     emit CapUpdated(_newCap);
   }

  /**
   * @notice total underlying controlled by this vault
   */
  function totalUnderlyingAsset() public view returns (uint256) {
    uint256 debt = 0;
    uint256 length = actions.length;

    for (uint256 i = 0; i < length; i++) {
      debt = debt.add(IAction(actions[i]).currentValue());
    }

    return _balance().add(debt);
  }

  /**
   * @dev return how much underlying you can get if you burn the number of shares, after charging the withdrawal fee.
   */
  function getWithdrawAmountByShares(uint256 _shares) external view returns (uint256) {
    uint256 withdrawAmount = _getWithdrawAmountByShares(_shares);
    return withdrawAmount.sub(_getWithdrawFee(withdrawAmount));
  }

  /**
   * @notice deposits underlying into the contract and mints vault shares. 
   * @dev deposit into the contract, then mint the shares to depositor, and emit the deposit event
   * @param amount amount of underlying to deposit 
   */
  function depositUnderlying(uint256 amount) external nonReentrant {
    notEmergency();
    actionsInitialized();
    require(amount > 0, 'O6');

    // keep track of underlying balance before
    uint256 totalUnderlyingBeforeDeposit = totalUnderlyingAsset();

    // deposit underlying to vault
    IERC20 underlyingToken = IERC20(underlying);
    underlyingToken.safeTransferFrom(msg.sender, address(this), amount);
  
    // keep track of underlying balance after
    uint256 totalUnderlyingAfterDeposit = totalUnderlyingAsset();
    require(totalUnderlyingAfterDeposit < cap, 'O7');
    require(totalUnderlyingAfterDeposit.sub(totalUnderlyingBeforeDeposit) == amount, 'O19');

    // mint shares and emit event
    uint256 share = _getSharesByDepositAmount(amount, totalUnderlyingBeforeDeposit);

    emit Deposit(msg.sender, amount, share);

    _mint(msg.sender, share);   
  }

  /**
   * @notice withdraws underlying from vault using vault shares
   * @dev burns shares, sends underlying to user, sends withdrawal fee to withdrawal fee recepient
   * @param _share is the number of vault shares to be burned
   */
  function withdrawUnderlying(uint256 _share) external nonReentrant {
    notEmergency();
    actionsInitialized();

    // keep track of underlying balance before
    IERC20 underlyingToken = IERC20(underlying);
    uint256 totalUnderlyingBeforeWithdrawal = totalUnderlyingAsset();

    // withdraw underlying from vault
    uint256 underlyingToRecipientBeforeFees = _getWithdrawAmountByShares(_share);
    uint256 fee = _getWithdrawFee(underlyingToRecipientBeforeFees);
    uint256 underlyingToRecipientAfterFees = underlyingToRecipientBeforeFees.sub(fee);
    require(underlyingToRecipientBeforeFees <= _balance(), 'O8');

    console.log("Fee Recipient: %s",feeWithdrawalRecipient);

    // burn shares
    _burn(msg.sender, _share);

    // transfer withdrawal fee to recipient 
    underlyingToken.safeTransfer(feeWithdrawalRecipient, fee);
    emit FeeSent(fee, feeWithdrawalRecipient);

    // send underlying to user
    underlyingToken.safeTransfer(msg.sender, underlyingToRecipientAfterFees);

    // keep track of underlying balance after
    uint256 totalUnderlyingAfterWithdrawal = totalUnderlyingAsset();
    require(totalUnderlyingBeforeWithdrawal.sub(totalUnderlyingAfterWithdrawal) == underlyingToRecipientBeforeFees, 'O20');

    emit Withdraw(msg.sender, underlyingToRecipientAfterFees, _share);
  }

  /**
   * @notice anyone can call this to close out the previous round by calling "closePositions" on all actions. 
   * @notice can only be called when the vault is locked. It sets the state to unlocked and brings funds from each action to the vault.
   * @dev iterrate through each action, close position and withdraw funds
   */
  function closePositions() public {
    actionsInitialized();
    require(state == VaultState.Locked, "O11");
    state = VaultState.Unlocked;

    address cacheAddress = underlying;
    address[] memory cacheActions = actions;
    for (uint256 i = 0; i < cacheActions.length; i = i + 1) {

      // asset amount used in minting options for cycle
      uint256 lockedAsset = IAction(cacheActions[i]).currentLockedAsset();

      // 1. close position. this should revert if any position is not ready to be closed.
      IAction(cacheActions[i]).closePosition();

      // 2. withdraw underlying from the action
      uint256 actionBalance = IERC20(cacheAddress).balanceOf(cacheActions[i]);
      uint256 netActionBalance;

      if (actionBalance > 0){
          netActionBalance = actionBalance;
              
          // check if performance fee applies and strategy was profitable
          if(performanceFeePercentage > 0 && actionBalance > lockedAsset){
            
            // get profit 
            uint256 profit = actionBalance.sub(lockedAsset);
            uint256 performanceFee = _getPerformanceFee(profit);
            
            // transfer performance fee
            IERC20(cacheAddress).safeTransferFrom(cacheActions[i], feePerformanceRecipient, performanceFee);
            emit FeeSent(performanceFee, feePerformanceRecipient);

            // update action net balance 
            netActionBalance = actionBalance.sub(performanceFee);
          }
        
          // underlying back to vault 
          IERC20(cacheAddress).safeTransferFrom(cacheActions[i], address(this), netActionBalance);
      }
       
    }

    emit StateUpdated(VaultState.Unlocked);
  }

  /**
   * @notice can only be called when the vault is unlocked. It sets the state to locked and distributes funds to each action.
   */
  function rollOver(uint256[] calldata _allocationPercentages) external onlyOwner nonReentrant {
    actionsInitialized();
    require(_allocationPercentages.length == actions.length, 'O12');
    require(state == VaultState.Unlocked, "O13");
    state = VaultState.Locked;

    address cacheAddress = underlying;
    address[] memory cacheActions = actions;

    uint256 cacheBase = BASE;
    uint256 cacheTotalAsset = totalUnderlyingAsset();
    // keep track of total percentage to make sure we're summing up to 100%
    uint256 sumPercentage = withdrawReserve;

    for (uint256 i = 0; i < _allocationPercentages.length; i = i + 1) {
      sumPercentage = sumPercentage.add(_allocationPercentages[i]);
      require(sumPercentage <= cacheBase, 'O14');

      uint256 newAmount = cacheTotalAsset.mul(_allocationPercentages[i]).div(cacheBase);

      if (newAmount > 0) IERC20(cacheAddress).safeTransfer(cacheActions[i], newAmount);
      IAction(cacheActions[i]).rolloverPosition();
    }
    
    require(sumPercentage == cacheBase, 'O15');

    emit Rollover(_allocationPercentages);
    emit StateUpdated(VaultState.Locked);
  }

   /**
   * @dev set the vault withdrawal fee recipient
   */
  function setWithdrawalFeeRecipient(address _newWithdrawalFeeRecipient) external onlyOwner {
    feeWithdrawalRecipient = _newWithdrawalFeeRecipient;
  }

   /**
   * @dev set the vault performance fee recipient
   */
  function setPerformanceFeeRecipient(address _newPerformanceFeeRecipient) external onlyOwner {
    feePerformanceRecipient = _newPerformanceFeeRecipient;
  }

  /**
   * @dev set the vault fee recipient - use when performance fee and withdrawal fee is sent to the same recipient
   */
  function setFeeRecipient(address _newFeeRecipient) external onlyOwner {
    feeWithdrawalRecipient = _newFeeRecipient;
    feePerformanceRecipient = _newFeeRecipient;
  }

  /**
   * @dev set the percentage fee that should be applied upon withdrawal
   */
  function setWithdrawalFeePercentage(uint256 _newWithdrawalFeePercentage) external onlyOwner {
    withdrawalFeePercentage = _newWithdrawalFeePercentage;
  }

  /**
   * @dev set the percentage fee that should be applied on profits at the end of cycles 
   */
  function setPerformanceFeePercentage(uint256 _newPerformanceFeePercentage) external onlyOwner {
    performanceFeePercentage = _newPerformanceFeePercentage;
  }

  /**
   * @dev set the percentage that should be reserved in vault for withdraw
   */
  function setWithdrawReserve(uint256 _reserve) external onlyOwner {
    require(_reserve < 5000, "O16");
    withdrawReserve = _reserve;
  }

  /**
   * @dev set the state to "Emergency", which disable all withdraw and deposit
   */
  function emergencyPause() external onlyOwner {
    require(state != VaultState.Emergency, "O17");

    stateBeforePause = state;
    state = VaultState.Emergency;

    emit StateUpdated(VaultState.Emergency);
  }

  /**
   * @dev set the state from "Emergency", which disable all withdraw and deposit
   */
  function resumeFromPause() external onlyOwner {
    require(state == VaultState.Emergency, "O18");

    state = stateBeforePause;

    emit StateUpdated(stateBeforePause);
  }

   /**
   * @dev return how many shares you can get if you deposit {_amount} underlying
   * @param _amount amount of token depositing
   */
  function getSharesByDepositAmount(uint256 _amount) external view returns (uint256) {
    return _getSharesByDepositAmount(_amount, totalUnderlyingAsset());
  }

  /*=====================
   * Internal functions *
   *====================*/
  /**
   * @dev returns remaining underlying balance in the vault.
   */
  function _balance() internal view returns (uint256) {
    return IERC20(underlying).balanceOf(address(this));
  }

  /**
   * @dev return how many shares you can get if you deposit {_amount} underlying
   * @param _amount amount of underlying depositing
   * @param _totalAssetAmount amount of underlying already in the pool before deposit
   */
  function _getSharesByDepositAmount(uint256 _amount, uint256 _totalAssetAmount) internal view returns (uint256) {
    uint256 shareSupply = totalSupply();

    // share amount
    return shareSupply == 0 ? _amount : _amount.mul(shareSupply).div(_totalAssetAmount);
  }

  /**
   * @dev return how much underlying you can get if you burn the number of shares
   */
  function _getWithdrawAmountByShares(uint256 _share) internal view returns (uint256) {
    // withdrawal amount
    return _share.mul(totalUnderlyingAsset()).div(totalSupply());
  }

  /**
   * @dev get amount of fee charged based on total amount of underlying withdrawing.
   */
  function _getWithdrawFee(uint256 _withdrawAmount) internal view returns (uint256) {
    return _withdrawAmount.mul(withdrawalFeePercentage).div(BASE);
  }

  /**
   * @dev get amount of fee charged based on total profit amount earned in a cycle.
   */
  function _getPerformanceFee(uint256 _profitAmount) internal view returns (uint256) {
    return _profitAmount.mul(performanceFeePercentage).div(BASE);
  }


}
