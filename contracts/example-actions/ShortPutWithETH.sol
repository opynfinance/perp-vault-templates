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

  /// @dev amount of assets locked in Opyn
  uint256 public lockedAsset;

  /// @dev time at which the last rollover was called
  uint256 public rolloverTime;

  /// @dev address of the vault 
  address public immutable vault;

  /// @dev address of the ERC20 asset. Do not use non-ERC20s
  address public immutable asset;

  /// @dev address of usdc 
  address public immutable usdc;

  /// @dev address of cUSDC
  address public immutable cusdc;

  /** 
  * @notice constructor 
  * @param _vault the address of the vault contract
  * @param _asset address of the ERC20 asset
  * @param _cETH address of cETH
  * @param _usdc address of usdc
  * @param _cusdc address of cUSDC
  * @param _airswap address of airswap swap contract 
  * @param _controller address of Opyn controller contract
  * @param _comptroller address of Compound controller contract
  */
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

    // allow opyn's pool to transfer usdc
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
   * @notice returns the net worth of this strategy = current balance of the action + collateral deposited into Opyn's vault. 
   * @dev For a more realtime tracking of value, we reccomend calculating the current value as: 
   * currentValue = balance + collateral - (numOptions * cashVal), where: 
   * balance = current balance in the action
   * collateral = collateral deposited into Opyn's vault 
   * numOptions = number of options sold
   * cashVal = cash value of 1 option sold (for puts: Strike - Current Underlying Price, for calls: Current Underlying Price - Strike)
   */
  function currentValue() external view override returns (uint256) {
    uint256 assetBalance = IERC20(asset).balanceOf(address(this));
    return assetBalance.add(lockedAsset);
    // todo: consider cETH value that's used as collateral
  }

  /**
   * @notice the function that the vault will call when the new round is starting. Once this is called, the funds will be sent from the vault to this action. 
   * @dev this does NOT automatically mint options and sell them. This merely receives funds. Before this function is called, the owner should have called 
   * `commitOToken` to decide on what Otoken is being sold. This function can only be called after the commitment period has passed since the call to `commitOToken`.
   * Once this has been called, the owner should call `borrowMintAndTradeOTC`. If the owner doesn't mint and sell the options within 1 day after rollover has been 
   * called, someone can call closePosition and transfer the funds back to the vault. If that happens, the owner needs to commit to a new otoken and call rollover again. 
   */
  function rolloverPosition() external override onlyVault {
    _rollOverNextOTokenAndActivate(); // this function can only be called when the action is `Committed`
    rolloverTime = block.timestamp;
  }

  /**
   * @notice the function will return when someone can close a position. 1 day after rollover,
   * if the option wasn't sold, anyone can close the position and send funds back to the vault. 
   */
  function canClosePosition() public view returns (bool) {
    if (otoken != address(0) && lockedAsset != 0) {
      return _canSettleVault();
    }
    return block.timestamp > rolloverTime + 1 days;
  }
  

  /**
   * @notice the function that the vault will call when the round is over. This will settle the vault in Opyn, repay the usdc debt in Compound
   * and withdraw WETH supplied to Compound. There are 2 main risks involved in this strategy:
   * 1. If the option expired OTM, then all the collateral is returned to this action. If not, some portion of the collateral is deducted 
   * by the Opyn system. 
   * 2. If the ETH price fluctuates a lot, the position in Compound could get liquidated in which case all the collateral may not be 
   * returned even if the option expires OTM. 
   * @dev this can be called after 1 day rollover was called if no options have been sold OR if the sold options expired. 
   */
  function closePosition() external override onlyVault {
    require(canClosePosition(), "Cannot close position");
    if (_canSettleVault()) {
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
      lockedAsset = 0;
    }

    // set action state.
    _setActionIdle();
  }

  /**
   * @notice lends the WETH on compound, borrows USDC against that and mints otokens against the borrowed usdc. 
   * sells the by filling an order on AirSwap. this can only be done in "activated" state which is achievable by 
   * calling `rolloverPosition`
   */
  function borrowMintAndTradeOTC(
    uint256 _supplyWethAmount,
    uint256 _collateralAmount,
    uint256 _otokenAmount,
    SwapTypes.Order memory _order
  ) external onlyOwner onlyActivated {
    _supplyWeth(_supplyWethAmount);
    lockedAsset = lockedAsset.add(_supplyWethAmount);
    _borrowERC20(cusdc, _collateralAmount);

    // mint otoken using the util function
    _mintOTokens(usdc, _collateralAmount, otoken, _otokenAmount);
    _fillAirswapOrder(_order);
  }

  /**
   * @notice checks if the current vault can be settled
   */
  function _canSettleVault() internal view returns (bool) {
    if (lockedAsset != 0 && otoken != address(0)) {
      return controller.isSettlementAllowed(otoken);
    }

    return false;
  }
}
