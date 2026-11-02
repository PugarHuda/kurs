// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// @notice Chainlink AggregatorV3Interface shape, so existing DeFi code
/// (lending markets, vaults, perps) reads Kurs without changes.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title KursAggregatorV3
/// @notice One per feed. Thin read-only adapter over KursOracle.
/// startedAt = oldest reporter observation, updatedAt = local block time.
contract KursAggregatorV3 is AggregatorV3Interface {
    KursOracle public immutable oracle;
    bytes32 public immutable feedId;

    error NoData();

    constructor(KursOracle oracle_, bytes32 feedId_) {
        oracle = oracle_;
        feedId = feedId_;
    }

    function decimals() external view returns (uint8) {
        return oracle.feed(feedId).decimals;
    }

    function description() external view returns (string memory) {
        return oracle.feed(feedId).description;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80 roundId) public view returns (uint80, int256, uint256, uint256, uint80) {
        KursOracle.Round memory r = oracle.getRound(feedId, roundId);
        if (r.updatedAt == 0) revert NoData();
        return (roundId, r.answer, r.observedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(oracle.latestRoundId(feedId));
    }
}
