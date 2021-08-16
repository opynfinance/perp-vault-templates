// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { SafeERC20 } from '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';

import { AirswapBase } from './AirswapBase.sol';
import { IWhitelist } from '../interfaces/IWhitelist.sol';
import { SwapTypes } from '../libraries/SwapTypes.sol';

/**
 * Error Codes
 * R1: next oToken has not been committed to yet
 * R2: vault is not activated, cannot mint and sell oTokens or close an open position
 * R3: vault is currently activated, cannot commit next oToken or recommit an oToken
 * R4: cannot rollover next oToken and activate vault, commit phase period not over (MIN_COMMIT_PERIOD)
 * R5: token is not a whitelisted oToken
 */

/**
 * @title RolloverBase
 * @author Opyn Team
 */

contract RollOverBase is OwnableUpgradeable {
  address public otoken;
  address public nextOToken;

  uint256 constant public MIN_COMMIT_PERIOD = 18 hours;
  uint256 public commitStateStart;

  enum ActionState {
    // action will go "idle" after the vault close this position, and before the next otoken is committed.
    Idle,

    // onwer already set the next otoken this vault is trading.
    // during this phase, all funds are already back in the vault and waiting for re-distribution
    // users who don't agree with the setting of next round can withdraw.
    Committed,

    // after vault calls "rollover", owner can start minting / buying / selling according to each action.
    Activated
  }

  ActionState public state;

  IWhitelist public opynWhitelist;

  modifier onlyCommitted () {
    require(state == ActionState.Committed, "R1");
    _;
  }

  modifier onlyActivated () {
    require(state == ActionState.Activated, "R2");
    _;
  }


  function _initRollOverBase(address _opynWhitelist) internal {
    state = ActionState.Idle;
    opynWhitelist = IWhitelist(_opynWhitelist);
  }

  /**
   * owner can commit the next otoken, if it's in idle state.
   * or re-commit it if needed during the commit phase.
   */
  function commitOToken(address _nextOToken) external onlyOwner {
    require(state != ActionState.Activated, "R3");
    _checkOToken(_nextOToken);
    nextOToken = _nextOToken;

    state = ActionState.Committed;
    
    commitStateStart = block.timestamp;
  }

  function _setActionIdle() internal onlyActivated {
    // wait for the owner to set the next option
    state = ActionState.Idle;
  }

  function _rollOverNextOTokenAndActivate() internal onlyCommitted {
    require(block.timestamp - commitStateStart > MIN_COMMIT_PERIOD, "R4");

    otoken = nextOToken;
    nextOToken = address(0);

    state = ActionState.Activated;
  }

  function _checkOToken(address _nextOToken) private view {
    require(opynWhitelist.isWhitelistedOtoken(_nextOToken), 'R5');
    _customOTokenCheck(_nextOToken);
  }

  /**
   * cutom otoken check hook to be overriden by each 
   */
  function _customOTokenCheck(address) internal view virtual {}
}
