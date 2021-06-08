// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import { IEasyAuction } from "../interfaces/IEasyAuction.sol";
import { SwapTypes } from "../libraries/SwapTypes.sol";

contract AuctionBase {
    
  IEasyAuction public auction;

  uint256 auctionId;

  function _initAuctionBase(address _easyAuction) internal {
    require(_easyAuction != address(0), "Invalid auction address");
    auction = IEasyAuction(_easyAuction);
    
    auction.registerUser(address(this));
  }

  function _startAuction(
      address _auctioningToken,
      address _biddingToken,
      uint256 _orderCancellationEndDate,
      uint256 _auctionEndDate,
      uint96 _auctionedSellAmount,
      uint96 _minBuyAmount,
      uint256 _minimumBiddingAmountPerOrder,
      uint256 _minFundingThreshold,
      bool _isAtomicClosureAllowed
    ) internal {
      address accessManager = address(0);
      uint256 newAuctionId = auction.initiateAuction(
        _auctioningToken,
        _biddingToken,
        _orderCancellationEndDate,
        _auctionEndDate,
        _auctionedSellAmount,
        _minBuyAmount,
        _minimumBiddingAmountPerOrder,
        _minFundingThreshold,
        _isAtomicClosureAllowed,
        accessManager,
        ''
      );
      auctionId = newAuctionId;
  }

}

