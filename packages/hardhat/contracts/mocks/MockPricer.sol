// SPDX-License-Identifier: MIT

pragma solidity ^0.7.2;

import {IOracle} from "../interfaces/IOracle.sol";

contract MockPricer {
  IOracle public oracle;
  uint256 price;

  constructor(address _oracle) {
    oracle = IOracle(_oracle);
  }

  function setExpiryPriceInOracle(
    address asset,
    uint256 _expiryTimestamp,
    uint256 _price
  ) external {
    oracle.setExpiryPrice(asset, _expiryTimestamp, uint256(_price));
  }

  function setPrice(uint256 _price) external {
    price = _price;
  }

  function getPrice() external view returns (uint256) {
    return price;
  }
}
