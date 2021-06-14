// SPDX-License-Identifier: MIT
pragma solidity >=0.6.0;

contract MockOpynOracle {
  mapping(address => uint256) price;

  function setAssetPrice(address asset, uint256 _price) public {
    price[asset] = _price;
  }

  function getPrice(address _asset) external view returns (uint256) {
    return price[_asset];
  }
}
