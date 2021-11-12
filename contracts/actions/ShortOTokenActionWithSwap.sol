// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import { SafeMath } from '@openzeppelin/contracts/math/SafeMath.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { SafeERC20 } from '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';

import { IAction } from '../interfaces/IAction.sol';
import { IController } from '../interfaces/IController.sol';
import { ICurve } from '../interfaces/ICurve.sol';
import { IOracle } from '../interfaces/IOracle.sol';
import { IOToken } from '../interfaces/IOToken.sol';
import { IStakeDao } from '../interfaces/IStakeDao.sol';
import { IWETH } from '../interfaces/IWETH.sol'; 
import { SwapTypes } from '../libraries/SwapTypes.sol';
import { AirswapBase } from '../utils/AirswapBase.sol';
import { RollOverBase } from '../utils/RollOverBase.sol';
import { ILendingPool } from '../interfaces/ILendingPool.sol';

import 'hardhat/console.sol';

/**
 * Error Codes
 * S1: msg.sender must be the vault
 * S2: cannot currently close the vault position
 * S3: seller for the order (_order.sender.wallet) must be this contract
 * S4: token to sell (_order.sender.token) must be the currently activated oToken
 * S5: token to sell for (_order.signer.token) must be WETH
 * S6: tokens being sold (_order.sender.amount) and tokens being minted (_otokenAmount) must be the same
 * S7: amount of WETH being sold for (_order.signer.amount) does not meet the minimum option premium
 * S8: unable to unwrap WETH to ETH and add liquidity to curve: insufficient ETH
 * S9: strike price for the next oToken is too low
 * S10: expiry timestamp for the next oToken is invalid
 */

/**
 * @title ShortOTokenActionWithSwap
 * @author Opyn Team
 */

