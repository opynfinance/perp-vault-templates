// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import { ShortOTokenUtils } from '../utils/ShortOTokenUtils.sol';
import { AuctionBase } from '../utils/AuctionBase.sol';
import { RollOverBase } from '../utils/RollOverBase.sol';

import { SwapTypes } from '../libraries/SwapTypes.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { SafeERC20 } from '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';
import { SafeMath } from '@openzeppelin/contracts/math/SafeMath.sol';

import { IController } from '../interfaces/IController.sol';
import { IAction } from '../interfaces/IAction.sol';
import { IOracle } from '../interfaces/IOracle.sol';
import { IOToken } from '../interfaces/IOToken.sol';

contract ShortOTokenWithAuction is IAction, OwnableUpgradeable, AuctionBase, RollOverBase, ShortOTokenUtils {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

   /// @dev 100%
  uint256 constant public BASE = 10000;
  /// @dev the minimum strike price of the option chosen needs to be at least 105% of spot. 
  /// This is set expecting the contract to be a strategy selling calls. For puts should change this. 
  uint256 constant public MIN_STRIKE = 10500;
  uint256 constant public MIN_PROFITS = 100; // 1% 
  uint256 public lockedAsset;
  uint256 public rolloverTime;

  address public immutable vault;
  address public immutable asset;
  IOracle public oracle; 

  constructor(
    address _vault,
    address _asset,
    address _easyAuction,
    address _opynWhitelist,
    address _controller,
    uint256 _vaultType
  ) {
    vault = _vault;
    asset = _asset;

    // enable vault to take all the asset back and re-distribute.
    IERC20(_asset).safeApprove(_vault, uint256(-1));

    _initShort(_controller);

    // enable pool contract to pull asset from this contract to mint options.
    address pool = controller.pool();
    
    oracle = IOracle(controller.oracle());
    
    IERC20(_asset).safeApprove(pool, uint256(-1));

    _initAuctionBase(_easyAuction);
    _initRollOverBase(_opynWhitelist);
    __Ownable_init();

    _openGammaVault(_vaultType);
  }

  modifier onlyVault() {
    require(msg.sender == vault, "!VAULT");

    _;
  }

  /**
   * @dev return the net worth of this strategy, in terms of asset.
   * if the action has an opened gamma vault, see if there's any short position
   */
  function currentValue() external view override returns (uint256) {
    uint256 assetBalance = IERC20(asset).balanceOf(address(this));
    return assetBalance.add(lockedAsset);
    
    // todo: caclulate cash value to avoid not early withdraw to avoid loss.
  }

  /**
   * @dev the function that the vault will call when the round is over
   */
  function closePosition() external onlyVault override {
    require(canClosePosition(), "Cannot close position");
    
    if(_canSettleVault()) {
      _settleGammaVault();
    }

    // this function can only be called when it's `Activated`
    // go to the next step, which will enable owner to commit next oToken
    _setActionIdle();

    lockedAsset = 0;
  }

  /**
   * @dev the function that the vault will call when the new round is starting
   */
  function rolloverPosition() external onlyVault override {
    
    // this function can only be called when it's `Committed`
    _rollOverNextOTokenAndActivate();
    rolloverTime = block.timestamp;
  }

  /**
   * @dev owner only function to mint options with "assets" and sell otokens in this contract 
   * by filling an order on AirSwap.
   * this can only be done in "activated" state. which is achievable by calling `rolloverPosition`
   */
  function mintAndStartAuction(
    uint256 _collateralAmount, 
    uint96 _otokenAmount,
    uint256 _orderCancellationEndDate,
    uint256 _auctionEndDate,
    uint96 _minPremium,
    uint256 _minimumBiddingAmountPerOrder,
    uint256 _minFundingThreshold,
    bool _isAtomicClosureAllowed
  ) external onlyOwner onlyActivated {
    
    // todo: add custom check to see if minimal premium is reached
    // _otokenAmount / _minPremium is the minimal price
    require(_collateralAmount.mul(MIN_PROFITS).div(BASE) <= _minPremium, 'Need minimum option premium');

    address cachedOToken = otoken;
    address cachedAsset = asset;

    lockedAsset = lockedAsset.add(_collateralAmount);

    _mintOTokens(asset, _collateralAmount, cachedOToken, uint256(_otokenAmount));

    _startAuction(
      cachedOToken, 
      cachedAsset, 
      _orderCancellationEndDate, 
      _auctionEndDate, 
      _otokenAmount, 
      _minPremium,  // minBuyAmount
      _minimumBiddingAmountPerOrder, 
      _minFundingThreshold, 
      _isAtomicClosureAllowed
    );
  }

  /**
   * @dev start auction without minting.
   * We need this because it's possible that there're some token left from the last auction. 
   */
  function startAuction(
    uint256 _orderCancellationEndDate,
    uint256 _auctionEndDate,
    uint96 _otokenAmount,
    uint96 _minPremium,
    uint256 _minimumBiddingAmountPerOrder,
    uint256 _minFundingThreshold,
    bool _isAtomicClosureAllowed
  ) external {
    _startAuction(
      otoken, 
      asset, 
      _orderCancellationEndDate, 
      _auctionEndDate, 
      _otokenAmount, 
      _minPremium,  // minBuyAmount
      _minimumBiddingAmountPerOrder, 
      _minFundingThreshold, 
      _isAtomicClosureAllowed
    );
  }

  function settleLastAuction() external {
    _settleAuction();
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
  function _customOTokenCheck(address _nextOToken) internal view override {
    // Can override or replace this. 
     IOToken otokenToCheck = IOToken(_nextOToken);
     require(_isValidStrike(otokenToCheck.strikePrice()), 'Strike Price Too Low');
     require (_isValidExpiry(otokenToCheck.expiryTimestamp()), 'Invalid expiry');
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
    // TODO: override with your filler code. 
    uint256 spotPrice = oracle.getPrice(asset);
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

