// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AggregatorV3Interface, KursAggregatorFactory} from "./KursAggregatorV3.sol";

/// Chainlink's Feed Registry (FeedRegistryInterface) over Kurs: a protocol looks a price up
/// by (base, quote) asset address instead of storing one aggregator per pair.
///
/// Assets use Chainlink's Denominations: ETH 0xEeee…EEeE, BTC 0xbBbB…BBbB, fiat and gold
/// as their ISO 4217 numeric code (USD = address(840), EUR = 978, GBP = 826, JPY = 392,
/// CNY = 156, IDR = 360, XAU = 959). Like Chainlink's registry it serves only the direction
/// a feed exists in (EUR/USD, not USD/EUR) and reverts "Feed not found" otherwise.
/// Every call goes through the feed's KursAggregatorV3 clone, so answers are identical to
/// reading that aggregator. The table is fixed at construction: no owner.
contract KursFeedRegistry {
    KursAggregatorFactory public immutable factory;
    mapping(address => mapping(address => bytes32)) public feedIdOf;

    error FeedNotFound(address base, address quote);

    constructor(KursAggregatorFactory factory_, address[] memory bases, address[] memory quotes, bytes32[] memory feedIds) {
        factory = factory_;
        for (uint256 i; i < feedIds.length; ++i) feedIdOf[bases[i]][quotes[i]] = feedIds[i];
    }

    function getFeed(address base, address quote) public view returns (AggregatorV3Interface agg) {
        bytes32 id = feedIdOf[base][quote];
        if (id != bytes32(0)) agg = AggregatorV3Interface(factory.aggregatorOf(id));
        if (address(agg) == address(0)) revert FeedNotFound(base, quote);
    }

    function isFeedEnabled(address aggregator) external pure returns (bool) {
        return aggregator != address(0);
    }

    function decimals(address base, address quote) external view returns (uint8) {
        return getFeed(base, quote).decimals();
    }

    function description(address base, address quote) external view returns (string memory) {
        return getFeed(base, quote).description();
    }

    function version(address base, address quote) external view returns (uint256) {
        return getFeed(base, quote).version();
    }

    function latestRoundData(address base, address quote)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return getFeed(base, quote).latestRoundData();
    }

    function getRoundData(address base, address quote, uint80 _roundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return getFeed(base, quote).getRoundData(_roundId);
    }

    function latestAnswer(address base, address quote) external view returns (int256 answer) {
        (, answer,,,) = getFeed(base, quote).latestRoundData();
    }

    function latestTimestamp(address base, address quote) external view returns (uint256 updatedAt) {
        (,,, updatedAt,) = getFeed(base, quote).latestRoundData();
    }

    function latestRound(address base, address quote) external view returns (uint256 roundId) {
        (uint80 r,,,,) = getFeed(base, quote).latestRoundData();
        roundId = r;
    }
}
