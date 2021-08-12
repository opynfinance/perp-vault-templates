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

    function add_liquidity(uint256[2] memory amounts, uint256) external payable returns (uint256) {
        ecrv.mint(msg.sender, amounts[0]);
        return amounts[0];
    }

    function get_virtual_price() external pure returns (uint256) {
        return 1 ether; 
    }

    function remove_liquidity_one_coin(uint256 amount, int128, uint256) external returns (uint256) {
        ecrv.burn(msg.sender, amount);
        (bool success, ) = (msg.sender).call{ value: amount }('');
        require(success, 'ETH transfer failed');
        return amount;
    }

    /**
    * @notice the receive ether function 
    */
    receive() external payable {
    }
}
