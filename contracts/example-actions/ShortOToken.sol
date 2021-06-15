// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {GammaUtils} from "../utils/GammaUtils.sol";
import {RollOverBase} from "../utils/RollOverBase.sol";

// use airswap to short / long
import {AirswapUtils} from "../utils/AirswapUtils.sol";
// use auction to short / long
import {AuctionUtils} from "../utils/AuctionUtils.sol";

import {SwapTypes} from "../libraries/SwapTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

import {IController} from "../interfaces/IController.sol";
import {IAction} from "../interfaces/IAction.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {IOToken} from "../interfaces/IOToken.sol";

/**
 * This is an Short Action template that inherit lots of util functions to "Short" an option.
 * You can remove the function you don't need.
 */
contract ShortOToken is IAction, OwnableUpgradeable, AuctionUtils, AirswapUtils, RollOverBase, GammaUtils {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  /// @dev 100%
  uint256 public constant BASE = 10000;
  uint256 public constant MIN_PROFITS = 100; // 1%
  uint256 public lockedAsset;
  uint256 public rolloverTime;

  address public immutable vault;
  address public immutable asset;
  IOracle public oracle;

  constructor(
    address _vault,
    address _asset,
    address _airswap,
    address _easyAuction,
    address _controller,
    uint256 _vaultType
  ) {
    vault = _vault;
    asset = _asset;

    // enable vault to take all the asset back and re-distribute.
    IERC20(_asset).safeApprove(_vault, uint256(-1));

    _initGammaUtil(_controller);

    // enable pool contract to pull asset from this contract to mint options.
    address pool = controller.pool();

    oracle = IOracle(controller.oracle());
    address whitelist = controller.whitelist();

    IERC20(_asset).safeApprove(pool, uint256(-1));

    // init the contract used to short
    _initAuction(_easyAuction);
    _initSwapContract(_airswap);

    _initRollOverBase(whitelist);
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
  function closePosition() external override onlyVault {
    require(canClosePosition(), "Cannot close position");
    if (_canSettleVault()) {
      _settleGammaVault();
    }
    _setActionIdle();
    lockedAsset = 0;
  }

  /**
   * @dev the function that the vault will call when the new round is starting
   */
  function rolloverPosition() external override onlyVault {
    _rollOverNextOTokenAndActivate(); // this function can only be called when the action is `Committed`
    rolloverTime = block.timestamp;
  }

  // Short Functions

  /**
   * @dev owner only function to mint options with "assets" and start an aunction to start it.
   * this can only be done in "activated" state. which is achievable by calling `rolloverPosition`
   */
  function mintAndStartAuction(
    uint256 _collateralAmount,
    uint256 _otokenToMint,
    uint96 _otokenToSell,
    uint256 _orderCancellationEndDate,
    uint256 _auctionEndDate,
    uint96 _minPremium,
    uint256 _minimumBiddingAmountPerOrder,
    uint256 _minFundingThreshold,
    bool _isAtomicClosureAllowed
  ) external onlyOwner onlyActivated {
    // mint token
    if (_collateralAmount > 0 && _otokenToMint > 0) {
      lockedAsset = lockedAsset.add(_collateralAmount);
      _mintOTokens(asset, _collateralAmount, otoken, _otokenToMint);
    }

    _startAuction(
      otoken,
      asset,
      _orderCancellationEndDate,
      _auctionEndDate,
      _otokenToSell,
      _minPremium, // minBuyAmount
      _minimumBiddingAmountPerOrder,
      _minFundingThreshold,
      _isAtomicClosureAllowed
    );
  }

  /**
   * @dev mint options with "asset" and participate in an auction to sell it for asset.
   */
  function mintAndBidInAuction(
    uint256 _auctionId,
    uint256 _collateralAmount,
    uint256 _otokenToMint,
    uint96[] memory _minBuyAmounts, // min amount of asset to get (premium)
    uint96[] memory _sellAmounts, // amount of otoken selling
    bytes32[] memory _prevSellOrders,
    bytes calldata _allowListCallData
  ) external onlyOwner onlyActivated {
    // mint token
    if (_collateralAmount > 0 && _otokenToMint > 0) {
      lockedAsset = lockedAsset.add(_collateralAmount);
      _mintOTokens(asset, _collateralAmount, otoken, _otokenToMint);
    }

    _bidInAuction(asset, otoken, _auctionId, _minBuyAmounts, _sellAmounts, _prevSellOrders, _allowListCallData);
  }

  /**
   * @dev mint options with "assets" and sell otokens in this contract by filling an order on AirSwap.
   * this can only be done in "activated" state. which is achievable by calling `rolloverPosition`
   */
  function mintAndTradeAirSwapOTC(
    uint256 _collateralAmount,
    uint256 _otokenAmount,
    SwapTypes.Order memory _order
  ) external onlyOwner onlyActivated {
    require(_order.sender.wallet == address(this), "!Sender");
    require(_order.sender.token == otoken, "Can only sell otoken");
    require(_order.signer.token == asset, "Can only sell for asset");
    require(_collateralAmount.mul(MIN_PROFITS).div(BASE) <= _order.signer.amount, "Need minimum option premium");

    lockedAsset = lockedAsset.add(_collateralAmount);

    // mint otoken using the util function
    _mintOTokens(asset, _collateralAmount, otoken, _otokenAmount);

    _fillAirswapOrder(_order);
  }

  /**
   * @notice the function will return when someone can close a position. 1 day after rollover,
   * if the option wasn't sold, anyone can close the position.
   */
  function canClosePosition() public view returns (bool) {
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
    IOToken otokenToCheck = IOToken(_nextOToken);
    require(_isValidStrike(otokenToCheck.strikePrice(), otokenToCheck.isPut()), "Strike Price Too Low");
    require(_isValidExpiry(otokenToCheck.expiryTimestamp()), "Invalid expiry");
    // add more checks here
  }

  /**
   * @dev funtion to check that the otoken being sold meets a minimum valid strike price
   * this hook is triggered in the _customOtokenCheck function.
   */
  function _isValidStrike(uint256 strikePrice, bool isPut) internal view returns (bool) {
    // TODO: override with your filler code.
    // Example: checks that the strike price set is > than 105% of current price for calls, < 95% spot price for puts
    uint256 spotPrice = oracle.getPrice(asset);
    if (isPut) {
      return strikePrice <= spotPrice.mul(9500).div(BASE);
    } else {
      return strikePrice >= spotPrice.mul(10500).div(BASE);
    }
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
