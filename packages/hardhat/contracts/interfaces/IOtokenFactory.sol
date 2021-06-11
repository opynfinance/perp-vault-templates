// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

interface IOtokenFactory {
  function createOtoken(
    address _underlyingAsset,
    address _strikeAsset,
    address _collateralAsset,
    uint256 _strikePrice,
    uint256 _expiry,
    bool _isPut
  ) external returns (address);

  function getOtoken(
    address _underlyingAsset,
    address _strikeAsset,
    address _collateralAsset,
    uint256 _strikePrice,
    uint256 _expiry,
    bool _isPut
  ) external view returns (address);
}
