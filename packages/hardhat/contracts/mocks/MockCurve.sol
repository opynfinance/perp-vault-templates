//SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

import { MockERC20 } from './MockERC20.sol';

/**
 * Mock Curve
 */
contract MockCurve {
    
    MockERC20 ecrv;

    constructor (address _ecrv) {
        ecrv = MockERC20(_ecrv);
    }

    function add_liquidity(uint256[2] memory amounts, uint256 minAmount) external payable returns (uint256) { 
        ecrv.mint(msg.sender, amounts[0]);
        return amounts[0];
    }

    function get_virtual_price() external returns (uint256) { 
        return 1 ether; 
    }

    /**
    * @notice the receive ether function 
    */
    receive() external payable {
    }
}