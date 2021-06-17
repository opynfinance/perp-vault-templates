// SPDX-License-Identifier: MIT
pragma solidity >=0.7.2;
pragma experimental ABIEncoderV2;

interface IEasyAuction {
  struct AuctionData {
    address auctioningToken;
    address biddingToken;
    uint256 orderCancellationEndDate;
    uint256 auctionEndDate;
    bytes32 initialAuctionOrder;
    uint256 minimumBiddingAmountPerOrder;
    uint256 interimSumBidAmount;
    bytes32 interimOrder;
    bytes32 clearingPriceOrder;
    uint96 volumeClearingPriceOrder;
    bool minFundingThresholdNotReached;
    bool isAtomicClosureAllowed;
    uint256 feeNumerator;
    uint256 minFundingThreshold;
  }

  function FEE_DENOMINATOR() external view returns (uint256);

  function feeNumerator() external view returns (uint256);

  function auctionData(uint256 _id) external view returns (AuctionData memory);

  function auctionCounter() external view returns (uint256);

  // @dev: function to intiate a new auction
  // Warning: In case the auction is expected to raise more than
  // 2^96 units of the biddingToken, don't start the auction, as
  // it will not be settlable. This corresponds to about 79
  // billion DAI.
  //
  // Prices between biddingToken and auctioningToken are expressed by a
  // fraction whose components are stored as uint96.
  function initiateAuction(
    address _auctioningToken,
    address _biddingToken,
    uint256 orderCancellationEndDate,
    uint256 auctionEndDate,
    uint96 _auctionedSellAmount,
    uint96 _minBuyAmount,
    uint256 minimumBiddingAmountPerOrder,
    uint256 minFundingThreshold,
    bool isAtomicClosureAllowed,
    address accessManagerContract,
    bytes memory accessManagerContractData
  ) external returns (uint256);

  function placeSellOrders(
    uint256 auctionId,
    uint96[] memory _minBuyAmounts,
    uint96[] memory _sellAmounts,
    bytes32[] memory _prevSellOrders,
    bytes calldata allowListCallData
  ) external returns (uint64 userId);

  function placeSellOrdersOnBehalf(
    uint256 auctionId,
    uint96[] memory _minBuyAmounts,
    uint96[] memory _sellAmounts,
    bytes32[] memory _prevSellOrders,
    bytes calldata allowListCallData,
    address orderSubmitter
  ) external returns (uint64 userId);

  function cancelSellOrders(uint256 auctionId, bytes32[] memory _sellOrders) external;

  function precalculateSellAmountSum(uint256 auctionId, uint256 iterationSteps) external;

  function settleAuctionAtomically(
    uint256 auctionId,
    uint96[] memory _minBuyAmount,
    uint96[] memory _sellAmount,
    bytes32[] memory _prevSellOrder,
    bytes calldata allowListCallData
  ) external;

  // @dev function settling the auction and calculating the price
  function settleAuction(uint256 auctionId) external returns (bytes32 clearingOrder);

  function claimFromParticipantOrder(uint256 auctionId, bytes32[] memory orders)
    external
    returns (uint256 sumAuctioningTokenAmount, uint256 sumBiddingTokenAmount);

  function registerUser(address user) external returns (uint64 userId);

  function getUserId(address user) external returns (uint64 userId);

  function getSecondsRemainingInBatch(uint256 auctionId) external view returns (uint256);

  function containsOrder(uint256 auctionId, bytes32 order) external view returns (bool);
}
