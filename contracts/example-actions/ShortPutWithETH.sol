// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {GammaUtils} from "../utils/GammaUtils.sol";
import {RollOverBase} from "../utils/RollOverBase.sol";

// use airswap to short / long
import {AirswapUtils} from "../utils/AirswapUtils.sol";
import {CompoundUtils} from "../utils/CompoundUtils.sol";
import {SwapTypes} from "../libraries/SwapTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

import {IController} from "../interfaces/IController.sol";
import {IAction} from "../interfaces/IAction.sol";
import {IOToken} from "../interfaces/IOToken.sol";

/**
 * This is an Short Action template that inherit lots of util functions to "Short" an option.
 * You can remove the function you don't need.
 */
contract ShortPutWithETH is IAction, OwnableUpgradeable, CompoundUtils, AirswapUtils, RollOverBase, GammaUtils {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  bool vaultClosed;

  /// @dev 100%
  uint256 public constant BASE = 10000;
  uint256 public lockedAsset;
  uint256 public rolloverTime;

  address public immutable vault;
  address public immutable asset;

  address public immutable usdc;
  address public immutable cusdc;

  constructor(
    address _vault,
    address _asset, // weth
    address _cETH,
    address _usdc,
    address _cusdc,
    address _airswap,
    address _controller,
    address _comptroller
  ) {
    vault = _vault;
    asset = _asset;
    usdc = _usdc;
    cusdc = _cusdc;

    // enable vault to take all the asset back and re-distribute.
    IERC20(_asset).safeApprove(_vault, uint256(-1));

    _initGammaUtil(_controller);

    // enable pool contract to pull asset from this contract to mint options.
    address pool = controller.pool();

    address whitelist = controller.whitelist();

    // allow pool to usdc usdc
    IERC20(_usdc).safeApprove(pool, uint256(-1));

    _initSwapContract(_airswap);
    // assuming asset is weth
    _initCompoundUtils(_comptroller, _asset, _cETH);

    _initRollOverBase(whitelist);
    __Ownable_init();

    _openGammaVault(0); // vault type 0
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
    // todo: consider cETH value that's used as collateral
  }

  /**
   * @dev the function that the vault will call when the new round is starting
   */
  function rolloverPosition() external override onlyVault {
    _rollOverNextOTokenAndActivate(); // this function can only be called when the action is `Committed`
    rolloverTime = block.timestamp;
  }

  /**
   * @dev the function that the vault will call when the round is over
   */
  function closePosition() external override onlyVault {
    // get back usdc from settlement
    _settleGammaVault();

    // repay USD, so we can get back ETH from Compound
    // todo: prepare contract with extra usd to get back full amount
    uint256 repayAmount = IERC20(usdc).balanceOf(address(this));
    _repayERC20(usdc, cusdc, repayAmount);
    // _repayERC20(usdc, cusdc, uint256(-1)); // to pay back full amount, use this line

    // get back ETH (and wrap to WETH)
    // todo: change to use full balance once we can repay full debt
    uint256 wethToRedeem = (IERC20(address(cEth)).balanceOf(address(this)) * 995) / 1000;
    _redeemWETH(wethToRedeem);

    // set action state.
    _setActionIdle();
  }

  // Short Functions
  /**
   * @dev mint put with borrowed usdc and sell otokens in this contract by filling an order on AirSwap.
   * this can only be done in "activated" state. which is achievable by calling `rolloverPosition`
   */
  function borrowMintAndTradeOTC(
    uint256 _supplyWethAmount,
    uint256 _collateralAmount,
    uint256 _otokenAmount,
    SwapTypes.Order memory _order
  ) external onlyOwner onlyActivated {
    _supplyWeth(_supplyWethAmount);
    _borrowERC20(cusdc, _collateralAmount);

    // mint otoken using the util function
    _mintOTokens(usdc, _collateralAmount, otoken, _otokenAmount);
    _fillAirswapOrder(_order);
  }
}
