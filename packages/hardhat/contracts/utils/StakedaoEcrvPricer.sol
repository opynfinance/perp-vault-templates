// SPDX-License-Identifier: MIT

pragma solidity ^0.7.2;

import { IOracle } from "../interfaces/IOracle.sol";
import { IStakeDao } from "../interfaces/IStakeDao.sol";
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { SafeMath } from '@openzeppelin/contracts/math/SafeMath.sol';
import { ICurve } from '../interfaces/ICurve.sol';

/**
 * @notice A Pricer contract for a Stakedao lpToken
 */
contract StakedaoEcrvPricer {
    using SafeMath for uint256;

    /// @notice opyn oracle address
    IOracle public oracle;

    /// @notice lpToken that this pricer will a get price for
    IStakeDao public lpToken;

    /// @notice underlying asset for this lpToken
    IERC20 public underlying;

    /// @notice curve pool
    ICurve public curve;

    /**
     * @param _lpToken lpToken asset
     * @param _underlying underlying asset for this lpToken
     * @param _oracle Opyn Oracle contract address
     */
    constructor(
        address _lpToken,
        address _underlying,
        address _oracle, 
        address _curve
    ) public {
        require(_lpToken != address(0), "StakeDaoPricer: lpToken address can not be 0");
        require(_underlying != address(0), "StakeDaoPricer: underlying address can not be 0");
        require(_oracle != address(0), "StakeDaoPricer: oracle address can not be 0");
        require(_curve != address(0), "StakeDaoPricer: curve address can not be 0");

        lpToken = IStakeDao(_lpToken);
        underlying = IERC20(_underlying);
        oracle = IOracle(_oracle);
        curve = ICurve(_curve);
    }

    /**
     * @notice get the live price for the asset
     * @dev overrides the getPrice function in OpynPricerInterface
     * @return price of 1e8 lpToken in USD, scaled by 1e8
     */
    function getPrice() external view returns (uint256) {
        uint256 underlyingPrice = oracle.getPrice(address(underlying));
        require(underlyingPrice > 0, "StakeDaoPricer: underlying price is 0");
        return _underlyingPriceToYtokenPrice(underlyingPrice);
    }

    /**
     * @notice set the expiry price in the oracle
     * @dev requires that the underlying price has been set before setting a lpToken price
     * @param _expiryTimestamp expiry to set a price for
     */
    function setExpiryPriceInOracle(uint256 _expiryTimestamp) external {
        (uint256 underlyingPriceExpiry, ) = oracle.getExpiryPrice(address(underlying), _expiryTimestamp);
        require(underlyingPriceExpiry > 0, "StakeDaoPricer: underlying price not set yet");
        uint256 lpTokenPrice = _underlyingPriceToYtokenPrice(underlyingPriceExpiry);
        oracle.setExpiryPrice(address(lpToken), _expiryTimestamp, lpTokenPrice);
    }

    /**
     * @dev convert underlying price to lpToken price with the lpToken to underlying exchange rate
     * @param _underlyingPrice price of 1 underlying token (ie 1e6 USDC, 1e18 WETH) in USD, scaled by 1e8
     * @return price of 1e8 lpToken in USD, scaled by 1e8
     */
    function _underlyingPriceToYtokenPrice(uint256 _underlyingPrice) private view returns (uint256) {
        uint256 pricePerShare = lpToken.getPricePerFullShare();
        uint8 underlyingDecimals = 18;
        uint256 curvePrice = curve.get_virtual_price();

        return pricePerShare.mul(_underlyingPrice).mul(curvePrice).div(10**uint256(2 * underlyingDecimals));
    }

    function getHistoricalPrice(uint80 _roundId) external view returns (uint256, uint256) {
        revert("StakeDaoPricer: Deprecated");
    }
}