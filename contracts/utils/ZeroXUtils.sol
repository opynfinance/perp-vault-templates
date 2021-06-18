// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

import {IZeroXV4} from "../interfaces/IZeroXV4.sol";

contract ZeroXUtils {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;
  IZeroXV4 public exchange;

  function _init0x(address _exchange) internal {
    exchange = IZeroXV4(_exchange);
  }

  function _fillLimitOrder(
    IZeroXV4.LimitOrder memory _order,
    IZeroXV4.Signature memory _signature,
    uint128 takerTokenFillAmount
  ) internal {
    IERC20(_order.takerToken).approve(address(exchange), takerTokenFillAmount);
    exchange.fillLimitOrder{value: msg.value}(_order, _signature, takerTokenFillAmount);
  }

  function _fillRFQOrder(
    IZeroXV4.RfqOrder memory _order,
    IZeroXV4.Signature memory _signature,
    uint128 takerTokenFillAmount
  ) internal {
    IERC20(_order.takerToken).approve(address(exchange), takerTokenFillAmount);
    exchange.fillRfqOrder(_order, _signature, takerTokenFillAmount);
  }
}
