// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import {ISwap} from "../interfaces/ISwap.sol";
import {SwapTypes} from "../libraries/SwapTypes.sol";

contract AirswapUtils {
  using SafeERC20 for IERC20;
  ISwap public airswap;

  function _initSwapContract(address _airswap) internal {
    airswap = ISwap(_airswap);
  }

  function _fillAirswapOrder(SwapTypes.Order memory _order) internal {
    IERC20(_order.sender.token).approve(address(airswap), _order.sender.amount);
    airswap.swap(_order);
  }
}
