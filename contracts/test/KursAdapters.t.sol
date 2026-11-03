// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KursOracle} from "../src/KursOracle.sol";
import {KursQuoteOracle} from "../src/KursQuoteOracle.sol";
import {KursPyth, PythStructs} from "../src/KursPyth.sol";
import {KursMorphoOracle, IERC7726} from "../src/KursMorphoOracle.sol";

/// Pyth IPyth and Morpho Blue IOracle views over real signed Kurs rounds.
contract KursAdaptersTest is Test {
    KursOracle oracle;
    KursQuoteOracle q;
    KursPyth pyth;
    uint256[] keys;

    address constant BTC = 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB;
    address constant USD = address(840);
    address constant IDR = address(360);
    bytes32 constant F_BTC = keccak256("BTC/USD");
    bytes32 constant F_IDR = keccak256("USD/IDR");

    function setUp() public {
        vm.warp(1_800_000_000);
        address[] memory reps = new address[](3);
        for (uint256 i; i < 3; ++i) {
            keys.push(0xBEEF + i);
            reps[i] = vm.addr(0xBEEF + i);
        }
        oracle = new KursOracle(reps, 2);
        oracle.setFeed(F_BTC, "BTC / USD", 8, 3600, 100, 1e8, 10_000_000e8);
        oracle.setFeed(F_IDR, "USD / IDR", 8, 3600, 100, 1_000e8, 100_000e8);
        pyth = new KursPyth(oracle, 120);

        address[] memory b = new address[](2);
        address[] memory qt = new address[](2);
        bytes32[] memory f = new bytes32[](2);
        uint8[] memory bd = new uint8[](2);
        uint8[] memory qd = new uint8[](2);
        (b[0], qt[0], f[0], bd[0], qd[0]) = (BTC, USD, F_BTC, 8, 18);
        (b[1], qt[1], f[1], bd[1], qd[1]) = (USD, IDR, F_IDR, 18, 18);
        q = new KursQuoteOracle(oracle, 300, b, qt, f, bd, qd);
    }

    function _bundle(bytes32 feed, int192 price) internal view returns (bytes memory) {
        (uint80 latest,,,) = oracle.latestRound(feed);
        uint64 at = uint64(block.timestamp - 5);
        KursOracle.Observation[] memory obs = new KursOracle.Observation[](3);
        for (uint256 i; i < 3; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], oracle.observationDigest(feed, latest + 1, price, at));
            obs[i] = KursOracle.Observation(price, at, v, r, s);
        }
        return abi.encode(feed, latest + 1, obs);
    }

    function _push(bytes32 feed, int192 price) internal {
        oracle.fulfillOracleQuery(_bundle(feed, price));
    }

    // ------------------------------------------------------------------ Pyth

    function test_pythPrice() public {
        _push(F_BTC, 76_000e8);
        PythStructs.Price memory p = pyth.getPriceUnsafe(F_BTC);
        assertEq(p.price, 76_000e8);
        assertEq(p.expo, -8);
        assertEq(p.conf, 760e8); // 1% spread bound
        assertEq(p.publishTime, block.timestamp - 5);
        assertTrue(pyth.priceFeedExists(F_BTC));
        assertFalse(pyth.priceFeedExists(keccak256("XXX/USD")));
    }

    function test_pythUnknownAndEmptyRevertLikePyth() public {
        vm.expectRevert(KursPyth.PriceFeedNotFound.selector);
        pyth.getPriceUnsafe(keccak256("XXX/USD"));
        vm.expectRevert(KursPyth.PriceFeedNotFound.selector); // feed set, no round yet
        pyth.getPriceUnsafe(F_BTC);
    }

    function test_pythStaleness() public {
        _push(F_BTC, 76_000e8);
        pyth.getPrice(F_BTC); // 5 s old, valid period 120 s
        vm.warp(block.timestamp + 200);
        vm.expectRevert(KursPyth.StalePrice.selector);
        pyth.getPrice(F_BTC);
        vm.expectRevert(KursPyth.StalePrice.selector);
        pyth.getPriceNoOlderThan(F_BTC, 60);
        assertEq(pyth.getPriceNoOlderThan(F_BTC, 300).price, 76_000e8);
    }

    /// Pyth's pull flow: fee, then updatePriceFeeds with signed bundles, then read.
    function test_pythUpdatePriceFeeds() public {
        bytes[] memory upd = new bytes[](2);
        upd[0] = _bundle(F_BTC, 77_000e8);
        upd[1] = _bundle(F_IDR, 18_100e8);
        assertEq(pyth.getUpdateFee(upd), 0);
        pyth.updatePriceFeeds(upd);
        assertEq(pyth.getPrice(F_BTC).price, 77_000e8);
        assertEq(pyth.getPrice(F_IDR).price, 18_100e8);
        pyth.updatePriceFeeds(upd); // same rounds again: idempotent, no revert
    }

    function test_pythRejectsForgedUpdate() public {
        bytes[] memory upd = new bytes[](1);
        upd[0] = _bundle(F_BTC, 77_000e8);
        (bytes32 f, uint80 r, KursOracle.Observation[] memory obs) =
            abi.decode(upd[0], (bytes32, uint80, KursOracle.Observation[]));
        obs[0].answer = 99_000e8; // signature no longer matches
        upd[0] = abi.encode(f, r, obs);
        vm.expectRevert();
        pyth.updatePriceFeeds(upd);
    }

    function test_pythRejectsValue() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(KursPyth.FeeNotAccepted.selector);
        pyth.updatePriceFeeds{value: 1}(new bytes[](0));
    }

    // ---------------------------------------------------------------- Morpho

    function test_morphoPriceBtcInIdrToken() public {
        _push(F_BTC, 76_000e8);
        _push(F_IDR, 18_144.9e8);
        // collateral: an 8-decimal BTC token; loan: a 2-decimal Rupiah token (IDRX-style)
        KursMorphoOracle m = new KursMorphoOracle(IERC7726(address(q)), BTC, 8, 8, IDR, 18, 2);
        uint256 price = m.price();
        // Morpho: loan units = collateral units * price / 1e36. 1 BTC (1e8) -> Rp 1,379,012,400 (x 1e2)
        assertEq(price * 1e8 / 1e36, 1_379_012_400e2);
        assertEq(price, uint256(1_379_012_400e2) * 1e36 / 1e8);
    }

    function test_morphoSameDecimalsMatchesQuote() public {
        _push(F_BTC, 76_000e8);
        KursMorphoOracle m = new KursMorphoOracle(IERC7726(address(q)), BTC, 8, 8, USD, 18, 18);
        assertEq(m.price() * 1e8 / 1e36, q.getQuote(1e8, BTC, USD));
    }

    function test_morphoStaleRevertsErc7412() public {
        _push(F_BTC, 76_000e8);
        _push(F_IDR, 18_144.9e8);
        KursMorphoOracle m = new KursMorphoOracle(IERC7726(address(q)), BTC, 8, 8, IDR, 18, 2);
        vm.warp(block.timestamp + 400);
        vm.expectRevert(); // OracleDataRequired from latestRoundFresh
        m.price();
    }

    function testFuzz_morphoScales(uint64 btc, uint8 collDec, uint8 loanDec) public {
        collDec = uint8(bound(collDec, 0, 24));
        loanDec = uint8(bound(loanDec, 0, 24));
        int192 px = int192(int256(bound(btc, 1e8, 1_000_000e8)));
        _push(F_BTC, px);
        KursMorphoOracle m = new KursMorphoOracle(IERC7726(address(q)), BTC, 8, collDec, USD, 18, loanDec);
        // 1 whole collateral token in whole loan tokens = the USD price, within rounding
        uint256 loanUnits = (m.price() * 10 ** collDec) / 1e36;
        uint256 expected = uint256(int256(px)) * 10 ** loanDec / 1e8;
        assertApproxEqAbs(loanUnits, expected, 1);
    }
}
