//SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/drafts/ERC20PermitUpgradeable.sol";
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

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
      IERC20(ecrv).transferFrom(msg.sender, address(this), amount);
      mint(msg.sender, amount);
  }

  function getPricePerFullShare() external pure returns (uint256) {
      return 1 ether;
  }

  function token () public view returns (address) {
      return ecrv;
  }

  function withdraw(uint256 amount) external {
      IERC20 ecrvToken = IERC20(ecrv);
      ecrvToken.transfer(msg.sender, amount);
      _burn(msg.sender, amount);
  }
}
