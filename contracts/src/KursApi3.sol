// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// API3's IApi3ReaderProxy for one Kurs feed: read() -> (int224 value, uint32 timestamp).
/// value has 18 decimals (API3's convention); timestamp = oldest observation in the round.
/// Reverts when the feed has no round, like an uninitialised dAPI. No staleness check:
/// API3 consumers compare timestamp themselves.
contract KursApi3ReaderProxy {
    KursOracle public immutable oracle;
    bytes32 public immutable feedId;

    error NoData();
    error Overflow();

    constructor(KursOracle oracle_, bytes32 feedId_) {
        oracle = oracle_;
        feedId = feedId_;
    }

    function read() external view returns (int224 value, uint32 timestamp) {
        (uint80 roundId, int192 answer, uint64 observedAt,) = oracle.latestRound(feedId);
        if (roundId == 0) revert NoData();
        int256 v = int256(answer) * int256(10 ** (18 - oracle.feed(feedId).decimals));
        if (v > type(int224).max || v < type(int224).min) revert Overflow(); // cast would truncate
        value = int224(v);
        timestamp = uint32(observedAt);
    }
}
