// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IVault is IERC20 {
  function deposit(uint256 _amount) external;

  function registerDeposit(uint256 _amount, address _shareRecipient) external;

  function withdraw(uint256 _shares) external;

  function withdrawFromQueue(uint256 _round) external;

  function pendingDeposit() external view returns (uint256);

  function withdrawQueueAmount() external view returns (uint256);

  function totalAsset() external view returns (uint256);
}
