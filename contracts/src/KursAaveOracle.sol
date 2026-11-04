// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// Aave v3's IPriceOracleGetter over Kurs, so an Aave v3 fork points its PoolAddressesProvider
/// at this contract: getAssetPrice(token) -> USD price, BASE_CURRENCY_UNIT = 1e8.
///
/// Each asset maps to a USD feed ("WBTC" -> "BTC/USD") or to the inverse of a USD/x feed
/// (a Rupiah stablecoin -> "USD/IDR"), fixed at construction: no owner.
/// Unlike AaveOracle, every read requires the round to be younger than maxAge
/// (latestRoundFresh, ERC-7412 OracleDataRequired otherwise): this interface returns no
/// timestamp, so a lending market could not detect a stale price itself.
contract KursAaveOracle {
    struct Source {
        bytes32 feedId;
        bool inverse; // feed is USD/asset
    }

    KursOracle public immutable oracle;
    uint32 public immutable maxAge;
    address public constant BASE_CURRENCY = address(0); // USD, as in Aave v3 markets
    uint256 public constant BASE_CURRENCY_UNIT = 1e8;

    mapping(address => Source) public sourceOf;

    error UnknownAsset(address asset);
    error BadPrice(bytes32 feedId);

    constructor(KursOracle oracle_, uint32 maxAge_, address[] memory assets, bytes32[] memory feeds, bool[] memory inverse) {
        oracle = oracle_;
        maxAge = maxAge_;
        for (uint256 i; i < assets.length; ++i) sourceOf[assets[i]] = Source(feeds[i], inverse[i]);
    }

    function getAssetPrice(address asset) public view returns (uint256) {
        if (asset == BASE_CURRENCY) return BASE_CURRENCY_UNIT;
        Source memory s = sourceOf[asset];
        if (s.feedId == bytes32(0)) revert UnknownAsset(asset);
        (, int192 answer,,) = oracle.latestRoundFresh(s.feedId, maxAge);
        if (answer <= 0) revert BadPrice(s.feedId);
        uint256 scale = 10 ** oracle.feed(s.feedId).decimals;
        uint256 p = uint256(int256(answer));
        return s.inverse ? (BASE_CURRENCY_UNIT * scale) / p : (p * BASE_CURRENCY_UNIT) / scale;
    }

    function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory prices) {
        prices = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) prices[i] = getAssetPrice(assets[i]);
    }

    /// Aave's AaveOracle exposes the source per asset; here it is this contract plus the feed.
    function getSourceOfAsset(address asset) external view returns (address) {
        return sourceOf[asset].feedId == bytes32(0) ? address(0) : address(this);
    }
}
