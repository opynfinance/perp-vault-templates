// SPDX-License-Identifier: MIT

import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

pragma solidity ^0.7.2;
pragma experimental ABIEncoderV2;

interface IStakeDao {
  function depositAll() external;

  function withdrawAll() external;

  function token() external returns (IERC20);
}
