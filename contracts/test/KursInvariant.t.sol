// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KursOracle} from "../src/KursOracle.sol";

/// Drives KursOracle with random, partly hostile bundles and records what an
/// honest observer expects. Invariants are checked after every call.
contract KursHandler is Test {
    KursOracle public oracle;
    bytes32 public constant FEED = keccak256("ETH/USD");
    uint256[] keys; // 0..4 reporters, 5..6 outsiders

    // ghosts: what the last accepted round must look like
    uint80 public lastRound;
    int192 public lastMedian;
    int192 public lastLow;
    int192 public lastHigh;
    uint256 public accepted;
    uint256 public rejected;

    constructor(KursOracle o, uint256[] memory k) {
        oracle = o;
        keys = k;
    }

    /// One transmit attempt. Seeds pick the round step, prices, signers and timing.
    function transmit(uint8 roundStep, uint64 base, uint16[5] calldata jitterBps, uint8 n, uint8 signerSeed, uint16 ageSeed)
        external
    {
        vm.warp(block.timestamp + 30);
        n = uint8(bound(n, 1, 6));
        uint80 roundId = uint80(uint256(lastRound) + bound(roundStep, 0, 3)); // 0 = replay of the latest round
        int192 basePrice = int192(int256(bound(base, 1e8, 900_000e8)));

        KursOracle.Observation[] memory obs = new KursOracle.Observation[](n);
        int192[] memory answers = new int192[](n);
        for (uint256 i; i < n; ++i) {
            // mostly reporters 0..4 in order; sometimes an outsider or a duplicate
            uint256 who = (signerSeed % 7 == 0 && i == n - 1) ? 5 : (signerSeed % 11 == 0 && i == 1 ? 0 : i % 5);
            int256 jitter = int256(uint256(jitterBps[i % 5] % 600)) - 300; // -3%..+3%
            answers[i] = int192(int256(basePrice) + (int256(basePrice) * jitter) / 10_000);
            obs[i] = _sign(who, roundId, answers[i], uint64(block.timestamp - bound(ageSeed, 0, 400))); // limit is 300s
        }

        try oracle.transmit(FEED, roundId, obs) {
            accepted++;
            lastRound = roundId;
            (lastLow, lastHigh) = _minMax(answers);
            (, lastMedian,,) = oracle.latestRound(FEED);
        } catch {
            rejected++;
        }
    }

    function _sign(uint256 who, uint80 roundId, int192 answer, uint64 at)
        internal
        view
        returns (KursOracle.Observation memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[who], oracle.observationDigest(FEED, roundId, answer, at));
        return KursOracle.Observation(answer, at, v, r, s);
    }

    function _minMax(int192[] memory a) internal pure returns (int192 lo, int192 hi) {
        lo = a[0];
        hi = a[0];
        for (uint256 i = 1; i < a.length; ++i) {
            if (a[i] < lo) lo = a[i];
            if (a[i] > hi) hi = a[i];
        }
    }
}

contract KursInvariantTest is Test {
    KursOracle oracle;
    KursHandler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        uint256[] memory keys = new uint256[](7);
        address[] memory reps = new address[](5);
        for (uint256 i; i < 7; ++i) {
            keys[i] = 0xB0B + i;
            if (i < 5) reps[i] = vm.addr(keys[i]);
        }
        oracle = new KursOracle(reps, 3);
        oracle.setFeed(keccak256("ETH/USD"), "ETH / USD", 8, 3600, 200, 1e8, 1_000_000e8); // 2% spread
        oracle.setMaxObservationAge(300);
        handler = new KursHandler(oracle, keys);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = KursHandler.transmit.selector;
        targetSelector(FuzzSelector(address(handler), sel));
    }

    /// The stored round is exactly the last one the handler saw accepted: rejected
    /// bundles never change state, and round ids never go backwards.
    function invariant_latestIsLastAccepted() public view {
        (uint80 id,,,) = oracle.latestRound(handler.FEED());
        assertEq(id, handler.lastRound());
    }

    /// The median lies inside the signed observations of its round.
    function invariant_medianWithinObservations() public view {
        if (handler.accepted() == 0) return;
        (, int192 ans,,) = oracle.latestRound(handler.FEED());
        assertGe(ans, handler.lastLow());
        assertLe(ans, handler.lastHigh());
    }

    /// Reporters that agree within 2% are the only way in: the accepted spread is bounded.
    function invariant_acceptedSpreadBounded() public view {
        if (handler.accepted() == 0) return;
        int192 lo = handler.lastLow();
        int192 hi = handler.lastHigh();
        // spread check is relative to the median: (hi - lo) <= 2% of median (+1 for rounding)
        assertLe(int256(hi - lo) * 10_000, int256(handler.lastMedian()) * 200); // same rule as the contract
    }

    /// The answer always respects the feed's configured bounds.
    function invariant_answerInBounds() public view {
        if (handler.accepted() == 0) return;
        (, int192 ans,,) = oracle.latestRound(handler.FEED());
        assertGe(ans, 1e8);
        assertLe(ans, 1_000_000e8);
    }

    /// The ring buffer returns the latest round by id.
    function invariant_ringBufferConsistent() public view {
        if (handler.accepted() == 0) return;
        KursOracle.Round memory r = oracle.getRound(handler.FEED(), handler.lastRound());
        assertEq(r.roundId, handler.lastRound());
        assertEq(r.answer, handler.lastMedian());
    }

    /// The handler must exercise both paths, otherwise the invariants prove nothing.
    function afterInvariant() public view {
        assertGt(handler.accepted(), 0, "no bundle was ever accepted");
        assertGt(handler.rejected(), 0, "no bundle was ever rejected");
    }
}
