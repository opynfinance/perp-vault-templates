// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IVault} from "../interfaces/IVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICTokenERC20} from "../interfaces/ICToken.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

/**
 * if you have a vault which is using cToken as asset
 * u can use this proxy to help people deposit or withdraw
 */
contract CTokenProxy {
  using SafeERC20 for IVault;
  using SafeERC20 for IERC20;

  IVault immutable vault;
  IERC20 immutable underlying;
  ICTokenERC20 immutable cToken;

  constructor(
    address _vault,
    address _underlying,
    address _cToken
  ) {
    vault = IVault(_vault);
    cToken = ICTokenERC20(_cToken);
    underlying = IERC20(_underlying);

    IERC20(_cToken).safeApprove(_vault, uint256(-1));
    IERC20(_underlying).safeApprove(_cToken, uint256(-1));
  }

  /**
   * @notice wrap into ctoken and then deposit into the vault
   */
  function depositUnderlying(uint256 _amount) external {
    underlying.safeTransferFrom(msg.sender, address(this), _amount);
    cToken.mint(_amount);

    uint256 cTokenBalance = cToken.balanceOf(address(this));
    vault.deposit(cTokenBalance);

    uint256 shares = vault.balanceOf(address(this));
    vault.safeTransfer(msg.sender, shares);
  }

  /**
   * @dev register for a fair deposit
   * users will then be able to use claim shares on the vault contract to get their shares
   */
  function registerDepositUnderlying(uint256 _amount) external {
    underlying.safeTransferFrom(msg.sender, address(this), _amount);
    cToken.mint(_amount);

    uint256 cTokenBalance = cToken.balanceOf(address(this));
    vault.registerDeposit(cTokenBalance, msg.sender);
  }

  /**
   * @notice Withdraws ETH from vault using vault shares.
   * @param _shares is the number of vault shares to be burned
   */
  function withdrawUnderlying(uint256 _shares) external {
    vault.safeTransferFrom(msg.sender, address(this), _shares);

    // withdraw from vault and get weth
    vault.withdraw(_shares);

    uint256 cTokenBalance = cToken.balanceOf(address(this));

    cToken.redeem(cTokenBalance);

    uint256 underlyingBalance = underlying.balanceOf(address(this));
    underlying.transfer(msg.sender, underlyingBalance);
  }
}
