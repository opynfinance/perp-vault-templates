// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICToken {
  function mint(uint256) external returns (uint256);

  function borrow(uint256) external returns (uint256);

  function exchangeRateCurrent() external returns (uint256);

  function exchangeRateStored() external view returns (uint256);

  // function borrowRatePerBlock() external view returns (uint256);

  // function borrowBalanceCurrent(address) external returns (uint256);

  function repayBorrow(uint256) external returns (uint256);

  function redeem(uint256 _amount) external returns (uint256);
}

interface ICTokenERC20 is ICToken, IERC20 {}
