// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

import {IComptroller} from "../interfaces/IComptroller.sol";
import {ICErc20} from "../interfaces/ICErc20.sol";
import {ICEth} from "../interfaces/ICEth.sol";
import {IPriceFeed} from "../interfaces/IPriceFeed.sol";
import {IWETH} from "../interfaces/IWETH.sol";

contract CompoundUtils {
  IComptroller comptroller;
  IPriceFeed priceFeed;
  IWETH weth;

  function _initComompoundUtils(
    address _comptrollerAddress,
    address _priceFeedAddress,
    address _weth
  ) internal {
    comptroller = IComptroller(_comptrollerAddress);
    priceFeed = IPriceFeed(_priceFeedAddress);
    weth = IWETH(_weth);
  }

  function _supplyWeth(address payable _cEtherAddress, uint256 _amount) internal {
    // convert weth back to eth
    weth.withdraw(_amount);

    // Supply ETH as collateral, get cETH in return
    ICEth cEth = ICEth(_cEtherAddress);
    cEth.mint{value: _amount}();

    // Enter the ETH market so you can borrow another type of asset
    // it is not an error to enter the same market more than once.
    address[] memory cTokens = new address[](1);
    cTokens[0] = _cEtherAddress;
    uint256[] memory errors = comptroller.enterMarkets(cTokens);
    if (errors[0] != 0) {
      revert("Comptroller.enterMarkets failed.");
    }
  }

  function _supplyERC20(
    address _cToken,
    address _underlying,
    uint256 _amount
  ) internal {
    ICErc20 cToken = ICErc20(_cToken);
    IERC20 underlying = IERC20(_underlying);

    // Approve transfer of underlying
    underlying.approve(_cToken, _amount);

    // Supply underlying as collateral, get cToken in return
    uint256 error = cToken.mint(_amount);
    require(error == 0, "CErc20.mint Error");

    // Enter the market so you can borrow another type of asset
    // it is not an error to enter the same market more than once.
    address[] memory cTokens = new address[](1);
    cTokens[0] = _cToken;
    uint256[] memory errors = comptroller.enterMarkets(cTokens);
    if (errors[0] != 0) {
      revert("Comptroller.enterMarkets failed.");
    }
  }

  function _borrowWeth(address _cEther, uint256 _amountToBorrow) internal {
    // Borrow a fixed amount of ETH from cETH contract
    ICEth cEth = ICEth(_cEther);
    uint256 error = cEth.borrow(_amountToBorrow);
    require(error == 0, "borrow failed");

    // wrap eth to weth
    weth.deposit{value: _amountToBorrow}();
  }

  function _borrowERC20(address _cToken, uint256 _amountToBorrow) internal returns (uint256) {
    ICErc20 cToken = ICErc20(_cToken);
    // Borrow, check the underlying balance for this contract's address
    cToken.borrow(_amountToBorrow);

    // Get the borrow balance
    uint256 borrows = cToken.borrowBalanceCurrent(address(this));

    return borrows;
  }

  function repayBorrow(
    address _erc20Address,
    address _cErc20Address,
    uint256 amount
  ) public returns (bool) {
    IERC20 underlying = IERC20(_erc20Address);
    ICErc20 cToken = ICErc20(_cErc20Address);

    underlying.approve(_cErc20Address, amount);
    uint256 error = cToken.repayBorrow(amount);

    require(error == 0, "CErc20.repayBorrow Error");
    return true;
  }
}
