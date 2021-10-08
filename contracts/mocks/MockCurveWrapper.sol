//SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

import { MockERC20 } from './MockERC20.sol';
import { ICurve } from '../interfaces/ICurve.sol';

/**
 * Mock Curve
 */
contract MockCurveWrapper {
    
    ICurve curvePool;
    MockERC20 curveLPToken;
    MockERC20 underlyingToken;

    constructor (address _curvePool, address _curveLPToken, address _underlying) {
        curvePool = ICurve(_curvePool);
        curveLPToken = MockERC20(_curveLPToken);
        underlyingToken = MockERC20(_underlying);
    }

    // function add_liquidity(uint256 amount, uint256 minCrvLPToken) external {
    //     // the sdLPToken is already deposited into the contract at this point, need to substract it from total
    //     uint256[2] memory amounts;
    //     amounts[0] = 0; // not depositing any rebBTC
    //     amounts[1] = amount; 

    //     // deposit underlying to curvePool
    //     underlyingToken.transferFrom(msg.sender, address(this), amount);
    //     underlyingToken.approve(address(curvePool), amount);
    //     curvePool.add_liquidity(amounts, minCrvLPToken);
    //     uint256 curveLPTokenBalance = curveLPToken.balanceOf(address(this));
    //     curveLPToken.transfer(msg.sender, curveLPTokenBalance);
    // }


    // function remove_liquidity_one_coin(uint256 amount, int128, uint256) external returns (uint256) {
    //     underlying.transfer(msg.sender, amount);
    //     ecrv.burn(msg.sender, amount);
    //     return amount;
    // }
}
