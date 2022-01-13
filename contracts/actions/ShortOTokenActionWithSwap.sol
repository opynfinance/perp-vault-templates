// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import { SafeMath } from '@openzeppelin/contracts/math/SafeMath.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { SafeERC20 } from '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';

import { IAction } from '../interfaces/IAction.sol';
import { IController } from '../interfaces/IController.sol';
import { IOracle } from '../interfaces/IOracle.sol';
import { IOToken } from '../interfaces/IOToken.sol';
import { IWETH } from '../interfaces/IWETH.sol'; 
import { SwapTypes } from '../libraries/SwapTypes.sol';
import { AirswapBase } from '../utils/AirswapBase.sol';
import { RollOverBase } from '../utils/RollOverBase.sol';
/**
 * Error Codes
 * S1: msg.sender must be the vault
 * S2: cannot currently close the vault position
 * S3: seller for the order (_order.sender.wallet) must be this contract
 * S4: token to sell (_order.sender.token) must be the currently activated oToken
 * S5: token to sell for (_order.signer.token) must be the underlying
 * S6: tokens being sold (_order.sender.amount) and tokens being minted (_otokenAmount) must be the same
 * S7: amount of underlying being sold for (_order.signer.amount) does not meet the minimum option premium
 * S8: strike price for the next oToken is too low
 * S9: expiry timestamp for the next oToken is invalid
 */

/**
 * @title ShortOTokenActionWithSwap
 * @author Opyn Team
 */

