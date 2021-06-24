// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {IAction} from "../interfaces/IAction.sol";
import {IVault} from "../interfaces/IVault.sol";
import {ICToken} from "../interfaces/ICToken.sol";
import {ITreasury} from "../interfaces/ITreasury.sol";

/**
 * This is an Action only store cUSDC and farm comp
 */
contract CTokenTreasury is IAction, ITreasury {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  address public immutable vault;
  address public immutable asset;

  // exposed for other actions to read from
  uint256 public override roundStartExchangeRate;
  uint256 public override roundEndExchangeRate;

  /// @dev interest in cUSDC term.
  uint256 public override lastRoundProfit;

  /// @dev total asset balance in vault + balance in actions - pending deposit.
  uint256 public override lastRoundAssetSnapshot;

  constructor(address _vault, address _asset) {
    vault = _vault;
    asset = _asset;
    // enable vault to take all the asset back and re-distribute.
    IERC20(_asset).safeApprove(_vault, uint256(-1));
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
  }

  /**
   * @dev the function that the vault will call when the round is over
   */
  function closePosition() external override onlyVault {
    uint256 balance = IERC20(asset).balanceOf(address(this));

    roundEndExchangeRate = ICToken(asset).exchangeRateCurrent();

    // todo:
    // farm COMP, convert COMP to cusdc and include in profit
    lastRoundProfit = balance.mul(roundEndExchangeRate).div(roundStartExchangeRate).sub(balance);

    // keep track of the total asset the vault controll when we freeze the profit.
    // if someone withdraw later, the amount we can use to purchase option will decrease.
    lastRoundAssetSnapshot = IVault(vault).totalAsset();
  }

  /**
   * @dev the function that the vault will call when the new round is starting
   */
  function rolloverPosition() external override onlyVault {
    // vault will send the cUSDC into this action
    roundStartExchangeRate = ICToken(asset).exchangeRateCurrent();
  }
}

/**

round 0

[vault]
vaultBalance 100
totalAsset 70
pendingDeposit 20
queuedWithdraw 10

profit: 10

vaultBalance 120
totalAsset 110
pendingDeposit 0 (===0)
queuedWithdraw 10

 */
