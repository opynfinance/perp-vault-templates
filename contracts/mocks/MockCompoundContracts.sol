//SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import {IAction} from "../interfaces/IAction.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IComptroller} from "../interfaces/IComptroller.sol";
import {ICToken} from "../interfaces/ICToken.sol";
import {ICEth} from "../interfaces/ICEth.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

contract MockCErc20 is ERC20Upgradeable, ICToken {
  IERC20 underlying;

  // uint256 mockRate = 90;

  constructor(
    address _underlying,
    string memory _name,
    string memory _symbol,
    uint8 _decimals
  ) {
    underlying = IERC20(_underlying);
    __ERC20_init(_name, _symbol);
    _setupDecimals(_decimals);
  }

  function mint(uint256 _amount) external override returns (uint256) {
    underlying.transferFrom(msg.sender, address(this), _amount);
    _mint(msg.sender, _amount);
    return 0;
  }

  function borrow(uint256 _amount) external override returns (uint256) {
    IERC20(underlying).transfer(msg.sender, _amount);
    return 0;
  }

  function repayBorrow(uint256 _amount) external override returns (uint256) {
    IERC20(underlying).transferFrom(msg.sender, address(this), _amount);
    return 0;
  }
}

contract MockCEth is ERC20Upgradeable, ICEth {
  // uint256 mockRate = 98;
  uint256 repaidAmount;

  constructor() {
    __ERC20_init("Compound ETH", "cETH");
    _setupDecimals(18);
  }

  function mint() external payable override {
    _mint(msg.sender, msg.value);
  }

  function borrow(uint256 _amount) external override returns (uint256) {
    address payable sender = msg.sender;
    sender.transfer(_amount);
    return 0;
  }

  function repayBorrow() external payable override {
    repaidAmount = repaidAmount + msg.value;
  }

  receive() external payable {}
}

contract MockComptroller is IComptroller {
  bool entered;

  function enterMarkets(address[] calldata) external override returns (uint256[] memory) {
    entered = true;
    uint256[] memory errors = new uint256[](1);
    errors[0] = 0;
    return errors;
  }
}
