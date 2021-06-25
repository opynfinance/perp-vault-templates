// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;

interface ITreasury {
  function roundStartExchangeRate() external view returns (uint256);

  function roundEndExchangeRate() external view returns (uint256);

  function lastRoundProfit() external view returns (uint256);

  function lastRoundAssetSnapshot() external view returns (uint256);
}
