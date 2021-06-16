// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

import {IController} from "../interfaces/IController.sol";

contract GammaUtils {
  IController controller;

  function _initGammaUtil(address _controller) internal {
    controller = IController(_controller);
  }

  /**
   * @dev open vault with vaultId 1. this should only be performed once when contract is initiated
   */
  function _openGammaVault(uint256 _vaultType) internal {
    bytes memory data;
    if (_vaultType != 0) {
      data = abi.encode(_vaultType);
    }

    // this action will always use vault id 0
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](1);

    actions[0] = IController.ActionArgs(
      IController.ActionType.OpenVault,
      address(this), // owner
      address(0), // second address
      address(0), // asset, otoken
      1, // vaultId
      0, // amount
      0, // index
      data // data
    );

    controller.operate(actions);
  }

  /**
   * @dev mint otoken in vault 0
   */
  function _mintOTokens(
    address _collateral,
    uint256 _collateralAmount,
    address _otoken,
    uint256 _otokenAmount
  ) internal {
    // this action will always use vault id 0
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](2);

    actions[0] = IController.ActionArgs(
      IController.ActionType.DepositCollateral,
      address(this), // vault owner
      address(this), // deposit from this address
      _collateral, // collateral asset
      1, // vaultId
      _collateralAmount, // amount
      0, // index
      "" // data
    );

    actions[1] = IController.ActionArgs(
      IController.ActionType.MintShortOption,
      address(this), // vault owner
      address(this), // mint to this address
      _otoken, // otoken
      1, // vaultId
      _otokenAmount, // amount
      0, // index
      "" // data
    );

    controller.operate(actions);
  }

  /**
   * @dev settle vault 0 and withdraw all locked collateral
   */
  function _settleGammaVault() internal {
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](1);
    // this action will always use vault id 1
    actions[0] = IController.ActionArgs(
      IController.ActionType.SettleVault,
      address(this), // owner
      address(this), // recipient
      address(0), // asset
      1, // vaultId
      0, // amount
      0, // index
      "" // data
    );

    controller.operate(actions);
  }

  function _redeemOTokens(address _otoken, uint256 _amount) internal {
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](1);
    // this action will always use vault id 1
    actions[0] = IController.ActionArgs(
      IController.ActionType.Redeem,
      address(0), // owner
      address(this), // secondAddress: recipient
      _otoken, // asset
      0, // vaultId
      _amount, // amount
      0, // index
      "" // data
    );
    controller.operate(actions);
  }
}
