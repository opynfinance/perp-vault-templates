// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IVault} from "../interfaces/IVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

contract ETHProxy {
  using SafeERC20 for IVault;
  using SafeERC20 for IERC20;

  IVault immutable vault;
  IWETH immutable WETH;

  constructor(address _vault, address _weth) {
    vault = IVault(_vault);
    WETH = IWETH(_weth);

    IERC20(_weth).safeApprove(_vault, uint256(-1));
  }

  /**
   * @notice Deposits ETH into the vault
   */
  function depositETH() external payable {
    IWETH(WETH).deposit{value: msg.value}();

    vault.deposit(msg.value);

    uint256 shares = vault.balanceOf(address(this));

    vault.safeTransfer(msg.sender, shares);
  }

  /**
   * @dev register for a fair deposit
   * users will then be able to use claim shares on the vault contract to get their shares
   */
  function registerDepositETH() external payable {
    IWETH(WETH).deposit{value: msg.value}();

    vault.registerDeposit(msg.value, msg.sender);
  }

  /**
   * @notice Withdraws ETH from vault using vault shares.
   * @param _shares is the number of vault shares to be burned
   */
  function withdrawETH(uint256 _shares) external {
    vault.safeTransferFrom(msg.sender, address(this), _shares);

    // withdraw from vault and get weth
    vault.withdraw(_shares);

    uint256 wethBalance = WETH.balanceOf(address(this));

    IWETH(WETH).withdraw(wethBalance);
    (bool success, ) = msg.sender.call{value: wethBalance}("");
    require(success, "ETH transfer failed");
  }

  /**
   * @notice the receive ether function is called whenever the call data is empty
   */
  receive() external payable {
    require(msg.sender == address(WETH), "Cannot receive ETH");
  }
}
