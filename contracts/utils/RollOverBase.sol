// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import '@openzeppelin/contracts/access/Ownable.sol';
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

contract RollOverBase is Ownable {
  address public otoken;
  address public nextOToken;

  uint256 constant public MIN_COMMIT_PERIOD = 18 hours;
  uint256 public commitStateStart;

/**
 * Idle: action will go "idle" after the vault closes this position & before the next oToken is committed.
 *
 * Committed: owner has already set the next oToken this vault is trading. During this phase, all funds are
 * already back in the vault and waiting for redistribution. Users who don't agree with the setting of the next
 * round can withdraw.
 *
 * Activated: after vault calls "rollover", the owner can start minting / buying / selling according to each action.
 */
  enum ActionState {
    Activated,
    Committed,
    Idle
  }

  ActionState public state;
  IWhitelist public opynWhitelist;

  function onlyCommitted() private view {
    require(state == ActionState.Committed, "R1");
  }

  function onlyActivated() internal view {
    require(state == ActionState.Activated, "R2");
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

  function _setActionIdle() internal {
    onlyActivated();
    // wait for the owner to set the next option
    state = ActionState.Idle;
  }

  function _rollOverNextOTokenAndActivate() internal {
    onlyCommitted();
    require(block.timestamp - commitStateStart > MIN_COMMIT_PERIOD, "R4");

    otoken = nextOToken;
    nextOToken = address(0);

    state = ActionState.Activated;
  }

  function _checkOToken(address _nextOToken) private view {
    require(opynWhitelist.isWhitelistedOtoken(_nextOToken), 'R5');
  }
}
