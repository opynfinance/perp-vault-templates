// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {CompoundUtils} from "../utils/CompoundUtils.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

/**
 * Tester contract for CompoundUtils
 */
contract CompoundUtilsTester is CompoundUtils {
  function initCompoundUtils(
    address _comptrollerAddress,
    address _weth,
    address _cEth
  ) external {
    _initCompoundUtils(_comptrollerAddress, _weth, _cEth);
  }

  /**
   * @dev supply WETH into compound's ETH market, later used to borrow
   * Useful if the asset in the action is weth
   */
  function supplyWeth(uint256 _amount) external {
    _supplyWeth(_amount);
  }

  /**
   * @dev supply ERC20 into compound's market, later used to borrow
   * Useful when the asset in the action is ERC20
   */
  function supplyERC20(
    address _cToken,
    address _underlying,
    uint256 _amount
  ) external {
    _supplyERC20(_cToken, _underlying, _amount);
  }

  /**
   * @dev borrow WETH from Compound.
   * This function actually borrow eth and then convert it to WETH.
   */
  function borrowWeth(uint256 _amountToBorrow) external {
    _borrowWeth(_amountToBorrow);
  }

  /**
   * @dev borrow ERC20 from Compound.
   */
  function borrowERC20(address _cToken, uint256 _amountToBorrow) external {
    _borrowERC20(_cToken, _amountToBorrow);
  }

  /**
   * @dev repay the borrowed ERC20 asset.
   */
  function repayERC20(
    address _underlying,
    address _cToken,
    uint256 amount
  ) external {
    _repayERC20(_underlying, _cToken, amount);
  }

  /**
   * @dev repay borrowed WETH
   * this function will unwarp WETH to ETH, then repay the debt
   */
  function repayWETH(uint256 _amount) external {
    _repayWETH(_amount);
  }

  /**
   * @dev get back collateral from Compound
   */
  function redeemERC20(address _cToken, uint256 _redeemAmount) external {
    _redeemERC20(_cToken, _redeemAmount);
  }

  /**
   * @dev get back collateral as WETH from Compound
   */
  function redeemWETH(uint256 _redeemAmount) external {
    _redeemWETH(_redeemAmount);
  }
}
