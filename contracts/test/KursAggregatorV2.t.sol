// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KursOracle} from "../src/KursOracle.sol";
import {KursAggregatorV2V3} from "../src/KursAggregatorV2V3.sol";

/// Chainlink V2 functions (as called by Aave V3's AaveOracle) over real signed rounds.
contract KursAggregatorV2Test is Test {
    KursOracle oracle;
    KursAggregatorV2V3 agg;
    uint256[] keys;
    bytes32 constant F = keccak256("USD/IDR");

    function setUp() public {
        vm.warp(1_800_000_000);
        address[] memory reps = new address[](3);
        for (uint256 i; i < 3; ++i) {
            keys.push(0xD00D + i);
            reps[i] = vm.addr(0xD00D + i);
        }
        oracle = new KursOracle(reps, 2);
        oracle.setFeed(F, "USD / IDR", 8, 3600, 100, 1_000e8, 100_000e8);
        agg = new KursAggregatorV2V3(oracle, F);
    }

    function _push(uint80 round, int192 price) internal {
        vm.warp(block.timestamp + 60);
        uint64 at = uint64(block.timestamp - 5);
        KursOracle.Observation[] memory obs = new KursOracle.Observation[](3);
        for (uint256 i; i < 3; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], oracle.observationDigest(F, round, price, at));
            obs[i] = KursOracle.Observation(price, at, v, r, s);
        }
        oracle.transmit(F, round, obs);
    }

    function test_noDataReturnsZeroLikeChainlink() public view {
        assertEq(agg.latestAnswer(), 0);
        assertEq(agg.latestTimestamp(), 0);
        assertEq(agg.latestRound(), 0);
    }

    function test_v2MatchesV3() public {
        _push(7, 18_144.9e8);
        (uint80 id, int256 ans,, uint256 updatedAt,) = agg.latestRoundData();
        assertEq(agg.latestAnswer(), ans);
        assertEq(agg.latestAnswer(), 18_144.9e8);
        assertEq(agg.latestTimestamp(), updatedAt);
        assertEq(agg.latestRound(), id);
        assertEq(agg.getAnswer(7), ans);
        assertEq(agg.getTimestamp(7), updatedAt);
    }

    function test_historyAndEviction() public {
        _push(1, 18_000e8);
        _push(2, 18_100e8);
        assertEq(agg.getAnswer(1), 18_000e8);
        assertEq(agg.getAnswer(2), 18_100e8);
        assertEq(agg.getAnswer(3), 0); // not yet
        // 64-round ring buffer: round 66 reuses round 2's slot
        _push(66, 18_200e8);
        assertEq(agg.getAnswer(2), 0);
        assertEq(agg.getTimestamp(2), 0);
        assertEq(agg.getAnswer(66), 18_200e8);
        assertEq(agg.getAnswer(1), 18_000e8); // slot 1 untouched
    }

    function test_hugeRoundIdIsZero() public {
        _push(1, 18_000e8);
        assertEq(agg.getAnswer(uint256(type(uint80).max) + 1), 0);
        assertEq(agg.getTimestamp(type(uint256).max), 0);
    }

    function test_v3StillWorks() public {
        _push(3, 18_150e8);
        assertEq(agg.decimals(), 8);
        assertEq(agg.description(), "USD / IDR");
    }
}
