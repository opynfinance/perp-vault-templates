// SPDX-License-Identifier: MIT

pragma solidity >=0.7.2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IOpeth {
    function mintFor(address _destination, address oToken, uint _amount) external;
    function getOpethDetails(address oToken, uint _oToken) external view returns(address, address, uint);
    function flashMint(address oToken, uint amount, bytes memory params) external;
    function redeem(address oToken, uint amount) external;
}