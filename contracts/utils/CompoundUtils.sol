// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

import {IComptroller} from "../interfaces/IComptroller.sol";
import {ICToken} from "../interfaces/ICToken.sol";
import {ICEth} from "../interfaces/ICEth.sol";
import {IWETH} from "../interfaces/IWETH.sol";

contract CompoundUtils {
  IComptroller public comptroller;
  IWETH public weth;
  ICEth public cEth;

  address public compoundCollateral;
  address public borrowingAsset;

  function _initCompoundUtils(
    address _comptrollerAddress,
    address _weth,
    address _cEth
  ) internal {
    comptroller = IComptroller(_comptrollerAddress);

    weth = IWETH(_weth);
    cEth = ICEth(_cEth);
  }

  /**
   * @dev supply WETH into compound's ETH market, later used to borrow
   * Useful if the asset in the action is weth
   */
  function _supplyWeth(uint256 _amount) internal {
    // convert weth back to eth
    weth.withdraw(_amount);

    cEth.mint{value: _amount}();

    // Enter the ETH market so you can borrow another type of asset
    // it is not an error to enter the same market more than once.
    address[] memory cTokens = new address[](1);
    cTokens[0] = address(cEth);
    uint256[] memory errors = comptroller.enterMarkets(cTokens);
    require(errors[0] == 0, "Comptroller.enterMarkets failed.");
  }

  /**
   * @dev supply ERC20 into compound's market, later used to borrow
   * Useful when the asset in the action is ERC20
   */
  function _supplyERC20(
    address _cToken,
    address _underlying,
    uint256 _amount
  ) internal {
    ICToken cToken = ICToken(_cToken);
    IERC20 underlying = IERC20(_underlying);

    // Approve transfer of underlying
    underlying.approve(_cToken, _amount);

    // Supply underlying as collateral, get cToken in return
    uint256 error = cToken.mint(_amount);
    require(error == 0, "CErc20.mint Error");

    // Enter the market so you can borrow another type of asset
    // it is not an error to enter the same market more than once.
    address[] memory cTokens = new address[](1);
    cTokens[0] = _cToken;
    uint256[] memory errors = comptroller.enterMarkets(cTokens);
    require(errors[0] == 0, "Comptroller.enterMarkets failed.");
  }

  /**
   * @dev borrow WETH from Compound.
   * This function actually borrow eth and then convert it to WETH.
   */
  function _borrowWeth(uint256 _amountToBorrow) internal {
    // Borrow a fixed amount of ETH from cETH contract
    uint256 error = cEth.borrow(_amountToBorrow);
    require(error == 0, "borrow failed");

    // wrap eth to weth
    weth.deposit{value: _amountToBorrow}();
  }

  /**
   * @dev borrow ERC20 from Compound.
   */
  function _borrowERC20(address _cToken, uint256 _amountToBorrow) internal {
    ICToken cToken = ICToken(_cToken);
    // Borrow, check the underlying balance for this contract's address
    cToken.borrow(_amountToBorrow);
  }

  /**
   * @dev repay the borrowed ERC20 asset.
   */
  function _repayERC20(
    address _underlying,
    address _cToken,
    uint256 _repayAmount
  ) internal {
    IERC20 underlying = IERC20(_underlying);
    ICToken cToken = ICToken(_cToken);

    underlying.approve(_cToken, _repayAmount);
    uint256 error = cToken.repayBorrow(_repayAmount);

    require(error == 0, "CErc20.repayBorrow Error");
  }

  /**
   * @dev repay borrowed WETH
   * this function will unwarp WETH to ETH, then repay the debt
   */
  function _repayWETH(uint256 _repayAmount) internal {
    weth.withdraw(_repayAmount);
    // cETH reverts on error
    cEth.repayBorrow{value: _repayAmount}();
  }

  /**
   * @dev get back collateral from Compound
   */
  function _redeemERC20(address _cToken, uint256 _redeemAmount) internal {
    ICToken cToken = ICToken(_cToken);
    uint256 error = cToken.redeem(_redeemAmount);
    require(error == 0, "CErc20.redeem Error");
  }

  /**
   * @dev get back collateral as WETH from Compound
   */
  function _redeemWETH(uint256 _redeemAmount) internal {
    uint256 error = cEth.redeem(_redeemAmount);

    require(error == 0, "CEth.redeem Error");
    // todo: use exchange rate to calculate how much eth we got back
    weth.deposit{value: address(this).balance}();
  }

  /**
   * receive eth
   */
  receive() external payable {}
}
