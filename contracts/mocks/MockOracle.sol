// SPDX-License-Identifier: MIT
pragma solidity >=0.6.0;

contract MockOracle {
  uint80 roundId;
  int256 answer;
  uint256 startedAt;
  uint256 updatedAt;
  uint80 answeredInRound;

  function setData(
    uint80 _roundId,
    int256 _answer,
    uint256 _startedAt,
    uint256 _updatedAt,
    uint80 _answeredInRound
  ) public {
    roundId = _roundId;
    answer = _answer;
    startedAt = _startedAt;
    updatedAt = _updatedAt;
    answeredInRound = _answeredInRound;
  }

  function latestRoundData()
    external
    view
    returns (
      uint80,
      int256,
      uint256,
      uint256,
      uint80
    )
  {
    return (roundId, answer, startedAt, updatedAt, answeredInRound);
  }
}
