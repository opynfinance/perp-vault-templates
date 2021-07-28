// SPDX-License-Identifier: MIT

pragma solidity ^0.7.2;
pragma experimental ABIEncoderV2;

interface ICurve {
  function add_liquidity(uint256[2] memory amounts, uint256 minAmount) external payable returns (uint256);

  function remove_liquidity(uint256 amount, uint256[] memory amounts) external payable returns (uint256[] memory);

  function get_virtual_price() external view returns (uint256);
}