//SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/drafts/ERC20PermitUpgradeable.sol";

/**
 * Mock Stakedao
 */
contract MockStakedao is ERC20PermitUpgradeable {
    
    address ecrv;

  function init(string memory name_, string memory symbol_, uint8 decimals_, address _ecrv) public {
    __ERC20_init_unchained(name_, symbol_);
    _setupDecimals(decimals_);
    ecrv = _ecrv;
  }

  function mint(address account, uint256 amount) public {
    _mint(account, amount);
  }  

  function deposit(uint256 amount) public { 
      mint(msg.sender, amount);
  }

  function token () public returns (address) {
      return ecrv;
  }
}