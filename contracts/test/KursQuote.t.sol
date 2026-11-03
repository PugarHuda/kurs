// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KursOracle} from "../src/KursOracle.sol";
import {KursQuoteOracle} from "../src/KursQuoteOracle.sol";

/// ERC-7726 getQuote over real signed Kurs rounds.
contract KursQuoteTest is Test {
    KursOracle oracle;
    KursQuoteOracle q;
    uint256[] keys;

    address constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address constant BTC = 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB;
    address constant USD = address(840);
    address constant IDR = address(360);
    bytes32 constant F_BTC = keccak256("BTC/USD");
    bytes32 constant F_ETH = keccak256("ETH/USD");
    bytes32 constant F_IDR = keccak256("USD/IDR");

    function setUp() public {
        vm.warp(1_800_000_000);
        address[] memory reps = new address[](3);
        for (uint256 i; i < 3; ++i) {
            keys.push(0xC0DE + i);
            reps[i] = vm.addr(0xC0DE + i);
        }
        oracle = new KursOracle(reps, 2);
        oracle.setFeed(F_BTC, "BTC / USD", 8, 3600, 100, 1e8, 10_000_000e8);
        oracle.setFeed(F_ETH, "ETH / USD", 8, 3600, 100, 1e8, 1_000_000e8);
        oracle.setFeed(F_IDR, "USD / IDR", 8, 3600, 100, 1_000e8, 100_000e8);
        _push(F_BTC, 76_000e8);
        _push(F_ETH, 2_250e8);
        _push(F_IDR, 18_144.9e8);

        address[] memory b = new address[](3);
        address[] memory qt = new address[](3);
        bytes32[] memory f = new bytes32[](3);
        uint8[] memory bd = new uint8[](3);
        uint8[] memory qd = new uint8[](3);
        (b[0], qt[0], f[0], bd[0], qd[0]) = (BTC, USD, F_BTC, 8, 18);
        (b[1], qt[1], f[1], bd[1], qd[1]) = (ETH, USD, F_ETH, 18, 18);
        (b[2], qt[2], f[2], bd[2], qd[2]) = (USD, IDR, F_IDR, 18, 18);
        q = new KursQuoteOracle(oracle, 300, b, qt, f, bd, qd);
    }

    function _push(bytes32 feed, int192 price) internal {
        (uint80 latest,,,) = oracle.latestRound(feed);
        uint80 round = latest + 1;
        uint64 at = uint64(block.timestamp - 5);
        KursOracle.Observation[] memory obs = new KursOracle.Observation[](3);
        for (uint256 i; i < 3; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], oracle.observationDigest(feed, round, price, at));
            obs[i] = KursOracle.Observation(price, at, v, r, s);
        }
        oracle.transmit(feed, round, obs);
    }

    function test_direct() public view {
        assertEq(q.getQuote(1e8, BTC, USD), 76_000e18); // 1 BTC in USD
        assertEq(q.getQuote(2e18, ETH, USD), 4_500e18);
        assertEq(q.getQuote(1e18, USD, IDR), 18_144.9e18); // $1 in Rupiah
    }

    function test_inverse() public view {
        assertEq(q.getQuote(76_000e18, USD, BTC), 1e8);
        assertEq(q.getQuote(18_144.9e18, IDR, USD), 1e18);
    }

    function test_pivotThroughUsd() public view {
        // 1 BTC in Rupiah = 76,000 * 18,144.9
        assertEq(q.getQuote(1e8, BTC, IDR), 1_379_012_400e18);
        // Rp 1,000,000 in ETH: 1e6 / 18,144.9 / 2,250, rounded down
        assertEq(q.getQuote(1_000_000e18, IDR, ETH), uint256(1_000_000e18) * 1e8 / 18_144.9e8 * 1e8 / 2_250e8);
        // BTC -> ETH
        assertEq(q.getQuote(1e8, BTC, ETH), uint256(76_000e18) * 1e8 / 2_250e8);
    }

    function test_sameAsset() public view {
        assertEq(q.getQuote(123, IDR, IDR), 123);
    }

    function test_unsupportedPairReverts() public {
        address dot = address(0xD07);
        vm.expectRevert(abi.encodeWithSelector(KursQuoteOracle.OracleUnsupportedPair.selector, dot, USD));
        q.getQuote(1e18, dot, USD);
    }

    function test_stalePriceRequiresPull() public {
        vm.warp(block.timestamp + 301);
        vm.expectRevert(abi.encodeWithSelector(KursOracle.OracleDataRequired.selector, address(oracle), abi.encode(F_BTC, uint32(300))));
        q.getQuote(1e8, BTC, USD);
    }

    /// Round trip never creates value: USD -> BTC -> USD returns at most what went in.
    function testFuzz_roundTripRoundsDown(uint96 usd) public view {
        uint256 back = q.getQuote(q.getQuote(usd, USD, BTC), BTC, USD);
        assertLe(back, usd);
        // and loses less than one satoshi's worth (76,000e18 / 1e8 = 760e12)
        assertLt(usd - back, 760e12 + 1);
    }
}
