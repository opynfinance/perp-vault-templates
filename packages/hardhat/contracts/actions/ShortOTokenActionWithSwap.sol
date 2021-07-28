// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import { AirswapBase } from '../utils/AirswapBase.sol';
import { RollOverBase } from '../utils/RollOverBase.sol';

import { SwapTypes } from '../libraries/SwapTypes.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { SafeERC20 } from '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';
import { SafeMath } from '@openzeppelin/contracts/math/SafeMath.sol';

import { IController } from '../interfaces/IController.sol';
import { IAction } from '../interfaces/IAction.sol';
import { IOracle } from '../interfaces/IOracle.sol';
import { IOToken } from '../interfaces/IOToken.sol';
import { IStakeDao } from '../interfaces/IStakeDao.sol';
import { ICurve } from '../interfaces/ICurve.sol';
import { IWETH } from '../interfaces/IWETH.sol'; 

import "hardhat/console.sol";

contract ShortOTokenActionWithSwap is IAction, OwnableUpgradeable, AirswapBase, RollOverBase {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

   /// @dev 100%
  uint256 constant public BASE = 10000;
  /// @dev the minimum strike price of the option chosen needs to be at least 105% of spot. 
  /// This is set expecting the contract to be a strategy selling calls. For puts should change this. 
  uint256 constant public MIN_STRIKE = 10500;
  uint256 constant public MIN_PROFITS = 100; // 1% 
  uint256 public lockedAsset;
  uint256 public rolloverTime;

  address public immutable vault;
  IController public controller;
  IOracle public oracle; 
  IStakeDao public stakedao;
  ICurve public curve;
  IERC20 ecrv;
  IWETH weth;
  


  constructor(
    address _vault,
    address _stakedaoToken,
    address _swap,
    address _opynWhitelist,
    address _controller,
    address _curve,
    uint256 _vaultType,
    address _weth
  ) {
    vault = _vault;
    weth = IWETH(_weth);

    controller = IController(_controller);
    curve = ICurve(_curve);

    address pool = controller.pool();
    
    oracle = IOracle(controller.oracle());
    stakedao = IStakeDao(_stakedaoToken);
    ecrv = stakedao.token();

    // enable vault to take all the weth back and re-distribute.
    IERC20(_weth).safeApprove(_vault, uint256(-1));

    // enable pool contract to pull stakedaoToken from this contract to mint options.
    IERC20(_stakedaoToken).safeApprove(pool, uint256(-1));

    _initSwapContract(_swap);
    _initRollOverBase(_opynWhitelist);
    __Ownable_init();

    _openVault(_vaultType);
  }

  modifier onlyVault() {
    require(msg.sender == vault, "!VAULT");

    _;
  }

  /**
   * @dev return the net worth of this strategy, in terms of weth.
   * if the action has an opened gamma vault, see if there's any short position
   */
  function currentValue() external view override returns (uint256) {
    uint256 wethBalance = weth.balanceOf(address(this));
    return wethBalance.add(lockedAsset);
    
    // todo: caclulate cash value to avoid not early withdraw to avoid loss.
  }

  /**
   * @dev the function that the vault will call when the round is over
   */
  function closePosition() external onlyVault override {
    require(canClosePosition(), "Cannot close position");
    
    if(_canSettleVault()) {
      _settleVault();
      _withdrawLiquidity();
    }

    // this function can only be called when it's `Activated`
    // go to the next step, which will enable owner to commit next oToken
    _setActionIdle();

    lockedAsset = 0;
  }

  /**
   * @dev the function that the vault will call when the new round is starting
   */
  function rolloverPosition() external onlyVault override {
    
    // this function can only be called when it's `Committed`
    _rollOverNextOTokenAndActivate();
    rolloverTime = block.timestamp;
  }

  /**
   * @dev owner only function to mint options with "ecrv" and sell otokens in this contract 
   * by filling an order on AirSwap.
   * this can only be done in "activated" state. which is achievable by calling `rolloverPosition`
   */
  function mintAndSellOToken(uint256 _collateralAmount, uint256 _otokenAmount, SwapTypes.Order memory _order) external onlyOwner onlyActivated {
    require(_order.sender.wallet == address(this), '!Sender');
    require(_order.sender.token == otoken, 'Can only sell otoken');
    require(_order.signer.token == address(weth), 'Can only sell for weth');
    require(_order.sender.amount == _otokenAmount, 'Need to sell all otokens minted');
    require(_collateralAmount.mul(MIN_PROFITS).div(BASE) <= _order.signer.amount, 'Need minimum option premium');

    uint256 amountOfLPTokens = _addLiquidityAndDeposit(_collateralAmount);

    _mintOTokens(amountOfLPTokens, _otokenAmount);

    IERC20(otoken).safeApprove(address(airswap), _order.sender.amount);

    _fillAirswapOrder(_order);
  }

  /**
   * @notice the function will return when someone can close a position. 1 day after rollover, 
   * if the option wasn't sold, anyone can close the position. 
   */
  function canClosePosition() public view returns(bool) {
    if (otoken != address(0) && lockedAsset != 0) { 
      return _canSettleVault();
    }
    return block.timestamp > rolloverTime + 1 days; 
  }

  /**
   * @dev open vault with vaultId 1. this should only be performed once when contract is initiated
   */
  function _openVault(uint256 _vaultType) internal {

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
        address(0), // ecrv, otoken
        1, // vaultId
        0, // amount
        0, // index
        data // data
    );

    controller.operate(actions);
  }

  receive() external payable {}
  fallback() external payable {}

  /**
   * @dev add liquidity to curve, deposit into stakedao.
   */
  function _addLiquidityAndDeposit(uint256 _amount) internal returns (uint256) {
    uint256[2] memory amounts;
    amounts[0] = _amount;
    amounts[1] = 0;
    uint256 minAmount = 0;

    //unwrap weth => eth to deposit on curve
    weth.withdraw(_amount);
    // deposit ETH to curve
    require(address(this).balance == _amount, 'insufficient ETH');
    curve.add_liquidity{value:_amount}(amounts, minAmount);
    uint256 ecrvToDeposit = ecrv.balanceOf(address(this));

    // deposit ecrv to stakedao
    ecrv.safeApprove(address(stakedao), ecrvToDeposit);
    stakedao.deposit(ecrvToDeposit);
    lockedAsset = lockedAsset.add(_amount);
    return stakedao.balanceOf(address(this));
  }

  /** @dev withdraws liquidity from stakedao */
  function _withdrawLiquidity() internal {
    stakedao.withdrawAll();
    uint256 ecrvBalance = ecrv.balanceOf(address(this));
    uint256 ethReceived = curve.remove_liquidity_one_coin(ecrvBalance, 0, 0);
    weth.deposit{ value: ethReceived }();
  }


  /**
   * @dev mint otoken in vault 0
   */
  function _mintOTokens(uint256 _collateralAmount, uint256 _otokenAmount) internal {
    // this action will always use vault id 0
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](2);

    actions[0] = IController.ActionArgs(
        IController.ActionType.DepositCollateral,
        address(this), // vault owner
        address(this), // deposit from this address
        address(stakedao), // collateral sdecrv
        1, // vaultId
        _collateralAmount, // amount
        0, // index
        "" // data
    );

    actions[1] = IController.ActionArgs(
        IController.ActionType.MintShortOption,
        address(this), // vault owner
        address(this), // mint to this address
        otoken, // otoken
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
  function _settleVault() internal {

    IController.ActionArgs[] memory actions = new IController.ActionArgs[](1);
    // this action will always use vault id 1
    actions[0] = IController.ActionArgs(
        IController.ActionType.SettleVault,
        address(this), // owner
        address(this), // recipient
        address(0), // ecrv
        1, // vaultId
        0, // amount
        0, // index
        "" // data
    );

    controller.operate(actions);
  }

  /**
   * @dev checks if the current vault can be settled
   */
  function _canSettleVault() internal view returns (bool) {
    if (lockedAsset != 0 && otoken != address(0)) {
      return controller.isSettlementAllowed(otoken);
    }

    return false; 
  }

  
  /**
   * @dev funtion to add some custom logic to check the next otoken is valid to this strategy
   * this hook is triggered while action owner calls "commitNextOption"
   * so accessing otoken will give u the current otoken. 
   */
  function _customOTokenCheck(address _nextOToken) internal view override {
    // Can override or replace this. 
     IOToken otokenToCheck = IOToken(_nextOToken);
     require(_isValidStrike(otokenToCheck.strikePrice()), 'Strike Price Too Low');
     require (_isValidExpiry(otokenToCheck.expiryTimestamp()), 'Invalid expiry');
    /**
     * e.g.
     * check otoken strike price is lower than current spot price for put.
     * check it's no more than x day til the current otoken expires. (can't commit too early)
     * check there's no previously committed otoken.
     * check otoken expiry is expected
     */
  }

  /**
   * @dev funtion to check that the otoken being sold meets a minimum valid strike price
   * this hook is triggered in the _customOtokenCheck function. 
   */
  function _isValidStrike(uint256 strikePrice) internal view returns (bool) {
    // // TODO: override with your filler code. 
    // uint256 spotPrice = oracle.getPrice(address(weth));
    // // checks that the strike price set is > than 105% of current price
    // return strikePrice >= spotPrice.mul(MIN_STRIKE).div(BASE);
    return true;
  }

  /**
   * @dev funtion to check that the otoken being sold meets certain expiry conditions
   * this hook is triggered in the _customOtokenCheck function. 
   */
  function _isValidExpiry(uint256 expiry) internal view returns (bool) {
    // TODO: override with your filler code. 
    // Checks that the token committed to expires within 15 days of commitment. 
    return (block.timestamp).add(15 days) >= expiry;
  }

}
