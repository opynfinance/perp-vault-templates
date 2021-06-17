// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;

interface IPriceFeed {
  function getUnderlyingPrice(address cToken) external view returns (uint256);
}