contract ShortOTokenActionWithSwap is IAction, AirswapBase, RollOverBase {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  address public immutable vault;

   /// @dev 100%
  uint256 constant public BASE = 10000;
  /// @dev the minimum strike price of the option chosen needs to be at least 105% of spot. 
  /// This is set expecting the contract to be a strategy selling calls. For puts should change this. 
  uint256 constant public MIN_STRIKE = 10500;
  uint256 public MIN_PROFITS; // 100 being 1%
  uint256 public lockedAsset;
  uint256 public rolloverTime;

  IController public controller;
  IOracle public oracle;
  IERC20 underlying;

  event MintAndSellOToken(uint256 collateralAmount, uint256 otokenAmount, uint256 premium);

  constructor(
    address _vault,
    address _swap,
    address _opynWhitelist,
    address _controller,
    uint256 _vaultType,
    address _underlying,
    uint256 _min_profits
  ) {
    MIN_PROFITS = _min_profits;
    vault = _vault;
    underlying = IERC20(_underlying);

    controller = IController(_controller);

    oracle = IOracle(controller.oracle());

    // enable vault to take all the underlying back and re-distribute.
    underlying.safeApprove(_vault, uint256(-1));

    // enable pool contract to pull underlying from this contract to mint options.
    underlying.safeApprove(controller.pool(), uint256(-1));

    _initSwapContract(_swap);
    _initRollOverBase(_opynWhitelist);

    _openVault(_vaultType);
  }

  function onlyVault() private view {
    require(msg.sender == vault, "S1");
  }

  /**
   * @dev return the net worth of this strategy, in terms of underlying.
   * if the action has an opened gamma vault, see if there's any short position
   */
  function currentValue() external view override returns (uint256) {
    return underlying.balanceOf(address(this)).add(lockedAsset);
    
    // todo: caclulate cash value to avoid not early withdraw to avoid loss.
  }

  /**
   * @dev return the amount of locked asset in the action.
   */
  function currentLockedAsset() external view override returns (uint256) {
    return lockedAsset;
  }

  /**
   * @dev the function that the vault will call when the round is over
   */
  function closePosition() external override {
    onlyVault();
    require(canClosePosition(), 'S2');
    
    if(_canSettleVault()) {
      _settleVault();
    }

    // this function can only be called when it's `Activated`
    // go to the next step, which will enable owner to commit next oToken
    _setActionIdle();

    lockedAsset = 0;
  }

  /**
   * @dev the function that the vault will call when the new round is starting
   */
  function rolloverPosition() external override {
    onlyVault();
    
    // this function can only be called when it's `Committed`
    _rollOverNextOTokenAndActivate();
    rolloverTime = block.timestamp;
  }

  /**
   * @dev owner only function to mint options with underlying and sell otokens in this contract 
   * by filling an order on AirSwap.
   * this can only be done in "activated" state. which is achievable by calling `rolloverPosition`
   */
  function mintAndSellOToken(uint256 _collateralAmount, uint256 _otokenAmount, SwapTypes.Order memory _order) external onlyOwner {
    onlyActivated();
    require(_order.sender.wallet == address(this), 'S3');
    require(_order.sender.token == otoken, 'S4');
    require(_order.signer.token == address(underlying), 'S5');
    require(_order.sender.amount == _otokenAmount, 'S6');

    // mint options & lock asset
    _mintOTokens(_collateralAmount, _otokenAmount);
    lockedAsset = lockedAsset.add(_collateralAmount);

    // underlying before minting
    uint256 underlyingBalanceBefore = underlying.balanceOf(address(this));

    // sell options on airswap for underlying
    IERC20(otoken).safeIncreaseAllowance(address(airswap), _order.sender.amount);
    _fillAirswapOrder(_order);

    // check that minimum premium is received & that it is higher than min threshold
    uint256 underlyingBalanceAfter = underlying.balanceOf(address(this));
    uint256 underlyingTokenEarned = underlyingBalanceAfter.sub(underlyingBalanceBefore);
    require(_collateralAmount.mul(MIN_PROFITS).div(BASE) <= underlyingTokenEarned, 'S7');

    emit MintAndSellOToken(_collateralAmount, _otokenAmount, underlyingTokenEarned);
  }

  /**
   * @notice the function will return when someone can close a position. 1 day after rollover, 
   * if the option wasn't sold, anyone can close the position. 
   */
  function canClosePosition() public view returns(bool) {
    if (otoken != address(0) && lockedAsset != 0) { 
      return _canSettleVault();
    }

    return block.timestamp > rolloverTime + 1 days; 
  }

  /**
   * @dev open vault with vaultId 1. this should only be performed once when contract is initiated
   */
  function _openVault(uint256 _vaultType) internal {
    bytes memory data;

    if (_vaultType != 0) {
      data = abi.encode(_vaultType);
    }

    // this action will always use vault id 0
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](1);

    actions[0] = IController.ActionArgs(
        IController.ActionType.OpenVault,
        address(this), // owner
        address(0), // doesn't matter 
        address(0), // doesn't matter
        1, // vaultId
        0, // amount
        0, // index
        data // data
    );

    controller.operate(actions);
  }

  /**
   * @dev mint otoken in vault 1
   */
  function _mintOTokens(uint256 _collateralAmount, uint256 _otokenAmount) internal {
    // this action will always use vault id 1
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](2);
    
    actions[0] = IController.ActionArgs(
        IController.ActionType.DepositCollateral,
        address(this), // vault owner is this address
        address(this), // deposit from this address
        address(underlying), // collateral is the underlying
        1, // vaultId is 1
        _collateralAmount, // amount of underlying to deposit
        0, // index
        "" // data
    );

    actions[1] = IController.ActionArgs(
        IController.ActionType.MintShortOption,
        address(this), // vault owner is this address
        address(this), // mint to this address
        otoken, // otoken to mint
        1, // vaultId is 1
        _otokenAmount, // amount of otokens to mint
        0, // index
        "" // data
    );
    
    controller.operate(actions);
  }

  /**
   * @dev settle vault 1 and withdraw all locked collateral
   */
  function _settleVault() internal {
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](1);
    // this action will always use vault id 1
    actions[0] = IController.ActionArgs(
        IController.ActionType.SettleVault,
        address(this), // owner is this address
        address(this), // recipient is this address
        address(0), // doesn't mtter
        1, // vaultId is 1 
        0, // amount doesn't matter
        0, // index
        "" // data
    );

    controller.operate(actions);
  }

  /**
   * @dev checks if the current vault can be settled
   */
  function _canSettleVault() internal view returns (bool) {
    if (lockedAsset != 0 && otoken != address(0)) {
      return controller.isSettlementAllowed(otoken);
    }

    return false; 
  }
  
  /**
   * @dev funtion to add some custom logic to check the next otoken is valid to this strategy
   * this hook is triggered while action owner calls "commitNextOption"
   * so accessing otoken will give u the current otoken. 
   */
  function _customOTokenCheck(address _nextOToken) internal override view {
    // Can override or replace this.
     require(_isValidStrike(IOToken(_nextOToken).strikePrice()), 'S8');
     require (_isValidExpiry(IOToken(_nextOToken).expiryTimestamp()), 'S9');
    /**
     * e.g.
     * check otoken strike price is lower than current spot price for put.
     * check it's no more than x day til the current otoken expires. (can't commit too early)
     * check there's no previously committed otoken.
     * check otoken expiry is expected
     */
  }

  /**
   * @dev funtion to check that the otoken being sold meets a minimum valid strike price
   * this hook is triggered in the _customOtokenCheck function. 
   */
  function _isValidStrike(uint256 strikePrice) internal view returns (bool) { 
    uint256 spotPrice = oracle.getPrice(address(underlying));
    // checks that the strike price set is > than 105% of current price
    return strikePrice >= spotPrice.mul(MIN_STRIKE).div(BASE);
  }

  /**
   * @dev funtion to check that the otoken being sold meets certain expiry conditions
   * this hook is triggered in the _customOtokenCheck function. 
   */
  function _isValidExpiry(uint256 expiry) internal view returns (bool) {
    // TODO: override with your filler code. 
    // Checks that the token committed to expires within 15 days of commitment. 
    return (block.timestamp).add(15 days) >= expiry;
  }

}
