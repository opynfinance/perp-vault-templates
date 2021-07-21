// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {GammaUtils} from "../utils/GammaUtils.sol";
import {RollOverBase} from "../utils/RollOverBase.sol";

// use airswap to short / long
import {AirswapUtils} from "../utils/AirswapUtils.sol";
// use auction to short / long
import {AuctionUtils} from "../utils/AuctionUtils.sol";

import {SwapTypes} from "../libraries/SwapTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

import {IController} from "../interfaces/IController.sol";
import {IAction} from "../interfaces/IAction.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {IOToken} from "../interfaces/IOToken.sol";

/**
 * This is an Short Action template that inherit lots of util functions to "Short" an option.
 * You can remove the function you don't need.
 */
contract ShortOToken is IAction, OwnableUpgradeable, AuctionUtils, AirswapUtils, RollOverBase, GammaUtils {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  /// @dev 100%
  uint256 public constant BASE = 10000;

  /// @dev minimum profits this strategy will make in any round. Set to 1%. 
  uint256 public constant MIN_PROFITS = 100; 

  /// @dev amount of assets locked in Opyn
  uint256 public lockedAsset;

  /// @dev time at which the last rollover was called
  uint256 public rolloverTime;

  /// @dev address of the vault 
  address public immutable vault;

  /// @dev address of the ERC20 asset. Do not use non-ERC20s
  address public immutable asset;

  /// @dev address of opyn's oracle contract
  IOracle public oracle;

  /** 
    * @notice constructor 
    * @param _vault the address of the vault contract
    * @param _asset address of the ERC20 asset
    * @param _airswap address of airswap swap contract 
    * @param _easyAuction address of gnosisSafe easy auction contract
    * @param _controller address of Opyn controller contract
    * @param _vaultType type 1 = partially collateralized, type 0 = fully collateralized 
    */
  constructor(
    address _vault,
    address _asset,
    address _airswap,
    address _easyAuction,
    address _controller,
    uint256 _vaultType
  ) {
    vault = _vault;
    asset = _asset;

    // enable vault to take all the asset back and re-distribute.
    IERC20(_asset).safeApprove(_vault, uint256(-1));

    _initGammaUtil(_controller);

    // enable pool contract to pull asset from this contract to mint options.
    address pool = controller.pool();

    oracle = IOracle(controller.oracle());
    address whitelist = controller.whitelist();

    IERC20(_asset).safeApprove(pool, uint256(-1));

    // init the contract used to short
    _initAuction(_easyAuction);
    _initSwapContract(_airswap);

    _initRollOverBase(whitelist);
    __Ownable_init();

    _openGammaVault(_vaultType);
  }

  modifier onlyVault() {
    require(msg.sender == vault, "!VAULT");

    _;
  }

  /**
   * @notice returns the net worth of this strategy = current balance of the action + collateral deposited into Opyn's vault. 
   * @dev For a more realtime tracking of value, we reccomend calculating the current value as: 
   * currentValue = balance + collateral - (numOptions * cashVal), where: 
   * balance = current balance in the action
   * collateral = collateral deposited into Opyn's vault 
   * numOptions = number of options sold
   * cashVal = cash value of 1 option sold (for puts: Strike - Current Underlying Price, for calls: Current Underlying Price - Strike)
   */
  function currentValue() external view override returns (uint256) {
    uint256 assetBalance = IERC20(asset).balanceOf(address(this));
    return assetBalance.add(lockedAsset);
  }

  /**
   * @notice the function that the vault will call when the round is over. This will settle the vault and pull back all money from Opyn. 
   * If the option expired OTM, then all the collateral is returned to this action. If not, some portion of the collateral is deducted 
   * by the Opyn system. 
   * @dev this can be called after 1 day rollover was called if no options have been sold OR if the sold options expired. 
   */
  function closePosition() external override onlyVault {
    require(canClosePosition(), "Cannot close position");
    if (_canSettleVault()) {
      _settleGammaVault();
    }
    _setActionIdle();
    lockedAsset = 0;
  }

  /**
   * @notice the function that the vault will call when the new round is starting. Once this is called, the funds will be sent from the vault to this action. 
   * @dev this does NOT automatically mint options and sell them. This merely receives funds. Before this function is called, the owner should have called 
   * `commitOToken` to decide on what Otoken is being sold. This function can only be called after the commitment period has passed since the call to `commitOToken`.
   * Once this has been called, the owner should call one of the mint and sell functions (either auction or airswap OTC). If the owner doesn't mint and sell the options within 
   * 1 day after rollover has been called, someone can call closePosition and transfer the funds back to the vault. If that happens, the owner needs to commit to a new otoken
   * and call rollover again. 
   */
  function rolloverPosition() external override onlyVault {
    _rollOverNextOTokenAndActivate(); // this function can only be called when the action is `Committed`
    rolloverTime = block.timestamp;
  }


  /**
   * @notice owner only function to mint options with "assets" and start an aunction to start it.
   * this can only be done in "activated" state. which is achievable by calling `rolloverPosition`. 
   * @dev once the auction starts, `_otokenToSell` amount of otokens will be sent to the auction contract. 
   * The auction cannot be stopped once it is in progress. Once the auction is over, if the minimum threshold
   * was met, someone needs to call `claimFromParticipantOrder` on the gnosis auction contract to transfer premiums. 
   */
  function mintAndStartAuction(
    uint256 _collateralAmount,
    uint256 _otokenToMint,
    uint96 _otokenToSell,
    uint256 _orderCancellationEndDate,
    uint256 _auctionEndDate,
    uint96 _minPremium,
    uint256 _minimumBiddingAmountPerOrder,
    uint256 _minFundingThreshold,
    bool _isAtomicClosureAllowed
  ) external onlyOwner onlyActivated {
    // mint otoken
    if (_collateralAmount > 0 && _otokenToMint > 0) {
      lockedAsset = lockedAsset.add(_collateralAmount);
      _mintOTokens(asset, _collateralAmount, otoken, _otokenToMint);
    }

    _startAuction(
      otoken,
      asset,
      _orderCancellationEndDate,
      _auctionEndDate,
      _otokenToSell,
      _minPremium, // minBuyAmount
      _minimumBiddingAmountPerOrder,
      _minFundingThreshold,
      _isAtomicClosureAllowed
    );
  }

  /**
   * @notice mint options with "asset" and participate in an ongoing auction to sell it for asset.
   * this can only be done in "activated" state which is achievable by calling `rolloverPosition`. 
   * @dev `_sellAmounts` will be transferred to the gnosis auction when the bid is placed. The actual 
   * premium may not be received till the auction ends. 
   */
  function mintAndBidInAuction(
    uint256 _auctionId,
    uint256 _collateralAmount,
    uint256 _otokenToMint,
    uint96[] memory _minBuyAmounts, // min amount of asset to get (premium)
    uint96[] memory _sellAmounts, // amount of otoken selling
    bytes32[] memory _prevSellOrders,
    bytes calldata _allowListCallData
  ) external onlyOwner onlyActivated {
    // mint token
    if (_collateralAmount > 0 && _otokenToMint > 0) {
      lockedAsset = lockedAsset.add(_collateralAmount);
      _mintOTokens(asset, _collateralAmount, otoken, _otokenToMint);
    }

    _bidInAuction(asset, otoken, _auctionId, _minBuyAmounts, _sellAmounts, _prevSellOrders, _allowListCallData);
  }

  /**
   * @notice mint options with "assets" and sell otokens in this action by filling an order on AirSwap.
   * this can only be done in "activated" state which is achievable by calling `rolloverPosition`.
   * @dev when doing an airswap OTC, the otokens will be swapped for premium in the same transaction atomically. No 
   * additional transactions are required on the owner's part to recieve the premium.
   */
  function mintAndTradeAirSwapOTC(
    uint256 _collateralAmount,
    uint256 _otokenAmount,
    SwapTypes.Order memory _order
  ) external onlyOwner onlyActivated {
    require(_order.sender.wallet == address(this), "!Sender");
    require(_order.sender.token == otoken, "Can only sell otoken");
    require(_order.signer.token == asset, "Can only sell for asset");
    require(_collateralAmount.mul(MIN_PROFITS).div(BASE) <= _order.signer.amount, "Need minimum option premium");

    lockedAsset = lockedAsset.add(_collateralAmount);

    // mint otoken using the util function
    _mintOTokens(asset, _collateralAmount, otoken, _otokenAmount);

    _fillAirswapOrder(_order);
  }

  /**
   * @notice the function will return when someone can close a position. 1 day after rollover,
   * if the option wasn't sold, anyone can close the position and send funds back to the vault. 
   */
  function canClosePosition() public view returns (bool) {
    if (otoken != address(0) && lockedAsset != 0) {
      return _canSettleVault();
    }
    return block.timestamp > rolloverTime + 1 days;
  }

  /**
   * @notice checks if the current vault can be settled
   */
  function _canSettleVault() internal view returns (bool) {
    if (lockedAsset != 0 && otoken != address(0)) {
      return controller.isSettlementAllowed(otoken);
    }

    return false;
  }

  /**
   * @notice funtion to add some custom logic to check the next otoken is valid to this strategy
   * this hook is triggered while action owner calls "commitNextOption"
   * so accessing otoken will give u the current otoken.
   */
  function _customOTokenCheck(address _nextOToken) internal view override {
    IOToken otokenToCheck = IOToken(_nextOToken);
    require(
      _isValidStrike(otokenToCheck.underlyingAsset(), otokenToCheck.strikePrice(), otokenToCheck.isPut()),
      "Bad Strike Price"
    );
    require(_isValidExpiry(otokenToCheck.expiryTimestamp()), "Invalid expiry");
    // add more checks here
    // check underlying or strike asset is valid .. etc
  }

  /**
   * @notice funtion to check that the otoken being sold meets a minimum valid strike price
   * this hook is triggered in the _customOtokenCheck function when the owner commits to an otoken.
   */
  function _isValidStrike(
    address _underlying,
    uint256 strikePrice,
    bool isPut
  ) internal view returns (bool) {
    // TODO: override with your filler code.
    // Example: checks that the strike price set is > than 105% of current price for calls, < 95% spot price for puts
    uint256 spotPrice = oracle.getPrice(_underlying);
    if (isPut) {
      return strikePrice <= spotPrice.mul(9500).div(BASE);
    } else {
      return strikePrice >= spotPrice.mul(10500).div(BASE);
    }
  }

  /**
   * @notice funtion to check that the otoken being sold meets certain expiry conditions
   * this hook is triggered in the _customOtokenCheck function when the owner commits to an otoken. 
   */
  function _isValidExpiry(uint256 expiry) internal view returns (bool) {
    // TODO: override with your filler code.
    // Checks that the token committed to expires within 15 days of commitment.
    return (block.timestamp).add(15 days) >= expiry;
  }
}
