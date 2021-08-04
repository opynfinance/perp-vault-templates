// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import '@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import { IAction } from '../interfaces/IAction.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { SafeERC20 } from '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';
import { SafeMath } from '@openzeppelin/contracts/math/SafeMath.sol';
import { IStakeDao } from '../interfaces/IStakeDao.sol';
import { ICurve } from '../interfaces/ICurve.sol';

import "hardhat/console.sol";

contract OpynPerpVault is ERC20Upgradeable, ReentrancyGuardUpgradeable, OwnableUpgradeable {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  enum VaultState {
    Locked,
    Unlocked,
    Emergency
  }

  VaultState public state;

  VaultState public stateBeforePause;

  uint256 public constant BASE = 10000; // 100%

  /// @dev how many percentage should be reserved in vault for withdraw. 1000 being 10%
  uint256 public withdrawReserve;

  /// @dev stake dao sdToken
  address public sdToken;

  /// @dev address to which all fees are sent 
  address public feeRecipient;

  /// @dev actions that build up this strategy (vault)
  address[] public actions;

  /// @dev Cap for the vault. hardcoded at 1000 for initial release
  uint256 constant public CAP = 1000 ether;

  /// @dev curve addres 
  ICurve public curve;

  /*=====================
   *       Events       *
   *====================*/

  event Deposit(address account, uint256 amountDeposited, uint256 shareMinted);

  event Withdraw(address account, uint256 amountWithdrawn, uint256 fee, uint256 shareBurned);

  event Rollover(uint256[] allocations);

  event StateUpdated(VaultState state);

  /*=====================
   *     Modifiers      *
   *====================*/
  
  /**
   * @dev can only be executed and unlock state. which bring the state back to "locked"
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
    address _sdToken,
    address _curve,
    address _owner,
    address _feeRecipient,
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

    sdToken = _sdToken;
    feeRecipient = _feeRecipient;
    curve = ICurve(_curve);

    // assign actions
    for(uint256 i = 0 ; i < _actions.length; i++ ) {
      // check all items before actions[i], does not equal to action[i]
      for(uint256 j = 0; j < i; j++) {
        require(_actions[i] != _actions[j], "duplicated action");
      }
      actions.push(_actions[i]);
    }

    state = VaultState.Unlocked;
  }

  /**
   * total sdTokens controlled by this vault
   */
  function totalStakedaoAsset() external view returns (uint256) {
    return _totalStakedaoAsset();
  }

  /**
   * total eth value of the sdTokens controlled by this vault
   */
  function totalETHControlled() external view returns (uint256) { 
    uint256 sdTokenBalance = _totalStakedaoAsset();
    IStakeDao stakedao = IStakeDao(sdToken);
    return sdTokenBalance.mul(stakedao.getPricePerFullShare()).mul(curve.get_virtual_price()).div(10**36);
  }

  /**
   * @dev return how many sdToken you can get if you burn the number of shares, after charging the fee.
   */
  function getWithdrawAmountByShares(uint256 _shares) external view returns (uint256) {
    uint256 withdrawAmount = _getWithdrawAmountByShares(_shares);
    uint256 fee = _getWithdrawFee(withdrawAmount);
    return withdrawAmount.sub(fee);
  }

  /**
   * @notice Deposits ETH into the contract and mint vault shares. 
   */
  function depositETH() external payable nonReentrant notEmergency{
    require(msg.value > 0, '!VALUE');

    _deposit(msg.value);
  }

  /**
   * @notice Withdraws ETH from vault using vault shares
   * @param share is the number of vault shares to be burned
   */
  function withdrawETH(uint256 share) external nonReentrant notEmergency {
    uint256 withdrawAmount = _withdraw(share);

    (bool success, ) = msg.sender.call{ value: withdrawAmount }('');
    require(success, 'ETH transfer failed');
  }

  /**
   * @dev anyone can call this to close out the previous round by calling "closePositions" on all actions
   */
  function closePositions() public unlocker {
    _closeAndWithdraw();
  }

  /**
   * @dev distribute funds to each action
   */
  function rollOver(uint256[] calldata _allocationPercentages) external onlyOwner locker {
    require(_allocationPercentages.length == actions.length, 'INVALID_INPUT');

    emit Rollover(_allocationPercentages);

    _distribute(_allocationPercentages);
  }

  /**
   * @dev set the percentage that should be reserved in vault for withdraw
   */
  function setWithdrawReserve(uint256 _reserve) external onlyOwner {
    require(_reserve < 5000, "Reserve cannot exceed 50%");
    withdrawReserve = _reserve;
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

   /**
   * @dev return how many shares you can get if you deposit {_amount} sdToken
   * @param _amount amount of token depositing
   */
  function getSharesByDepositAmount(uint256 _amount) external view returns (uint256) {
    return _getSharesByDepositAmount(_amount, _totalStakedaoAsset());
  }

  /*=====================
   * Internal functions *
   *====================*/

  /**
   * total sdTokens controlled by this vault
   */
  function _totalStakedaoAsset() internal view returns (uint256) {
    return _balance().add(_totalDebt());
  }

  /**
   * @dev returns remaining sdToken balance in the vault.
   */
  function _balance() internal view returns (uint256) {
    return IERC20(sdToken).balanceOf(address(this));
  }

  /**
   * @dev iterate through all actions and sum up "values" controlled by the action.
   */
  function _totalDebt() internal view returns (uint256) {
    uint256 debt = 0;
    for (uint256 i = 0; i < actions.length; i++) {
      debt = debt.add(IAction(actions[i]).currentValue());
    }
    return debt;
  }

  /**
   * @dev deposit into curve, then into stakedao, then mint the shares to depositor, and emit the deposit event
   */
  function _deposit(uint256 _amount) internal {
    // the sdToken is already deposited into the contract at this point, need to substract it from total
    uint256[2] memory amounts;
    amounts[0] = _amount;
    amounts[1] = 0;
    uint256 minAmount = 0;

    // deposit ETH to curve
    curve.add_liquidity{value:_amount}(amounts, minAmount);

    // keep track of balance before
    uint256 totalSDTokenBalanceBeforeDeposit = _totalStakedaoAsset();

    // deposit ecrv to stakedao
    IStakeDao stakedao = IStakeDao(sdToken);
    IERC20 ecrv = stakedao.token();
    uint256 ecrvToDeposit = ecrv.balanceOf(address(this));
    ecrv.safeApprove(sdToken, 0);
    ecrv.safeApprove(sdToken, ecrvToDeposit);
    stakedao.deposit(ecrvToDeposit);

    // mint shares and emit event 
    uint256 totalWithDepositedAmount = _totalStakedaoAsset();
    require(totalWithDepositedAmount < CAP, 'Cap exceeded');
    uint256 sdTokenDeposited = totalWithDepositedAmount.sub(totalSDTokenBalanceBeforeDeposit);
    uint256 share = _getSharesByDepositAmount(sdTokenDeposited, totalSDTokenBalanceBeforeDeposit);

    emit Deposit(msg.sender, _amount, share);

    _mint(msg.sender, share);
  }

  /**
   * @dev iterrate through each action, close position and withdraw funds
   */
  function _closeAndWithdraw() internal {
    address cacheAsset = sdToken;
    for (uint8 i = 0; i < actions.length; i = i + 1) {
      // 1. close position. this should revert if any position is not ready to be closed.
      IAction(actions[i]).closePosition();

      // 2. withdraw sdTokens
      uint256 actionBalance = IERC20(cacheAsset).balanceOf(actions[i]);
      if (actionBalance > 0)
        IERC20(cacheAsset).safeTransferFrom(actions[i], address(this), actionBalance);
    }
  }

  /**
   * @dev redistribute all funds to diff actions
   */
  function _distribute(uint256[] memory _percentages) internal nonReentrant {
    uint256 cacheTotalAsset = _totalStakedaoAsset();
    uint256 cacheBase = BASE;

    // keep track of total percentage to make sure we're summing up to 100%
    uint256 sumPercentage = withdrawReserve;
    address cacheAsset = sdToken;

    for (uint8 i = 0; i < actions.length; i = i + 1) {
      sumPercentage = sumPercentage.add(_percentages[i]);
      require(sumPercentage <= cacheBase, 'PERCENTAGE_SUM_EXCEED_MAX');

      uint256 newAmount = cacheTotalAsset.mul(_percentages[i]).div(cacheBase);

      if (newAmount > 0) IERC20(cacheAsset).safeTransfer(actions[i], newAmount);
      IAction(actions[i]).rolloverPosition();
    }

    require(sumPercentage == cacheBase, 'PERCENTAGE_DOESNT_ADD_UP');
  }

  /**
   * @dev burn shares, return withdraw amount handle by withdraw or withdrawETH
   * @param _share amount of shares burn to withdraw sdToken.
   */
  function _withdraw(uint256 _share) internal returns (uint256) {
    uint256 currentAssetBalance = _balance();
    uint256 withdrawAmount = _getWithdrawAmountByShares(_share);
    require(withdrawAmount <= currentAssetBalance, 'NOT_ENOUGH_BALANCE');

    // withdraw from stakedao and curve
    IStakeDao stakedao = IStakeDao(sdToken);
    IERC20 ecrv = stakedao.token();
    stakedao.withdraw(withdrawAmount);
    uint256 ecrvBalance = ecrv.balanceOf(address(this));
    uint256 ethReceived = curve.remove_liquidity_one_coin(ecrvBalance, 0, 0);

    _burn(msg.sender, _share);

    // send fee to recipient 
    uint256 fee = _getWithdrawFee(ethReceived);
    (bool success, ) = feeRecipient.call{ value: fee }('');
    require(success, 'ETH transfer failed');

    uint256 amountPostFee = ethReceived.sub(fee);

    emit Withdraw(msg.sender, amountPostFee, fee, _share);

    return amountPostFee;
  }

  /**
   * @dev return how many shares you can get if you deposit {_amount} sdToken
   * @param _amount amount of token depositing
   * @param _totalAssetAmount amont of sdToken already in the pool before deposit
   */
  function _getSharesByDepositAmount(uint256 _amount, uint256 _totalAssetAmount) internal view returns (uint256) {
    uint256 shareSupply = totalSupply();

    uint256 shares = shareSupply == 0 ? _amount : _amount.mul(shareSupply).div(_totalAssetAmount);
    return shares;
  }

  /**
   * @dev return how many sdToken you can get if you burn the number of shares
   */
  function _getWithdrawAmountByShares(uint256 _share) internal view returns (uint256) {
    uint256 totalAssetAmount = _totalStakedaoAsset();
    uint256 shareSupply = totalSupply();
    uint256 withdrawAmount = _share.mul(totalAssetAmount).div(shareSupply);
    return withdrawAmount;
  }

  /**
   * @dev get amount of fee charged based on total amount of weth withdrawing.
   */
  function _getWithdrawFee(uint256 _withdrawAmount) internal pure returns (uint256) {
    // todo: add fee model
    // currently fixed at 0.5% 
    return _withdrawAmount.mul(50).div(BASE);
  }

  /**
    * @notice the receive ether function is called whenever the call data is empty
    */
  receive() external payable {
    require(msg.sender == address(curve), "Cannot receive ETH");
  }
}
