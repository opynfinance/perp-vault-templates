//SPDX-License-Identifier: MIT
pragma solidity ^0.7.2;
pragma experimental ABIEncoderV2;

import {SwapTypes} from "../libraries/SwapTypes.sol";
import {IEasyAuction} from "../interfaces/IEasyAuction.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

contract MockEasyAuction {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  uint256 public auctionCounter;

  mapping(address => bool) registered;

  mapping(uint256 => address) biddingToken;
  mapping(uint256 => address) auctioningToken;
  mapping(address => uint256) userMinBuy;

  function auctionData(uint256 _id) external view returns (IEasyAuction.AuctionData memory) {
    return
      IEasyAuction.AuctionData(
        auctioningToken[_id],
        biddingToken[_id],
        0,
        0,
        "",
        0,
        0,
        bytes32(0),
        bytes32(0),
        0,
        false,
        false,
        0,
        0
      );
  }

  function registerUser(address user) external returns (uint64 userId) {
    registered[user] = true;
  }

  function initiateAuction(
    address _auctioningToken,
    address _biddingToken,
    uint256, /*orderCancellationEndDate*/
    uint256, /*auctionEndDate*/
    uint96 _auctionedSellAmount,
    uint96, /*_minBuyAmount*/
    uint256, /*minimumBiddingAmountPerOrder*/
    uint256, /*minFundingThreshold*/
    bool, /*isAtomicClosureAllowed*/
    address, /*accessManagerContract*/
    bytes memory /*accessManagerContractData*/
  ) external returns (uint256) {
    auctionCounter = auctionCounter.add(1);
    {
      IERC20(_auctioningToken).safeTransferFrom(msg.sender, address(this), _auctionedSellAmount);

      biddingToken[auctionCounter] = _biddingToken;
      auctioningToken[auctionCounter] = _auctioningToken;
    }

    return auctionCounter;
  }

  function placeSellOrders(
    uint256 auctionId,
    uint96[] memory _minBuyAmounts,
    uint96[] memory _sellAmounts,
    bytes32[] memory, /*_prevSellOrders*/
    bytes calldata /*allowListCallData*/
  )
    external
    returns (
      uint64 /*userId*/
    )
  {
    uint256 sumSellAmount;
    for (uint256 i = 0; i < _sellAmounts.length; i++) {
      sumSellAmount = sumSellAmount.add(_sellAmounts[i]);

      userMinBuy[msg.sender] = userMinBuy[msg.sender].add(_minBuyAmounts[i]);
    }

    IERC20(biddingToken[auctionId]).safeTransferFrom(msg.sender, address(this), sumSellAmount);
  }

  function claimFromParticipantOrder(
    uint256 auctionId,
    bytes32[] memory /*orders*/
  ) external {
    IERC20(auctioningToken[auctionId]).safeTransfer(msg.sender, userMinBuy[msg.sender]);
    userMinBuy[msg.sender] = 0;
  }
}
