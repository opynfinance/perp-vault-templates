// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {RollOverBase} from "../utils/RollOverBase.sol";
import {GammaUtils} from "../utils/GammaUtils.sol";
// use airswap to long
import {AirswapUtils} from "../utils/AirswapUtils.sol";

import {SwapTypes} from "../libraries/SwapTypes.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

import {IController} from "../interfaces/IController.sol";
import {IAction} from "../interfaces/IAction.sol";
import {ICToken} from "../interfaces/ICToken.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {IOToken} from "../interfaces/IOToken.sol";
import {IZeroXV4} from "../interfaces/IZeroXV4.sol";
import {IERC20Detailed} from "../interfaces/IERC20Detailed.sol";

/**
 * This is an Long Action template that use cToken to buy put
 */
contract LongOTokenWithCToken is IAction, OwnableUpgradeable, AirswapUtils, RollOverBase, GammaUtils {
  using SafeERC20 for IERC20Detailed;
  using SafeMath for uint256;

  /// @dev 100%
  uint256 public constant BASE = 10000;
  uint256 public rolloverTime;

  bool public isPut;

  address public immutable vault;
  address public immutable cToken;
  address public immutable underlying;
  IOracle public oracle;

  uint256 public underlyingDecimals;

  constructor(
    address _vault,
    address _cToken,
    address _underlying,
    address _airswap,
    address _controller,
    bool _isPut
  ) {
    vault = _vault;
    underlying = _underlying;
    cToken = _cToken;

    underlyingDecimals = IERC20Detailed(_underlying).decimals();

    // enable vault to take all the asset back and re-distribute.
    IERC20Detailed(_cToken).safeApprove(_vault, uint256(-1));

    _initGammaUtil(_controller);

    oracle = IOracle(controller.oracle());

    // init the contract used to execute trades
    _initSwapContract(_airswap);

    _initRollOverBase(controller.whitelist());
    __Ownable_init();

    isPut = _isPut;
  }

  modifier onlyVault() {
    require(msg.sender == vault, "!VAULT");

    _;
  }

  /**
   * @dev return the net worth of this strategy, in terms of cToken.
   */
  function currentValue() external view override returns (uint256) {
    return IERC20Detailed(cToken).balanceOf(address(this));
    // todo: add cash value of the otoken that we're long
  }

  /**
   * @dev the function that the vault will call when the round is over
   */
  function closePosition() external override onlyVault {
    require(canClosePosition(), "Cannot close position");

    // if it's a force quit because nothing happened, do nothing
    if (otoken == address(0)) return;

    uint256 amount = IERC20Detailed(otoken).balanceOf(address(this));
    _redeemOTokens(otoken, amount);

    if (isPut) {
      // get back usdc
    } else {}
    // get back eth
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

  /**
   * @dev redeem cToken for underlying, and execute OTC trade to buy oToken.
   */
  function tradeAirswapOTC(SwapTypes.Order memory _order) external onlyOwner onlyActivated {
    require(_order.sender.wallet == address(this), "!Sender");
    require(_order.sender.token == underlying, "Can only pay with underlying");
    require(_order.signer.token == otoken, "Can only buy otoken");

    uint256 exchangeRate = ICToken(cToken).exchangeRateCurrent();
    uint256 requiredCToken = _order.sender.amount.mul(10**18).div(exchangeRate);

    ICToken(cToken).redeem(requiredCToken);

    _fillAirswapOrder(_order);
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
    bool newOTokenIsPut = otokenToCheck.isPut();
    require(newOTokenIsPut == isPut, "Wrong otoken type");
    // require(
    //   _isValidStrike(otokenToCheck.underlyingAsset(), otokenToCheck.strikePrice(), newOTokenIsPut),
    //   "Bad Strike Price"
    // );
    // require(_isValidExpiry(otokenToCheck.expiryTimestamp()), "Invalid expiry");
    // add more checks here
  }

  /**
   * @dev funtion to check that the otoken being sold meets a minimum valid strike price
   * this hook is triggered in the _customOtokenCheck function.
   */
  function _isValidStrike(
    address _underlying,
    uint256 strikePrice,
    bool newOTokenIsPut
  ) internal view returns (bool) {
    // TODO: override with your filler code.
    // Example: checks that the strike price set is > than 105% of current price for calls, < 95% spot price for puts
    uint256 spotPrice = oracle.getPrice(_underlying);
    if (newOTokenIsPut) {
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
