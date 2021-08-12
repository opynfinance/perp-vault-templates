// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import '@openzeppelin/contracts/access/Ownable.sol';
import { IAction } from '../interfaces/IAction.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { SafeERC20 } from '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';
import { SafeMath } from '@openzeppelin/contracts/math/SafeMath.sol';
import { IStakeDao } from '../interfaces/IStakeDao.sol';
import { ICurve } from '../interfaces/ICurve.sol';

import "hardhat/console.sol";

/** 
 * @dev implementation of the Opyn Perp Vault contract that works with stakedao's ETH strategy. 
 * Note that this implementation is meant to only specifically work for the stakedao ETH strategy and is not 
 * a generalized contract. Stakedao's ETH strategy currently accepts curvePool LP tokens called ecrv from the 
 * sETH-ETH curvePool pool. This strategy allows users to convert their ETH into yield earning sdecrv tokens
 * and use the sdecrv tokens as collateral to sell ETH call options on Opyn. 
 */

contract OpynPerpVault is ERC20, ReentrancyGuard, Ownable {
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

  /// @dev stake dao sdecrvAddress
  address public sdecrvAddress;

  /// @dev address to which all fees are sent 
  address public feeRecipient;

  /// @dev actions that build up this strategy (vault)
  address[] public actions;

  /// @dev Cap for the vault. hardcoded at 1000 for initial release
  uint256 public cap = 1000 ether;

  /// @dev curvePool ETH/sETH stableswap 
  ICurve public curvePool;

  /*=====================
   *       Events       *
   *====================*/

  event Deposit(address account, uint256 amountDeposited, uint256 shareMinted);

  event Withdraw(address account, uint256 amountWithdrawn, uint256 fee, uint256 shareBurned);

  event Rollover(uint256[] allocations);

  event StateUpdated(VaultState state);

  event CapUpdated(uint256 newCap);

  /*=====================
   *     Modifiers      *
   *====================*/

  /** 
   * @dev can only be called if actions are initialized 
   */
  modifier actionsInitialized {
    require(actions.length > 0, "!Actions");
    _;
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

  constructor (
    address _sdecrvAddress,
    address _curvePool,
    address _feeRecipient,
    string memory _tokenName,
    string memory _tokenSymbol
    ) ERC20(_tokenName, _tokenSymbol) public {     
    sdecrvAddress = _sdecrvAddress;
    feeRecipient = _feeRecipient;
    curvePool = ICurve(_curvePool);
    state = VaultState.Unlocked;
  }

  function setActions(address[] memory _actions) external onlyOwner {
    require(actions.length == 0, "actions already initialized");
    // assign actions
    for(uint256 i = 0 ; i < _actions.length; i++ ) {
      // check all items before actions[i], does not equal to action[i]
      require(_actions[i] != address(0), "invalid address");
      for(uint256 j = 0; j < i; j++) {
        require(_actions[i] != _actions[j], "duplicated action");
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
   * @notice total sdecrv controlled by this vault
   */
  function totalStakedaoAsset() public view returns (uint256) {
    uint256 debt = 0;
    for (uint256 i = 0; i < actions.length; i++) {
      debt = debt.add(IAction(actions[i]).currentValue());
    }
    return _balance().add(debt);
  }

  /**
   * total eth value of the sdecrv controlled by this vault
   */
  function totalETHControlled() external view returns (uint256) { 
    uint256 sdecrvBalance = totalStakedaoAsset();
    IStakeDao sdecrv = IStakeDao(sdecrvAddress);
    // hard coded to 36 because ecrv and sdecrv are both 18 decimals. 
    return sdecrvBalance.mul(sdecrv.getPricePerFullShare()).mul(curvePool.get_virtual_price()).div(10**36);
  }

  /**
   * @dev return how many sdecrv you can get if you burn the number of shares, after charging the fee.
   */
  function getWithdrawAmountByShares(uint256 _shares) external view returns (uint256) {
    uint256 withdrawAmount = _getWithdrawAmountByShares(_shares);
    uint256 fee = _getWithdrawFee(withdrawAmount);
    return withdrawAmount.sub(fee);
  }

  /**
   * @notice Deposits ETH into the contract and mint vault shares. 
   * @dev deposit into the curvePool, then into stakedao, then mint the shares to depositor, and emit the deposit event
   * @param minEcrv minimum amount of ecrv to get out from adding liquidity. 
   */
  function depositETH(uint256 minEcrv) external payable nonReentrant notEmergency actionsInitialized {
    uint256 amount = msg.value;
    require( amount > 0, '!VALUE');

    // the sdecrv is already deposited into the contract at this point, need to substract it from total
    uint256[2] memory amounts;
    amounts[0] = amount;
    amounts[1] = 0;

    // deposit ETH to curvePool
    curvePool.add_liquidity{value:amount}(amounts, minEcrv);

    // keep track of balance before
    uint256 totalSdecrvBalanceBeforeDeposit = totalStakedaoAsset();

    // deposit ecrv to stakedao
    IStakeDao sdecrv = IStakeDao(sdecrvAddress);
    IERC20 ecrv = sdecrv.token();
    uint256 ecrvToDeposit = ecrv.balanceOf(address(this));
    ecrv.safeApprove(sdecrvAddress, 0);
    ecrv.safeApprove(sdecrvAddress, ecrvToDeposit);
    sdecrv.deposit(ecrvToDeposit);

    // mint shares and emit event 
    uint256 totalWithDepositedAmount = totalStakedaoAsset();
    require(totalWithDepositedAmount < cap, 'Cap exceeded');
    uint256 sdecrvDeposited = totalWithDepositedAmount.sub(totalSdecrvBalanceBeforeDeposit);
    uint256 share = _getSharesByDepositAmount(sdecrvDeposited, totalSdecrvBalanceBeforeDeposit);

    emit Deposit(msg.sender, amount, share);

    _mint(msg.sender, share);
  }

  /**
   * @notice Withdraws ETH from vault using vault shares
   * @dev burns shares, withdraws ecrv from stakdao, withdraws ETH from curvePool
   * @param _share is the number of vault shares to be burned
   */
  function withdrawETH(uint256 _share, uint256 minEth) external nonReentrant notEmergency actionsInitialized {
    uint256 currentSdecrvBalance = _balance();
    uint256 sdecrvToWithdraw = _getWithdrawAmountByShares(_share);
    require(sdecrvToWithdraw <= currentSdecrvBalance, 'NOT_ENOUGH_BALANCE');

    _burn(msg.sender, _share);

    // withdraw from stakedao and curvePool
    IStakeDao sdecrv = IStakeDao(sdecrvAddress);
    IERC20 ecrv = sdecrv.token();
    sdecrv.withdraw(sdecrvToWithdraw);
    uint256 ecrvBalance = ecrv.balanceOf(address(this));
    uint256 ethReceived = curvePool.remove_liquidity_one_coin(ecrvBalance, 0, minEth);

    // calculate fees
    uint256 fee = _getWithdrawFee(ethReceived);
    uint256 ethOwedToUser = ethReceived.sub(fee);

    // send fee to recipient 
    (bool success1, ) = feeRecipient.call{ value: fee }('');
    require(success1, 'ETH transfer failed');

    // send ETH to user
    (bool success2, ) = msg.sender.call{ value: ethOwedToUser }('');
    require(success2, 'ETH transfer failed');

    emit Withdraw(msg.sender, ethOwedToUser, fee, _share);
  }

  /**
   * @notice anyone can call this to close out the previous round by calling "closePositions" on all actions. 
   * @dev iterrate through each action, close position and withdraw funds
   */
  function closePositions() public actionsInitialized {
    require(state == VaultState.Locked, "!Locked");
    state = VaultState.Unlocked;

    address cacheAddress = sdecrvAddress;
    for (uint8 i = 0; i < actions.length; i = i + 1) {
      // 1. close position. this should revert if any position is not ready to be closed.
      IAction(actions[i]).closePosition();

      // 2. withdraw sdecrv
      uint256 actionBalance = IERC20(cacheAddress).balanceOf(actions[i]);
      if (actionBalance > 0)
        IERC20(cacheAddress).safeTransferFrom(actions[i], address(this), actionBalance);
    }

    emit StateUpdated(VaultState.Unlocked);
  }

  /**
   * @notice can only be called when the vault is unlocked. It sets the state to locked and distributes funds to each action.
   */
  function rollOver(uint256[] calldata _allocationPercentages) external onlyOwner nonReentrant actionsInitialized {
    require(_allocationPercentages.length == actions.length, 'INVALID_INPUT');
    require(state == VaultState.Unlocked, "!Unlocked");
    state = VaultState.Locked;

    uint256 cacheTotalAsset = totalStakedaoAsset();
    uint256 cacheBase = BASE;

    // keep track of total percentage to make sure we're summing up to 100%
    uint256 sumPercentage = withdrawReserve;
    address cacheAddress = sdecrvAddress;

    for (uint8 i = 0; i < actions.length; i = i + 1) {
      sumPercentage = sumPercentage.add(_allocationPercentages[i]);
      require(sumPercentage <= cacheBase, 'PERCENTAGE_SUM_EXCEED_MAX');

      uint256 newAmount = cacheTotalAsset.mul(_allocationPercentages[i]).div(cacheBase);

      if (newAmount > 0) IERC20(cacheAddress).safeTransfer(actions[i], newAmount);
      IAction(actions[i]).rolloverPosition();
    }

    require(sumPercentage == cacheBase, 'PERCENTAGE_DOESNT_ADD_UP');

    emit Rollover(_allocationPercentages);
    emit StateUpdated(VaultState.Locked);
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
   * @dev return how many shares you can get if you deposit {_amount} sdecrv
   * @param _amount amount of token depositing
   */
  function getSharesByDepositAmount(uint256 _amount) external view returns (uint256) {
    return _getSharesByDepositAmount(_amount, totalStakedaoAsset());
  }

  /*=====================
   * Internal functions *
   *====================*/

  /**
   * @dev returns remaining sdecrv balance in the vault.
   */
  function _balance() internal view returns (uint256) {
    return IERC20(sdecrvAddress).balanceOf(address(this));
  }

  /**
   * @dev return how many shares you can get if you deposit {_amount} sdecrv
   * @param _amount amount of token depositing
   * @param _totalAssetAmount amont of sdecrv already in the pool before deposit
   */
  function _getSharesByDepositAmount(uint256 _amount, uint256 _totalAssetAmount) internal view returns (uint256) {
    uint256 shareSupply = totalSupply();

    uint256 shares = shareSupply == 0 ? _amount : _amount.mul(shareSupply).div(_totalAssetAmount);
    return shares;
  }

  /**
   * @dev return how many sdecrv you can get if you burn the number of shares
   */
  function _getWithdrawAmountByShares(uint256 _share) internal view returns (uint256) {
    uint256 totalAssetAmount = totalStakedaoAsset();
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
    require(msg.sender == address(curvePool), "Cannot receive ETH");
  }
}
