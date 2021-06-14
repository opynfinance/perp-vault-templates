// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEasyAuction} from "../interfaces/IEasyAuction.sol";
import {SwapTypes} from "../libraries/SwapTypes.sol";

contract AuctionUtils {
  IEasyAuction public auction;

  function _initAuction(address _easyAuction) internal {
    if (_easyAuction == address(0)) return;
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

    IERC20(_auctioningToken).approve(address(auction), _auctionedSellAmount);

    auction.initiateAuction(
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
      ""
    );
  }
}