contract ShortOTokenActionWithSwap is IAction, AirswapBase, RollOverBase {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  address public immutable vault;

   /// @dev 100%
  uint256 constant public BASE = 10000;
  /// @dev the minimum strike price of the option chosen needs to be at least 105% of spot. 
  /// This is set expecting the contract to be a strategy selling calls. For puts should change this. 
  uint256 constant public MIN_STRIKE = 10500;
  uint256 public MIN_PROFITS; // 100 being 1%
  uint256 public lockedAsset;
  uint256 public rolloverTime;

  IController public controller;
  ICurve public curve;
  IERC20 ecrv;
  IOracle public oracle;
  IStakeDao public stakedao;
  IWETH weth;
  ILendingPool lendingPool;

  event MintAndSellOToken(uint256 collateralAmount, uint256 otokenAmount, uint256 premium);

  constructor(
    address _vault,
    address _stakedaoToken,
    address _swap,
    address _opynWhitelist,
    address _controller,
    address _curve,
    address _lendingPool,
    uint256 _vaultType,
    address _weth,
    uint256 _min_profits
  ) {
    MIN_PROFITS = _min_profits;
    vault = _vault;
    weth = IWETH(_weth);

    controller = IController(_controller);
    curve = ICurve(_curve);

    oracle = IOracle(controller.oracle());
    stakedao = IStakeDao(_stakedaoToken);
    ecrv = stakedao.token();

    lendingPool = ILendingPool(_lendingPool);

    // enable vault to take all the stakedaoToken back and re-distribute.
    IERC20(_stakedaoToken).safeApprove(_vault, uint256(-1));

    // enable pool contract to pull stakedaoToken from this contract to mint options.
    IERC20(_stakedaoToken).safeApprove(controller.pool(), uint256(-1));

    _initSwapContract(_swap);
    _initRollOverBase(_opynWhitelist);

    _openVault(_vaultType);
  }

  function onlyVault() private view {
    require(msg.sender == vault, "S1");
  }

  /**
   * @dev return the net worth of this strategy, in terms of weth.
   * if the action has an opened gamma vault, see if there's any short position
   */
  function currentValue() external view override returns (uint256) {
    return stakedao.balanceOf(address(this)).add(lockedAsset);
    
    // todo: caclulate cash value to avoid not early withdraw to avoid loss.
  }

  /**
   * @dev the function that the vault will call when the round is over
   */
  function closePosition() external override {
    onlyVault();
    require(canClosePosition(), 'S2');
    
    if(_canSettleVault()) {
      _settleVault();
    }

    // this function can only be called when it's `Activated`
    // go to the next step, which will enable owner to commit next oToken
    _setActionIdle();

    lockedAsset = 0;
  }

  /**
   * @dev the function that the vault will call when the new round is starting
   */
  function rolloverPosition() external override {
    onlyVault();
    
    // this function can only be called when it's `Committed`
    _rollOverNextOTokenAndActivate();
    rolloverTime = block.timestamp;
  }

  // /**
  //  * @dev owner only function to mint options with "ecrv" and sell otokens in this contract 
  //  * by filling an order on AirSwap.
  //  * this can only be done in "activated" state. which is achievable by calling `rolloverPosition`
  //  */
  // function mintAndSellOToken(uint256 _collateralAmount, uint256 _otokenAmount, SwapTypes.Order memory _order) external onlyOwner {
  //   onlyActivated();
  //   require(_order.sender.wallet == address(this), 'S3');
  //   require(_order.sender.token == currentSpread.shortOtoken, 'S4');
  //   require(_order.signer.token == address(weth), 'S5');
  //   require(_order.sender.amount == _otokenAmount, 'S6');
  //   require(_collateralAmount.mul(MIN_PROFITS).div(BASE) <= _order.signer.amount, 'S7');

  //   // buy long otokens

  //   // mint options
  //   _mintOTokens(_collateralAmount, _otokenAmount);

  //   lockedAsset = lockedAsset.add(_collateralAmount);

  //   IERC20(currentSpread.shortOtoken).safeIncreaseAllowance(address(airswap), _order.sender.amount);

  //   // sell options on airswap for weth
  //   // _fillAirswapOrder(_order);

  //   // convert the weth received as premium to sdeCRV
  //   // _wethToSdEcrv();

  //   emit MintAndSellOToken(_collateralAmount, _otokenAmount, _order.signer.amount);
  // }

  function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    )
        external
        // override
        returns (bool)
    {

      require(amounts.length == 1, "too many assets");
        //
        // This contract now has the funds requested.
        // Your logic goes here.
        //        
        (uint256 otokensToSell, address counterparty) = abi.decode(params, (uint256, address));
        
        // 1. convert weth to sdecrv
        _wethToSdEcrv();

        // 2. mint options 
        uint256 wethBorrowed = amounts[0]; // 18 decimals 
        uint256 sdcrvAvailable = stakedao.balanceOf(address(this));
        _mintNakedOTokens( otokensToSell.mul(1e10), otokensToSell);

        // 3. use those options to mint options on behalf of mm      
        _mintSpread( otokensToSell, counterparty );

        // 4. deposit the new options and withdraw collateral
        _depositAndWithdraw( otokensToSell.mul(1e10), otokensToSell );
        
        // 5. transfer in weth
        // TODO: this already happened, should this move here? 
        // 6. unwrap sdTokens to weth
        _sdecrvToWeth();
        // 7. pay back borrowed amount 

        // At the end of your logic above, this contract owes
        // the flashloaned amounts + premiums.
        // Therefore ensure your contract has enough to repay
        // these amounts.

        // Approve the LendingPool contract allowance to *pull* the owed amount
        for (uint i = 0; i < assets.length; i++) {
            uint amountOwing = amounts[i].add(premiums[i]);
            IERC20(assets[i]).approve(address(lendingPool), amountOwing);
        }

        return true;
    }
  
  /** 
   * @notice This has to be an operator for the counterparty. 
   * Because it has operator permissions, use a separate account when transacting with this and 
   * limit the amount of money that is approved to be spent to margin pool. 
   * Always only approve the amount of weth that you will be using for the transaction, never more. 
   * @param optionsToSell this is the amount of options to sell, which is the same as the collateral to deposit
   */
  function flashMintAndSellOToken(uint256 optionsToSell, uint256 premium, address counterparty) external onlyOwner { 
    //0. Initial Logic Checks
    //require(counterparty.add != address(0), "Invalid counterparty address");
    
    // 1. flash borrow WETH
    address receiverAddress = address(this);
    address[] memory assets = new address[](1);
    assets[0] = address(weth);
    uint256[] memory amounts = new uint256[](1);
    uint256 collateralNeeded = optionsToSell.mul(1e10);
    uint256 amountSdEcrvInAction = stakedao.balanceOf(address(this));
    
    uint256 amountToFlashBorrow = collateralNeeded.sub(amountSdEcrvInAction);
    amounts[0] = amountToFlashBorrow; 
    uint256[] memory modes = new uint256[](1);
    modes[0] = 0;
    address onBehalfOf = address(this);

    bytes memory params = abi.encode(optionsToSell, counterparty);

    
    uint16 referralCode = 0;
    
    // 2. transfer weth in
    weth.transferFrom(counterparty, address(this), premium);
    
    lendingPool.flashLoan(
            receiverAddress,
            assets,
            amounts,
            modes,
            onBehalfOf,
            params,
            referralCode
        );

  }

  /**
   * @notice the function will return when someone can close a position. 1 day after rollover, 
   * if the option wasn't sold, anyone can close the position. 
   */
  function canClosePosition() public view returns(bool) {
    if (currentSpread.shortOtoken != address(0) && lockedAsset != 0) { 
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
  function _wethToSdEcrv() internal {
    uint256 wethBalance = weth.balanceOf(address(this));


    uint256[2] memory amounts;
    amounts[0] = wethBalance;
    amounts[1] = 0;

    //unwrap weth => eth to deposit on curve
    weth.withdraw(wethBalance);
    // deposit ETH to curve
    require(address(this).balance == wethBalance, 'S8');
    curve.add_liquidity{value:wethBalance}(amounts, 0); // minimum amount to deposit is 0 ETH
    uint256 ecrvToDeposit = ecrv.balanceOf(address(this));

    // deposit ecrv to stakedao
    ecrv.safeApprove(address(stakedao), 0);
    ecrv.safeApprove(address(stakedao), ecrvToDeposit);
    stakedao.deposit(ecrvToDeposit);
  }

  function _sdecrvToWeth() internal { 
    uint256 sdecrvToWithdraw = stakedao.balanceOf(address(this));
    stakedao.withdraw(sdecrvToWithdraw);
    uint256 ecrvBalance = ecrv.balanceOf(address(this));
    uint256 ethReceived = curve.remove_liquidity_one_coin(ecrvBalance, 0, 0);
    // wrap eth to weth
    weth.deposit{value: ethReceived}();
  }

  /**
   * @dev mint otoken in vault 0
   */
  function _mintNakedOTokens(uint256 _collateralAmount, uint256 _otokenAmount) internal {
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
        currentSpread.shortOtoken, // otoken
        1, // vaultId
        _otokenAmount, // amount
        0, // index
        "" // data
    );

    controller.operate(actions);
  }

  function _mintSpread(uint256 _otokenAmount, address _counterparty) internal { 
    // this action will always use vault id 0 
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](3);
    IERC20 optionToDeposit = IERC20(currentSpread.shortOtoken);
    optionToDeposit.safeIncreaseAllowance(controller.pool(), _otokenAmount);

    uint256 vaultId = controller.getAccountVaultCounter(_counterparty) + 1;

    actions[0] = IController.ActionArgs(
        IController.ActionType.OpenVault,
        _counterparty, // owner
        address(this), // second address
        address(0), // ecrv, otoken
        vaultId, // vaultId
        0, // amount
        0, // index
        "" // data
    );

    actions[1] = IController.ActionArgs(
        IController.ActionType.DepositLongOption,
        _counterparty, // vault owner
        address(this), // deposit from this address
        currentSpread.shortOtoken, // collateral sdecrv
        vaultId, // vaultId
        _otokenAmount, // amount
        0, // index
        "" // data
    );

    actions[2] = IController.ActionArgs(
      IController.ActionType.MintShortOption,
      _counterparty, // vault owner
      address(this), // mint to this address
      currentSpread.longOtoken, // otoken
      vaultId, // vaultId
      _otokenAmount, // amount
      0, // index
      "" // data
    );

    controller.operate(actions);
  } 

  function _depositAndWithdraw(uint256 _collateralAmount, uint256 _otokenAmount) internal { 
    // this action will always use vault id 0 
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](2);
    IERC20 optionToDeposit = IERC20(currentSpread.longOtoken);
    optionToDeposit.safeIncreaseAllowance(controller.pool(), _otokenAmount);
    
    uint256 shortStrike = IOToken(currentSpread.shortOtoken).strikePrice();
    uint256 longStrike = IOToken(currentSpread.longOtoken).strikePrice();

    // TODO improve with marginCalculator
    uint256 requiredCollateral = ((((longStrike).sub(shortStrike)).mul(1e10)).div(longStrike)).mul(_otokenAmount);

    uint256 collateralToBeWithdrawn = (_collateralAmount.sub(requiredCollateral));

    actions[0] = IController.ActionArgs(
        IController.ActionType.DepositLongOption,
        address(this), // vault owner
        address(this), // deposit from this address
        currentSpread.longOtoken, // collateral sdecrv
        1, // vaultId
        _otokenAmount, // amount
        0, // index
        "" // data
    );

    actions[1] = IController.ActionArgs(
        IController.ActionType.WithdrawCollateral,
        address(this), // vault owner
        address(this), // withdraw to the owner address
        address(stakedao), // collateral sdecrv
        1, // vaultId
        collateralToBeWithdrawn, // amount
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
    if (lockedAsset != 0 && currentSpread.shortOtoken != address(0)) {
      return controller.isSettlementAllowed(currentSpread.shortOtoken);
    }

    return false; 
  }

  
  /**
   * @dev funtion to add some custom logic to check the next otoken is valid to this strategy
   * this hook is triggered while action owner calls "commitNextOption"
   * so accessing otoken will give u the current otoken. 
   */
  function _customOTokenCheck(address _nextOToken) internal view {
    // Can override or replace this.
     require(_isValidStrike(IOToken(_nextOToken).strikePrice()), 'S9');
     require (_isValidExpiry(IOToken(_nextOToken).expiryTimestamp()), 'S10');
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
    uint256 spotPrice = oracle.getPrice(address(weth));
    // checks that the strike price set is > than 105% of current price
    return strikePrice >= spotPrice.mul(MIN_STRIKE).div(BASE);
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