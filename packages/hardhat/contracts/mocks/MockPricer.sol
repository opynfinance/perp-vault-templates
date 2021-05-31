
// SPDX-License-Identifier: MIT

pragma solidity ^0.7.2;

import { IOracle } from '../interfaces/IOracle.sol';

contract MockPricer { 
    IOracle public oracle;

    constructor (address _oracle) {
        oracle = IOracle(_oracle);
    }
    function setExpiryPriceInOracle(address asset, uint256 _expiryTimestamp, uint256 price) external {
        oracle.setExpiryPrice(asset, _expiryTimestamp, uint256(price));
    }
}