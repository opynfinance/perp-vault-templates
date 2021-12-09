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
import { IWETH } from '../interfaces/IWETH.sol'; 
import { SwapTypes } from '../libraries/SwapTypes.sol';
import { AirswapBase } from '../utils/AirswapBase.sol';
import { RollOverBase } from '../utils/RollOverBase.sol';
import { ILendingPool } from '../interfaces/ILendingPool.sol';
import { ISwap } from '../interfaces/ISwap.sol';

import "hardhat/console.sol";

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

contract ShortOTokenActionWithSwap is IAction, RollOverBase, ISwap, AirswapBase {
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
  IOracle public oracle;
  IWETH weth;
  ILendingPool lendingPool;

  // Possible nonce statuses
  bytes1 internal constant AVAILABLE = 0x00;
  bytes1 internal constant UNAVAILABLE = 0x01;

  
  bytes32 public constant DOMAIN_TYPEHASH =
    keccak256(
      abi.encodePacked(
        "EIP712Domain(",
        "string name,",
        "string version,",
        "address verifyingContract",
        ")"
      )
    );

  bytes internal constant DOMAIN_NAME = "SWAP";
  bytes internal constant DOMAIN_VERSION = "2";


  // Unique domain identifier for use in signatures (EIP-712)
  bytes32 private _domainSeparator;

  // Mapping of sender address to a delegated sender address and bool
  mapping(address => mapping(address => bool)) public senderAuthorizations;

  // Mapping of signer address to a delegated signer and bool
  mapping(address => mapping(address => bool)) public signerAuthorizations;

  // Mapping of signers to nonces with value AVAILABLE (0x00) or UNAVAILABLE (0x01)
  mapping(address => mapping(uint256 => bytes1)) public signerNonceStatus;

  // Mapping of signer addresses to an optionally set minimum valid nonce
  mapping(address => uint256) public signerMinimumNonce;

  bytes internal constant EIP191_HEADER = "\x19\x01";

  bytes32 internal constant ORDER_TYPEHASH =
    keccak256(
      abi.encodePacked(
        "Order(",
        "uint256 nonce,",
        "uint256 expiry,",
        "Party signer,",
        "SenderParty sender,",
        "Party affiliate",
        ")",
        "Party(",
        "bytes4 kind,",
        "address wallet,",
        "address token,",
        "uint256 amount,",
        "uint256 id",
        ")"
        "SenderParty(",
        "bytes4 kind,",
        "address wallet,",
        "address token,",
        "uint256 amount,",
        "uint256 id,",
        "address lowerToken",
        ")"
      )
    );

    bytes32 internal constant PARTY_TYPEHASH =
    keccak256(
      abi.encodePacked(
        "Party(",
        "bytes4 kind,",
        "address wallet,",
        "address token,",
        "uint256 amount,",
        "uint256 id",
        ")"
      )
    );

    bytes32 internal constant SENDER_PARTY_TYPEHASH =
    keccak256(
      abi.encodePacked(
        "SenderParty(",
        "bytes4 kind,",
        "address wallet,",
        "address token,",
        "uint256 amount,",
        "uint256 id,",
        "address lowerToken",
        ")"
      )
    );


  

  event MintAndSellOToken(uint256 collateralAmount, uint256 otokenAmount, uint256 premium);

  constructor(
    address _vault,
    address _swap,
    address _opynWhitelist,
    address _controller,
    address _lendingPool,
    uint256 _vaultType,
    address _weth,
    uint256 _min_profits
  ) {
    MIN_PROFITS = _min_profits;
    vault = _vault;
    weth = IWETH(_weth);

    controller = IController(_controller);

    oracle = IOracle(controller.oracle());

    lendingPool = ILendingPool(_lendingPool);

    // enable vault to take all the weth back and re-distribute.
    IERC20(_weth).safeApprove(_vault, uint256(-1));

    // enable pool contract to pull weth from this contract to mint options.
    IERC20(_weth).safeApprove(controller.pool(), uint256(-1));

    // _initSwapContract(_swap);
    _initRollOverBase(_opynWhitelist);

    _openVault(_vaultType);

    _domainSeparator = keccak256(
        abi.encode(
          DOMAIN_TYPEHASH,
          keccak256(DOMAIN_NAME),
          keccak256(DOMAIN_VERSION),
          address(this)
        )
      );
  }

  function onlyVault() private view {
    require(msg.sender == vault, "S1");
  }

  /**
   * @dev return the net worth of this strategy, in terms of weth.
   * if the action has an opened gamma vault, see if there's any short position
   */
  function currentValue() external view override returns (uint256) {
    return weth.balanceOf(address(this)).add(lockedAsset);
    
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
  
        (uint256 otokensToSell, address counterparty) = abi.decode(params, (uint256, address));
      

        // 1. mint options 
        uint256 wethBorrowed = amounts[0]; // 18 decimals 
        
        _mintNakedOTokens( otokensToSell.mul(1e10), otokensToSell);

        // 2. use those options to mint options on behalf of mm      
        _mintSpread( otokensToSell, counterparty );

        // 3. deposit the new options and withdraw collateral
        _depositAndWithdraw( otokensToSell.mul(1e10), otokensToSell );

        // 4. pay back borrowed amount 
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
  function flashMintAndSellOToken(uint256 optionsToSell, uint256 premium, address counterparty, SwapTypes.Order memory order) external onlyOwner { 
    //0. Initial Logic Checks
    //require(counterparty.add != address(0), "Invalid counterparty address");


  // Ensure the order is not expired.
    require(order.expiry > block.timestamp, "ORDER_EXPIRED");

    // Ensure the nonce is AVAILABLE (0x00).
    require(
      signerNonceStatus[order.signer.wallet][order.nonce] == AVAILABLE,
      "ORDER_TAKEN_OR_CANCELLED"
    );

    // Ensure the order nonce is above the minimum.
    require(
      order.nonce >= signerMinimumNonce[order.signer.wallet],
      "NONCE_TOO_LOW"
    );

    // Mark the nonce UNAVAILABLE (0x01).
    signerNonceStatus[order.signer.wallet][order.nonce] = UNAVAILABLE;

    // Validate the sender side of the trade.
    address finalSenderWallet;

    if (order.sender.wallet == address(0)) {
      /**
       * Sender is not specified. The msg.sender of the transaction becomes
       * the sender of the order.
       */
      finalSenderWallet = msg.sender;
    } else {
      /**
       * Sender is specified. If the msg.sender is not the specified sender,
       * this determines whether the msg.sender is an authorized sender.
       */
      require(
        isSenderAuthorized(order.sender.wallet, address(this)),
        "SENDER_UNAUTHORIZED"
      );
      // The msg.sender is authorized.
      finalSenderWallet = order.sender.wallet;
    }

    // Validate the signer side of the trade.
    if (order.signature.v == 0) {
      /**
       * Signature is not provided. The signer may have authorized the
       * msg.sender to swap on its behalf, which does not require a signature.
       */
      require(
        isSignerAuthorized(order.signer.wallet, msg.sender),
        "SIGNER_UNAUTHORIZED"
      );
    } else {
      /**
       * The signature is provided. Determine whether the signer is
       * authorized and if so validate the signature itself.
       */
      require(
        isSignerAuthorized(order.signer.wallet, order.signature.signatory),
        "SIGNER_UNAUTHORIZED"
      );

      // Ensure the signature is valid.
      require(isValid(order, _domainSeparator), "SIGNATURE_INVALID");
    }
    
    // transfer premium weth in
    weth.transferFrom(counterparty, address(this), premium);


    _flashLoan( optionsToSell, counterparty );

  }

  function _flashLoan(uint256 optionsToSell, address counterparty ) internal {

    // flash borrow WETH
    address receiverAddress = address(this);
    address[] memory assets = new address[](1);
    assets[0] = address(weth);
    uint256[] memory amounts = new uint256[](1);
    uint256 wethNeeded = optionsToSell.mul(1e10);
    uint256 collateralInAction = weth.balanceOf(address(this));
    
    // sdcrv needed
    uint256 amountToFlashBorrow = wethNeeded.sub(collateralInAction);
    amounts[0] = amountToFlashBorrow; 
    uint256[] memory modes = new uint256[](1);
    modes[0] = 0;
    address onBehalfOf = address(this);

    bytes memory params = abi.encode(optionsToSell, counterparty);

    uint16 referralCode = 0;
    
    // flash loan
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
        address(0), // otoken
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
   * @dev mint otoken in vault 0
   */
  function _mintNakedOTokens(uint256 _collateralAmount, uint256 _otokenAmount) internal {
    // this action will always use vault id 0
    IController.ActionArgs[] memory actions = new IController.ActionArgs[](2);

    actions[0] = IController.ActionArgs(
        IController.ActionType.DepositCollateral,
        address(this), // vault owner
        address(this), // deposit from this address
        address(weth), // collateral weth
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
        address(0), // otoken
        vaultId, // vaultId
        0, // amount
        0, // index
        "" // data
    );

    actions[1] = IController.ActionArgs(
        IController.ActionType.DepositLongOption,
        _counterparty, // vault owner
        address(this), // deposit from this address
        currentSpread.shortOtoken, // collateral otoken
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
        currentSpread.longOtoken, // collateral otoken
        1, // vaultId
        _otokenAmount, // amount
        0, // index
        "" // data
    );

    actions[1] = IController.ActionArgs(
        IController.ActionType.WithdrawCollateral,
        address(this), // vault owner
        address(this), // withdraw to the owner address
        address(weth), // collateral weth
        1, // vaultId
        collateralToBeWithdrawn, // amount
        0, // index
        "" // data
    );

    controller.operate(actions);

    lockedAsset = lockedAsset.add(requiredCollateral);


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
        address(0), // 
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

  /**
   * @notice Determine whether a sender delegate is authorized
   * @param authorizer address Address doing the authorization
   * @param delegate address Address being authorized
   * @return bool True if a delegate is authorized to send
   */
  function isSenderAuthorized(address authorizer, address delegate)
    internal
    view
    returns (bool)
  {

    return ((authorizer == delegate) ||
      senderAuthorizations[authorizer][delegate]);
  }

  /**
   * @notice Determine whether a signer delegate is authorized
   * @param authorizer address Address doing the authorization
   * @param delegate address Address being authorized
   * @return bool True if a delegate is authorized to sign
   */
  function isSignerAuthorized(address authorizer, address delegate)
    internal
    view
    returns (bool)
  {
    return ((authorizer == delegate) ||
      signerAuthorizations[authorizer][delegate]);
  }

  /**
   * @notice Validate signature using an EIP-712 typed data hash
   * @param order Types.Order Order to validate
   * @param domainSeparator bytes32 Domain identifier used in signatures (EIP-712)
   * @return bool True if order has a valid signature
   */
  function isValid(SwapTypes.Order memory order, bytes32 domainSeparator)
    internal
    pure
    returns (bool)
  {
    if (order.signature.version == bytes1(0x01)) {      
      return
        order.signature.signatory ==
        ecrecover(
          hashOrder(order, domainSeparator),
          order.signature.v,
          order.signature.r,
          order.signature.s
        );
    }
    if (order.signature.version == bytes1(0x45)) {
      return
        order.signature.signatory ==
        ecrecover(
          keccak256(
            abi.encodePacked(
              "\x19Ethereum Signed Message:\n32",
              hashOrder(order, domainSeparator)
            )
          ),
          order.signature.v,
          order.signature.r,
          order.signature.s
        );
    }
    return false;
    
  }

  /**
   * @notice Hash an order into bytes32
   * @dev EIP-191 header and domain separator included
   * @param order Order The order to be hashed
   * @param domainSeparator bytes32
   * @return bytes32 A keccak256 abi.encodePacked value
   */
  function hashOrder(SwapTypes.Order memory order, bytes32 domainSeparator)
    internal
    view
    returns (bytes32)
  {

    return
      keccak256(
        abi.encodePacked(
          EIP191_HEADER,
          domainSeparator,
          keccak256(
            abi.encode(
              ORDER_TYPEHASH,
              order.nonce,
              order.expiry,
              keccak256(
                abi.encode(
                  PARTY_TYPEHASH,
                  order.signer.kind,
                  order.signer.wallet,
                  order.signer.token,
                  order.signer.amount,
                  order.signer.id
                )
              ),
              keccak256(
                abi.encode(
                  SENDER_PARTY_TYPEHASH,
                  order.sender.kind,
                  order.sender.wallet,
                  order.sender.token,
                  order.sender.amount,
                  order.sender.id,
                  order.sender.lowerToken
                )
              ),
              keccak256(
                abi.encode(
                  PARTY_TYPEHASH,
                  order.affiliate.kind,
                  order.affiliate.wallet,
                  order.affiliate.token,
                  order.affiliate.amount,
                  order.affiliate.id
                )
              )
            )
          )
        )
      );
  }

  /**
   * @notice Authorize a delegated sender
   * @dev Emits an AuthorizeSender event
   * @param authorizedSender address Address to authorize
   */
  function authorizeSender(address authorizedSender) external {
    require(msg.sender != authorizedSender, "SELF_AUTH_INVALID");
    if (!senderAuthorizations[msg.sender][authorizedSender]) {
      senderAuthorizations[msg.sender][authorizedSender] = true;
      emit ISwap.AuthorizeSender(msg.sender, authorizedSender);
    }
  }


}