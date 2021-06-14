// SPDX-License-Identifier: MIT

pragma solidity ^0.7.2;

interface IOracle {
  function isDisputePeriodOver(address _asset, uint256 _expiryTimestamp) external view returns (bool);

  function getExpiryPrice(address _asset, uint256 _expiryTimestamp) external view returns (uint256, bool);

  function setAssetPricer(address _asset, address _pricer) external;

  function setExpiryPrice(
    address _asset,
    uint256 _expiryTimestamp,
    uint256 _price
  ) external;

  function getPrice(address _asset) external view returns (uint256);
}
