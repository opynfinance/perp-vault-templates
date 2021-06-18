// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IOToken is IERC20 {
  function underlyingAsset() external view returns (address);

  function strikeAsset() external view returns (address);

  function collateralAsset() external view returns (address);

  function strikePrice() external view returns (uint256);

  function expiryTimestamp() external view returns (uint256);

  function isPut() external view returns (bool);

  // function balanceOf(address account) external view returns (uint256);
}
