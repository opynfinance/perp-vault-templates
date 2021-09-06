// SPDX-License-Identifier: MIT

pragma solidity ^0.7.2;
pragma experimental ABIEncoderV2;

interface ICurve {
  function add_liquidity(uint256[3] memory amounts, uint256 minAmount) external;

  function remove_liquidity_one_coin(uint256 _token_amount, int128 i, uint256 _minAmount) external;

  function get_virtual_price() external view returns (uint256);
}