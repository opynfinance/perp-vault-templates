// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {RollOverBase} from "../utils/RollOverBase.sol";
import {GammaUtils} from "../utils/GammaUtils.sol";
// use airswap to long
import {AirswapUtils} from "../utils/AirswapUtils.sol";
// use auction to long
import {AuctionUtils} from "../utils/AuctionUtils.sol";
import {ZeroXUtils} from "../utils/ZeroXUtils.sol";

import {SwapTypes} from "../libraries/SwapTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

import {IController} from "../interfaces/IController.sol";
import {IAction} from "../interfaces/IAction.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {IOToken} from "../interfaces/IOToken.sol";
import {IZeroXV4} from "../interfaces/IZeroXV4.sol";

/**
 * This is an Long Action template that inherit lots of util functions to "Long" an option.
 * You can remove the function you don't need.
 */
contract LongOToken is IAction, OwnableUpgradeable, AuctionUtils, AirswapUtils, RollOverBase, ZeroXUtils, GammaUtils {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  /// @dev 100%
  uint256 public constant BASE = 10000;
  uint256 public rolloverTime;

  address public immutable vault;
  address public immutable asset;
  IOracle public oracle;

  constructor(
    address _vault,
    address _asset,
    address _airswap,
    address _zeroxExchange,
    address _easyAuction,
    address _controller
  ) {
    vault = _vault;
    asset = _asset;

    // enable vault to take all the asset back and re-distribute.
    IERC20(_asset).safeApprove(_vault, uint256(-1));

    _initGammaUtil(_controller);

    oracle = IOracle(controller.oracle());

    // init the contract used to execute trades
    _initAuction(_easyAuction);
    _initSwapContract(_airswap);
    _init0x(_zeroxExchange);

    _initRollOverBase(controller.whitelist());
    __Ownable_init();
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
    return IERC20(asset).balanceOf(address(this));
    // todo: add cash value of the otoken that we're long
  }

  /**
   * @dev the function that the vault will call when the round is over
   */
  function closePosition() external override onlyVault {
    require(canClosePosition(), "Cannot close position");
    if (otoken != address(0)) {
      uint256 amount = IERC20(otoken).balanceOf(address(this));
      _redeemOTokens(otoken, amount);

      // todo: convert asset get from redeem to the asset this strategy is based on
    }
    _setActionIdle();
  }

  /**
   * @dev the function that the vault will call when the new round is starting
   */
  function rolloverPosition() external override onlyVault {
    _rollOverNextOTokenAndActivate(); // this function can only be called when the action is `Committed`
    rolloverTime = block.timestamp;
  }

  /**
   * @notice the function will return when someone can close a position. 1 day after rollover,
   * if the option wasn't sold, anyone can close the position.
   */
  function canClosePosition() public view returns (bool) {
    if (otoken != address(0)) {
      return controller.isSettlementAllowed(otoken);
    }
    // no otoken committed or longing
    return block.timestamp > rolloverTime + 1 days;
  }

  // Long Functions
  // Keep the functions you need to buy otokens.

  /**
   * @dev owner only function to start an aunction to buy otokens
   */
  function startAuction(
    uint256 _orderCancellationEndDate,
    uint256 _auctionEndDate,
    uint96 _premium,
    uint96 _minOTokenToBuy,
    uint256 _minimumBiddingAmountPerOrder,
    uint256 _minFundingThreshold,
    bool _isAtomicClosureAllowed
  ) external onlyOwner onlyActivated {
    _startAuction(
      asset, // auctioning token
      otoken, // bidding auction
      _orderCancellationEndDate,
      _auctionEndDate,
      _premium, // _auctionedSellAmount
      _minOTokenToBuy, // minBuyAmount
      _minimumBiddingAmountPerOrder,
      _minFundingThreshold,
      _isAtomicClosureAllowed
    );
  }

  /**
   * @dev participate in an auction to buy otoken.
   */
  function bidInAuction(
    uint256 _auctionId,
    uint96[] memory _minBuyAmounts, // amount of otoken to buy
    uint96[] memory _sellAmounts, // amount of asset to pay
    bytes32[] memory _prevSellOrders,
    bytes calldata _allowListCallData
  ) external onlyOwner onlyActivated {
    _bidInAuction(otoken, asset, _auctionId, _minBuyAmounts, _sellAmounts, _prevSellOrders, _allowListCallData);
  }

  /**
   * @dev execute OTC trade to buy oToken.
   */
  function tradeAirswapOTC(SwapTypes.Order memory _order) external onlyOwner onlyActivated {
    require(_order.sender.wallet == address(this), "!Sender");
    require(_order.sender.token == asset, "Can only pay with asset");
    require(_order.signer.token == otoken, "Can only buy otoken");

    _fillAirswapOrder(_order);
  }

  /**
   * @dev execute limit order to buy oToken via 0x v4.
   */
  function trade0xLimit(
    IZeroXV4.LimitOrder calldata _order,
    IZeroXV4.Signature calldata _signature,
    uint128 _takerTokenFillAmount
  ) external payable onlyOwner {
    // custom checks
    require(_order.makerToken == otoken, "Can only buy otoken");
    require(_order.takerToken == asset, "Can only buy with asset");
    _fillLimitOrder(_order, _signature, _takerTokenFillAmount);
  }

  /**
   * @dev execute limit order to buy oToken via 0x v4.
   */
  function trade0xRFQ(
    IZeroXV4.RfqOrder calldata _order,
    IZeroXV4.Signature calldata _signature,
    uint128 _takerTokenFillAmount
  ) external onlyOwner {
    // custom checks
    require(_order.makerToken == otoken, "Can only buy otoken");
    require(_order.takerToken == asset, "Can only buy with asset");
    _fillRFQOrder(_order, _signature, _takerTokenFillAmount);
  }

  // End of Long Funtions

  // Custom Checks

  /**
   * @dev funtion to add some custom logic to check the next otoken is valid to this strategy
   * this hook is triggered while action owner calls "commitNextOption"
   * so accessing otoken will give u the current otoken.
   */
  function _customOTokenCheck(address _nextOToken) internal view override {
    IOToken otokenToCheck = IOToken(_nextOToken);
    require(
      _isValidStrike(otokenToCheck.underlyingAsset(), otokenToCheck.strikePrice(), otokenToCheck.isPut()),
      "Bad Strike Price"
    );
    require(_isValidExpiry(otokenToCheck.expiryTimestamp()), "Invalid expiry");
    // add more checks here
  }

  /**
   * @dev funtion to check that the otoken being sold meets a minimum valid strike price
   * this hook is triggered in the _customOtokenCheck function.
   */
  function _isValidStrike(
    address _underlying,
    uint256 strikePrice,
    bool isPut
  ) internal view returns (bool) {
    // TODO: override with your filler code.
    // Example: checks that the strike price set is > than 105% of current price for calls, < 95% spot price for puts
    uint256 spotPrice = oracle.getPrice(_underlying);
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
