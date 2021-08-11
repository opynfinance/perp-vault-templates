// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;

interface IWhitelist {
  function isWhitelistedOtoken(address _otoken) external view returns (bool);
  function whitelistCollateral(address _collateral) external;
  function whitelistProduct(
    address _underlying,
    address _strike,
    address _collateral,
    bool _isPut
  ) external;

}
