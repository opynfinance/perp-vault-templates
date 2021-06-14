// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {IEasyAuction} from "../interfaces/IEasyAuction.sol";
import {SwapTypes} from "../libraries/SwapTypes.sol";

contract AuctionUtils {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  IEasyAuction public auction;

  /**
   * initialize the auction utils by putting in the gonsis safe easy auction address
   */
  function _initAuction(address _easyAuction) internal {
    if (_easyAuction == address(0)) return;
    auction = IEasyAuction(_easyAuction);
    auction.registerUser(address(this));
  }

  /**
   * participate in an auction.
   */
  function bidInAuction(
    address biddingAsset,
    uint256 auctionId,
    uint96[] memory _minBuyAmounts,
    uint96[] memory _sellAmounts,
    bytes32[] memory _prevSellOrders,
    bytes calldata allowListCallData
  ) internal {
    // approve auction to pull tokens from this contract
    uint256 sumSellAmount;
    for (uint256 i = 0; i < _sellAmounts.length; i++) {
      sumSellAmount = sumSellAmount.add(_sellAmounts[i]);
    }
    IERC20(biddingAsset).safeApprove(address(auction), sumSellAmount);

    auction.placeSellOrders(auctionId, _minBuyAmounts, _sellAmounts, _prevSellOrders, allowListCallData);
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

    IERC20(_auctioningToken).safeApprove(address(auction), _auctionedSellAmount);

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
