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
// import { AirswapBase } from '../utils/AirswapBase.sol';
import { RollOverBase } from '../utils/RollOverBase.sol';
import { ILendingPool } from '../interfaces/ILendingPool.sol';
import { ISwap } from "../interfaces/ISwap.sol";

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

contract ShortOTokenActionWithSwap is IAction, RollOverBase, ISwap {
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

  mapping(address => mapping(uint256 => uint256)) internal _nonceGroups;

  mapping(address => address) public authorized;

  bytes32 public constant DOMAIN_TYPEHASH =
    keccak256(
      abi.encodePacked(
        "EIP712Domain(",
        "string name,",
        "string version,",
        "uint256 chainId,",
        "address verifyingContract",
        ")"
      )
    );

  bytes32 public constant ORDER_TYPEHASH =
    keccak256(
      abi.encodePacked(
        "Order(",
        "uint256 nonce,",
        "uint256 expiry,",
        "address signerWallet,",
        "address signerToken,",
        "uint256 signerAmount,",
        "uint256 protocolFee,",
        "address senderWallet,",
        "address senderToken,",
        "uint256 senderAmount",
        ")"
      )
    );

  bytes32 public constant DOMAIN_NAME = keccak256("SWAP");
  bytes32 public constant DOMAIN_VERSION = keccak256("3");
  uint256 public immutable DOMAIN_CHAIN_ID;
  bytes32 public immutable DOMAIN_SEPARATOR;

  event MintAndSellOToken(uint256 collateralAmount, uint256 otokenAmount, uint256 premium);

  constructor(
    address _vault,
    // address _swap,
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

    uint256 currentChainId = getChainId();
    DOMAIN_CHAIN_ID = currentChainId;

    DOMAIN_SEPARATOR = keccak256(
      abi.encode(
        DOMAIN_TYPEHASH,
        DOMAIN_NAME,
        DOMAIN_VERSION,
        currentChainId,
        this
      )
    );

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

  /**
   * @notice Authorize a signer
   * @param signer address Wallet of the signer to authorize
   * @dev Emits an Authorize event
   */
  function authorize(address signer) external {
    require(signer != address(0), "SIGNER_INVALID");
    authorized[msg.sender] = signer;
    emit ISwap.Authorize(signer, msg.sender);
  }

  /**
   * @notice Checks Order Expiry, Nonce, Signature
   * @param nonce uint256 Unique and should be sequential
   * @param expiry uint256 Expiry in seconds since 1 January 1970
   * @param signerWallet address Wallet of the signer
   * @param signerToken address ERC20 token transferred from the signer
   * @param signerAmount uint256 Amount transferred from the signer
   * @param senderToken address ERC20 token transferred from the sender
   * @param senderAmount uint256 Amount transferred from the sender
   * @param v uint8 "v" value of the ECDSA signature
   * @param r bytes32 "r" value of the ECDSA signature
   * @param s bytes32 "s" value of the ECDSA signature
   */
  function _checkValidOrder(
    uint256 nonce,
    uint256 expiry,
    address signerWallet,
    address signerToken,
    uint256 signerAmount,
    address senderToken,
    uint256 senderAmount,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) internal {

    // Ensure the expiry is not passed
    require(expiry > block.timestamp, "EXPIRY_PASSED");

    // console.log('_checkValidOrder nonce', nonce);
    // console.log('_checkValidOrder expiry', expiry);
    // console.log('_checkValidOrder signerWallet', signerWallet);
    // console.log('_checkValidOrder signerToken', signerToken);
    // console.log('_checkValidOrder signerAmount', signerAmount);
    // console.log('_checkValidOrder senderToken', senderToken);
    // console.log('_checkValidOrder senderAmount', senderAmount);
    // console.log('_checkValidOrder v', v);
    // console.log('_checkValidOrder r', r);
    // console.log('_checkValidOrder s', s);

    bytes32 hashed = _getOrderHash(
      nonce,
      expiry,
      signerWallet,
      signerToken,
      signerAmount,
      msg.sender,
      senderToken,
      senderAmount
    );

    console.log('msg.sender', msg.sender);

    // Recover the signatory from the hash and signature
    address signatory = _getSignatory(hashed, v, r, s);

    // Ensure the signatory is not null
    require(signatory != address(0), "SIGNATURE_INVALID");

    // Ensure the nonce is not yet used and if not mark it used
    require(_markNonceAsUsed(signatory, nonce), "NONCE_ALREADY_USED");

    console.log('signerWallet SC', signerWallet);
    console.log('signatory SC', signatory);
    // Ensure the signatory is authorized by the signer wallet
    if (signerWallet != signatory) {
      require(authorized[signerWallet] == signatory, "UNAUTHORIZED");
    }
  }

  /**
   * @notice Hash order parameters
   * @param nonce uint256
   * @param expiry uint256
   * @param signerWallet address
   * @param signerToken address
   * @param signerAmount uint256
   * @param senderToken address
   * @param senderAmount uint256
   * @return bytes32
   */
  function _getOrderHash(
    uint256 nonce,
    uint256 expiry,
    address signerWallet,
    address signerToken,
    uint256 signerAmount,
    address senderWallet,
    address senderToken,
    uint256 senderAmount
  ) internal view returns (bytes32) {
    return
      keccak256(
        abi.encode(
          ORDER_TYPEHASH,
          nonce,
          expiry,
          signerWallet,
          signerToken,
          signerAmount,
          '0',
          senderWallet,
          senderToken,
          senderAmount
        )
      );
  }

  /**
   * @notice Recover the signatory from a signature
   * @param hash bytes32
   * @param v uint8
   * @param r bytes32
   * @param s bytes32
   */
  function _getSignatory(
    bytes32 hash,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) internal view returns (address) {
    return
      ecrecover(
        keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, hash)),
        v,
        r,
        s
      );
  }

  /**
   * @notice Marks a nonce as used for the given signer
   * @param signer address Address of the signer for which to mark the nonce as used
   * @param nonce uint256 Nonce to be marked as used
   * @return bool True if the nonce was not marked as used already
   */
  function _markNonceAsUsed(address signer, uint256 nonce)
    internal
    returns (bool)
  {
    uint256 groupKey = nonce / 256;
    uint256 indexInGroup = nonce % 256;
    uint256 group = _nonceGroups[signer][groupKey];

    // If it is already used, return false
    if ((group >> indexInGroup) & 1 == 1) {
      return false;
    }

    _nonceGroups[signer][groupKey] = group | (uint256(1) << indexInGroup);

    return true;
  }

  /**
   * @notice Returns the current chainId using the chainid opcode
   * @return id uint256 The chain id
   */
  function getChainId() public view returns (uint256 id) {
    // no-inline-assembly
    assembly {
      id := chainid()
    }
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
  function flashMintAndSellOToken(
      uint256 nonce,
      uint256 expiry,
      address counterparty,
      address signerToken,
      uint256 premium,
      address senderToken,
      uint256 optionsToSell,
      uint8 v,
      bytes32 r,
      bytes32 s
    ) external onlyOwner { 
    //0. Initial Logic Checks
    // require(counterparty != address(0), "Invalid counterparty address");

    console.log('_checkValidOrder nonce', nonce);
    console.log('_checkValidOrder expiry', expiry);
    console.log('_checkValidOrder signerWallet', counterparty);
    console.log('_checkValidOrder signerToken', signerToken);
    console.log('_checkValidOrder signerAmount', premium);
    console.log('_checkValidOrder senderToken', senderToken);
    console.log('_checkValidOrder senderAmount', optionsToSell);
    console.log('_checkValidOrder v', v);
    console.logBytes32(r);
    console.logBytes32(s);

    _checkValidOrder(
      nonce,
      expiry,
      counterparty,
      signerToken,
      premium,
      senderToken,
      optionsToSell,
      v,
      r,
      s
    );
    
    // transfer premium weth in
    weth.transferFrom(counterparty, address(this), premium);

    _flashLoan( optionsToSell, counterparty );

  }


  // function flashMintAndSellOToken(uint256 optionsToSell, uint256 premium, address counterparty) external onlyOwner { 
  //   //0. Initial Logic Checks
  //   //require(counterparty.add != address(0), "Invalid counterparty address");

  //   // flash borrow WETH
  //   address receiverAddress = address(this);
  //   address[] memory assets = new address[](1);
  //   assets[0] = address(weth);
  //   uint256[] memory amounts = new uint256[](1);
  //   uint256 wethNeeded = optionsToSell.mul(1e10);
  //   uint256 collateralInAction = weth.balanceOf(address(this));
    
  //   // sdcrv needed
  //   uint256 amountToFlashBorrow = wethNeeded.sub(collateralInAction);
  //   amounts[0] = amountToFlashBorrow; 
  //   uint256[] memory modes = new uint256[](1);
  //   modes[0] = 0;
  //   address onBehalfOf = address(this);

  //   bytes memory params = abi.encode(optionsToSell, counterparty);

  //   uint16 referralCode = 0;
    
  //   // transfer premium weth in
  //   weth.transferFrom(counterparty, address(this), premium);

  //   // flash loan
  //   lendingPool.flashLoan(
  //           receiverAddress,
  //           assets,
  //           amounts,
  //           modes,
  //           onBehalfOf,
  //           params,
  //           referralCode
  //       );

  // }

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

}