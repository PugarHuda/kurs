// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// Chronicle's IChronicle (Sky/MakerDAO's oracle) for one Kurs feed.
/// val: 18 decimals, unsigned; age: oldest observation in the round.
/// read*/readWithAge revert when there is no positive value, try* return ok = false,
/// as Chronicle does. Chronicle's toll (reader whitelist) is not reproduced: reads are open.
contract KursChronicle {
    KursOracle public immutable oracle;
    bytes32 public immutable feedId;
    /// Chronicle's oracle id, e.g. "BTC/USD"
    bytes32 public immutable wat;

    error NoValue();

    constructor(KursOracle oracle_, string memory pair) {
        oracle = oracle_;
        feedId = keccak256(bytes(pair));
        wat = bytes32(bytes(pair));
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function tryReadWithAge() public view returns (bool ok, uint256 val, uint256 age) {
        (uint80 roundId, int192 answer, uint64 observedAt,) = oracle.latestRound(feedId);
        if (roundId == 0 || answer <= 0) return (false, 0, 0);
        uint8 d = oracle.feed(feedId).decimals;
        return (true, uint256(int256(answer)) * 10 ** (18 - d), observedAt);
    }

    function tryRead() external view returns (bool ok, uint256 val) {
        (ok, val,) = tryReadWithAge();
    }

    function readWithAge() public view returns (uint256 val, uint256 age) {
        bool ok;
        (ok, val, age) = tryReadWithAge();
        if (!ok) revert NoValue();
    }

    function read() external view returns (uint256 val) {
        (val,) = readWithAge();
    }
}
