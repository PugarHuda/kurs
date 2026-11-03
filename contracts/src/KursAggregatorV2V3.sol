// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";
import {KursAggregatorV3} from "./KursAggregatorV3.sol";

/// @title KursAggregatorV2V3
/// @notice Chainlink AggregatorV2V3Interface view of one Kurs feed: the V3 functions plus
/// the V2 ones (latestAnswer, latestTimestamp, latestRound, getAnswer, getTimestamp)
/// that Aave V3's AaveOracle and older Compound-style integrations call.
/// V2 semantics follow Chainlink: missing data returns 0 instead of reverting, so
/// consumers must check the timestamp as they do with Chainlink.
contract KursAggregatorV2V3 is KursAggregatorV3 {
    constructor(KursOracle oracle_, bytes32 feedId_) KursAggregatorV3(oracle_, feedId_) {}

    function latestAnswer() external view returns (int256) {
        return oracle.getRound(feedId, oracle.latestRoundId(feedId)).answer;
    }

    function latestTimestamp() external view returns (uint256) {
        return oracle.getRound(feedId, oracle.latestRoundId(feedId)).updatedAt;
    }

    function latestRound() external view returns (uint256) {
        return oracle.latestRoundId(feedId);
    }

    /// 0 when the round is unknown or has left the 64-round history
    function getAnswer(uint256 roundId) external view returns (int256) {
        if (roundId > type(uint80).max) return 0;
        return oracle.getRound(feedId, uint80(roundId)).answer;
    }

    function getTimestamp(uint256 roundId) external view returns (uint256) {
        if (roundId > type(uint80).max) return 0;
        return oracle.getRound(feedId, uint80(roundId)).updatedAt;
    }
}
