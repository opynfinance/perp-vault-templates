//SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

import { MockERC20 } from './MockERC20.sol';

/**
 * Mock Curve
 */
contract MockCurve {
    
    MockERC20 ecrv;
    MockERC20 underlying;

    constructor (address _ecrv, address _underlying) {
        ecrv = MockERC20(_ecrv);
        underlying = MockERC20(_underlying);
    }

    function add_liquidity(uint256[3] memory amounts, uint256) external returns (uint256) {
        underlying.transferFrom(msg.sender, address(this), amounts[0]);
        ecrv.mint(msg.sender, amounts[0]);
        return amounts[0];
    }

    function get_virtual_price() external pure returns (uint256) {
        return 1 ether; 
    }

    function remove_liquidity_one_coin(uint256 amount, int128, uint256) external returns (uint256) {
        underlying.transfer(msg.sender, amount);
        ecrv.burn(msg.sender, amount);
        return amount;
    }
}
