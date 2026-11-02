// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KursOracle} from "../src/KursOracle.sol";
import {KursAggregatorV3} from "../src/KursAggregatorV3.sol";

contract KursOracleTest is Test {
    KursOracle oracle;
    uint256[] keys;
    address[] reps;
    bytes32 constant ETH = keccak256("ETH/USD");

    function setUp() public {
        vm.warp(1_800_000_000);
        for (uint256 i = 1; i <= 5; ++i) {
            keys.push(0xA11CE + i);
            reps.push(vm.addr(0xA11CE + i));
        }
        oracle = new KursOracle(reps, 3);
        oracle.setFeed(ETH, "ETH / USD", 8, 3600, 200, 1e8, 1_000_000e8); // 2% spread
    }

    function _obs(uint256 key, uint80 round, int192 answer, uint64 at)
        internal
        view
        returns (KursOracle.Observation memory o)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, oracle.observationDigest(ETH, round, answer, at));
        o = KursOracle.Observation(answer, at, v, r, s);
    }

    function _bundle(uint80 round, int192[] memory answers) internal view returns (KursOracle.Observation[] memory b) {
        b = new KursOracle.Observation[](answers.length);
        for (uint256 i; i < answers.length; ++i) {
            b[i] = _obs(keys[i], round, answers[i], uint64(block.timestamp - 10));
        }
    }

    function _a(int192 a, int192 b, int192 c) internal pure returns (int192[] memory r) {
        r = new int192[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function test_medianOfThree() public {
        oracle.transmit(ETH, 1, _bundle(1, _a(3001e8, 2999e8, 3000e8)));
        (uint80 id, int192 ans,, uint64 updatedAt) = oracle.latestRound(ETH);
        assertEq(id, 1);
        assertEq(ans, 3000e8);
        assertEq(updatedAt, block.timestamp);
    }

    function test_medianOfFourAverages() public {
        int192[] memory a = new int192[](4);
        (a[0], a[1], a[2], a[3]) = (3000e8, 3004e8, 3002e8, 3006e8);
        oracle.transmit(ETH, 1, _bundle(1, a));
        (, int192 ans,,) = oracle.latestRound(ETH);
        assertEq(ans, 3003e8);
    }

    function test_revert_belowQuorum() public {
        int192[] memory a = new int192[](2);
        (a[0], a[1]) = (3000e8, 3000e8);
        KursOracle.Observation[] memory b = _bundle(1, a);
        vm.expectRevert(abi.encodeWithSelector(KursOracle.NotEnoughObservations.selector, 2, 3));
        oracle.transmit(ETH, 1, b);
    }

    function test_revert_duplicateReporter() public {
        KursOracle.Observation[] memory b = new KursOracle.Observation[](3);
        b[0] = _obs(keys[0], 1, 3000e8, uint64(block.timestamp));
        b[1] = _obs(keys[0], 1, 3000e8, uint64(block.timestamp));
        b[2] = _obs(keys[1], 1, 3000e8, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(KursOracle.DuplicateReporter.selector, reps[0]));
        oracle.transmit(ETH, 1, b);
    }

    function test_revert_outsider() public {
        KursOracle.Observation[] memory b = _bundle(1, _a(3000e8, 3000e8, 3000e8));
        b[2] = _obs(0xBAD, 1, 3000e8, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(KursOracle.UnknownReporter.selector, vm.addr(0xBAD)));
        oracle.transmit(ETH, 1, b);
    }

    function test_revert_tamperedAnswer() public {
        KursOracle.Observation[] memory b = _bundle(1, _a(3000e8, 3000e8, 3000e8));
        b[0].answer = 9000e8; // signature no longer matches -> recovers a random address
        vm.expectPartialRevert(KursOracle.UnknownReporter.selector);
        oracle.transmit(ETH, 1, b);
    }

    function test_revert_replaySameRound() public {
        KursOracle.Observation[] memory b = _bundle(1, _a(3000e8, 3000e8, 3000e8));
        oracle.transmit(ETH, 1, b);
        vm.expectRevert(abi.encodeWithSelector(KursOracle.StaleRound.selector, 1, 1));
        oracle.transmit(ETH, 1, b);
    }

    function test_revert_disagreement() public {
        // one honest-looking outlier pushes spread over 2%
        KursOracle.Observation[] memory b = _bundle(1, _a(3000e8, 3000e8, 3200e8));
        vm.expectRevert(
            abi.encodeWithSelector(
                KursOracle.ReportersDisagree.selector, int192(3000e8), int192(3200e8), int192(3000e8)
            )
        );
        oracle.transmit(ETH, 1, b);
    }

    function test_minorityCannotMoveMedian() public {
        // widen spread so the test isolates the median property
        oracle.setFeed(ETH, "ETH / USD", 8, 3600, 10_000, 1, type(int192).max);
        int192[] memory a = new int192[](5);
        (a[0], a[1], a[2], a[3], a[4]) = (3000e8, 3001e8, 2999e8, 4400e8, 4400e8); // 2 of 5 lie
        oracle.transmit(ETH, 1, _bundle(1, a));
        (, int192 ans,,) = oracle.latestRound(ETH);
        assertEq(ans, 3001e8);
    }

    function test_revert_stale() public {
        KursOracle.Observation[] memory b = new KursOracle.Observation[](3);
        uint64 old = uint64(block.timestamp - 2 hours);
        for (uint256 i; i < 3; ++i) {
            b[i] = _obs(keys[i], 1, 3000e8, old);
        }
        vm.expectRevert(abi.encodeWithSelector(KursOracle.ObservationTooOld.selector, 0, old));
        oracle.transmit(ETH, 1, b);
    }

    function test_revert_future() public {
        KursOracle.Observation[] memory b = new KursOracle.Observation[](3);
        uint64 fut = uint64(block.timestamp + 1 hours);
        for (uint256 i; i < 3; ++i) {
            b[i] = _obs(keys[i], 1, 3000e8, fut);
        }
        vm.expectRevert(abi.encodeWithSelector(KursOracle.ObservationInFuture.selector, 0, fut));
        oracle.transmit(ETH, 1, b);
    }

    function test_revert_outOfBounds() public {
        oracle.setFeed(ETH, "ETH / USD", 8, 3600, 200, 1e8, 2000e8);
        KursOracle.Observation[] memory b = _bundle(1, _a(3000e8, 3000e8, 3000e8));
        vm.expectRevert(abi.encodeWithSelector(KursOracle.AnswerOutOfBounds.selector, int192(3000e8)));
        oracle.transmit(ETH, 1, b);
    }

    function test_revert_highS() public {
        KursOracle.Observation[] memory b = _bundle(1, _a(3000e8, 3000e8, 3000e8));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        b[0].s = bytes32(n - uint256(b[0].s));
        b[0].v = b[0].v == 27 ? 28 : 27;
        vm.expectRevert(abi.encodeWithSelector(KursOracle.BadSignature.selector, 0));
        oracle.transmit(ETH, 1, b);
    }

    function test_sameBundleVerifiesOnAnotherChain() public {
        KursOracle.Observation[] memory b = _bundle(7, _a(3000e8, 3001e8, 2999e8));
        oracle.transmit(ETH, 7, b);

        vm.chainId(11155111); // Sepolia
        KursOracle mirror = new KursOracle(reps, 3);
        mirror.setFeed(ETH, "ETH / USD", 8, 3600, 200, 1e8, 1_000_000e8);
        mirror.transmit(ETH, 7, b);

        (, int192 a1,,) = oracle.latestRound(ETH);
        (, int192 a2,,) = mirror.latestRound(ETH);
        assertEq(a1, a2);
    }

    function test_quorumMustBeMajority() public {
        vm.expectRevert(KursOracle.BadConfig.selector);
        oracle.setReporters(reps, 2); // 2 of 5 is not a majority
    }

    function test_rotateReporters() public {
        address[] memory next = new address[](3);
        for (uint256 i; i < 3; ++i) {
            next[i] = reps[i + 2];
        }
        oracle.setReporters(next, 2);
        assertEq(oracle.reporterSlot(reps[0]), 0);
        assertEq(oracle.reporterSlot(reps[2]), 1);
        assertEq(oracle.configVersion(), 2);
    }

    function test_onlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(KursOracle.NotOwner.selector);
        oracle.setReporters(reps, 3);
    }

    function test_ownershipTwoStep() public {
        oracle.transferOwnership(address(0xBEEF));
        assertEq(oracle.owner(), address(this));
        vm.prank(address(0xBEEF));
        oracle.acceptOwnership();
        assertEq(oracle.owner(), address(0xBEEF));
    }

    function test_aggregatorV3Adapter() public {
        KursAggregatorV3 agg = new KursAggregatorV3(oracle, ETH);
        oracle.transmit(ETH, 3, _bundle(3, _a(3000e8, 3000e8, 3000e8)));
        (uint80 id, int256 ans, uint256 startedAt, uint256 updatedAt, uint80 inRound) = agg.latestRoundData();
        assertEq(id, 3);
        assertEq(ans, 3000e8);
        assertEq(startedAt, block.timestamp - 10);
        assertEq(updatedAt, block.timestamp);
        assertEq(inRound, 3);
        assertEq(agg.decimals(), 8);
        assertEq(agg.description(), "ETH / USD");
        vm.expectRevert(KursAggregatorV3.NoData.selector);
        agg.getRoundData(2);
    }

    function testFuzz_medianWithinRange(int64 x, int64 y, int64 z) public {
        oracle.setFeed(ETH, "ETH / USD", 8, 3600, 10_000, type(int192).min, type(int192).max);
        vm.assume(x != 0 && y != 0 && z != 0);
        int192[] memory a = _a(int192(x), int192(y), int192(z));
        // skip bundles the spread rule would reject; this test is about the median
        int192 lo = a[0] < a[1] ? (a[0] < a[2] ? a[0] : a[2]) : (a[1] < a[2] ? a[1] : a[2]);
        int192 hi = a[0] > a[1] ? (a[0] > a[2] ? a[0] : a[2]) : (a[1] > a[2] ? a[1] : a[2]);
        int192 mid = int192(x) + int192(y) + int192(z) - lo - hi;
        int256 absMid = mid < 0 ? -int256(mid) : int256(mid);
        vm.assume((int256(hi) - int256(lo)) <= absMid);
        oracle.transmit(ETH, 1, _bundle(1, a));
        (, int192 ans,,) = oracle.latestRound(ETH);
        assertEq(ans, mid);
    }
}
