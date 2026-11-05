// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KursOracle} from "../src/KursOracle.sol";
import {KursQuoteOracle} from "../src/KursQuoteOracle.sol";
import {KursPyth, PythStructs} from "../src/KursPyth.sol";
import {KursMorphoOracle, IERC7726} from "../src/KursMorphoOracle.sol";
import {KursDIA} from "../src/KursDIA.sol";
import {KursBand} from "../src/KursBand.sol";
import {KursApi3ReaderProxy} from "../src/KursApi3.sol";
import {KursChronicle} from "../src/KursChronicle.sol";
import {KursAaveOracle} from "../src/KursAaveOracle.sol";
import {KursPortixOracle} from "../src/KursPortixOracle.sol";
import {KursSiloOracle, IQuote} from "../src/KursSiloOracle.sol";
import {KursTwap} from "../src/KursTwap.sol";
import {KursTwapKeeper} from "../src/KursTwapKeeper.sol";
import {KursFeedRegistry} from "../src/KursFeedRegistry.sol";
import {KursAggregatorFactory} from "../src/KursAggregatorV3.sol";

/// Pyth, Morpho, DIA, Band, API3, Chronicle and Aave views over real signed Kurs rounds.
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
    // ------------------------------------------------------------------- DIA

    function test_diaGetValue() public {
        KursDIA dia = new KursDIA(oracle);
        (uint128 v, uint128 t) = dia.getValue("BTC/USD");
        assertEq(v, 0); // feed set, no round: (0, 0) like DIA
        assertEq(t, 0);
        _push(F_BTC, 76_000.5e8);
        (v, t) = dia.getValue("BTC/USD");
        assertEq(v, 76_000.5e8);
        assertEq(t, block.timestamp - 5);
        (v, t) = dia.getValue("XXX/USD");
        assertEq(v + t, 0);
    }

    // ------------------------------------------------------------------ Band

    function test_bandCrossRateViaUsd() public {
        KursBand band = new KursBand(oracle);
        _push(F_BTC, 76_000e8);
        _push(F_IDR, 18_144.9e8);
        KursBand.ReferenceData memory r = band.getReferenceData("BTC", "IDR");
        assertApproxEqRel(r.rate, 1_379_012_400e18, 1e6); // 76,000 * 18,144.9, rounding of 1/IDR
        assertEq(r.lastUpdatedBase, block.timestamp - 5);
        assertEq(r.lastUpdatedQuote, block.timestamp - 5);
        assertEq(band.getReferenceData("BTC", "USD").rate, 76_000e18);
        assertEq(band.getReferenceData("USD", "USD").rate, 1e18);
        string[] memory b = new string[](2);
        string[] memory q2 = new string[](2);
        (b[0], q2[0], b[1], q2[1]) = ("BTC", "USD", "USD", "IDR");
        KursBand.ReferenceData[] memory bulk = band.getReferenceDataBulk(b, q2);
        assertEq(bulk[0].rate, 76_000e18);
        assertApproxEqRel(bulk[1].rate, 18_144.9e18, 1e6);
    }

    function test_bandUnknownReverts() public {
        KursBand band = new KursBand(oracle);
        vm.expectRevert(abi.encodeWithSelector(KursBand.RefDataNotAvailable.selector, "XXX"));
        band.getReferenceData("XXX", "USD");
        vm.expectRevert(abi.encodeWithSelector(KursBand.RefDataNotAvailable.selector, "BTC")); // no round yet
        band.getReferenceData("BTC", "USD");
    }

    // ------------------------------------------------------------------ API3

    function test_api3Read() public {
        KursApi3ReaderProxy p = new KursApi3ReaderProxy(oracle, F_BTC);
        vm.expectRevert(KursApi3ReaderProxy.NoData.selector);
        p.read();
        _push(F_BTC, 76_000e8);
        (int224 v, uint32 t) = p.read();
        assertEq(v, 76_000e18);
        assertEq(t, block.timestamp - 5);
    }

    // ------------------------------------------------------------- Chronicle

    function test_chronicleRead() public {
        KursChronicle c = new KursChronicle(oracle, "BTC/USD");
        assertEq(c.wat(), bytes32("BTC/USD"));
        (bool ok,) = c.tryRead();
        assertFalse(ok);
        vm.expectRevert(KursChronicle.NoValue.selector);
        c.read();
        _push(F_BTC, 76_000e8);
        assertEq(c.read(), 76_000e18);
        (uint256 v, uint256 age) = c.readWithAge();
        assertEq(v, 76_000e18);
        assertEq(age, block.timestamp - 5);
        assertEq(c.decimals(), 18);
    }

    // ------------------------------------------------------------------ Portix (Portaldot Hacker House lending market)

    function test_portixPrices() public {
        bytes32 fTsla = keccak256("TSLA/USD");
        oracle.setFeed(fTsla, "TSLA / USD", 8, 3600, 100, 1e8, 100_000e8);
        address tsla = address(0x75A);
        address[] memory t = new address[](1);
        bytes32[] memory f = new bytes32[](1);
        (t[0], f[0]) = (tsla, fTsla);
        KursPortixOracle px = new KursPortixOracle(oracle, 3600, t, f);
        vm.expectRevert(abi.encodeWithSelector(KursPortixOracle.OraclePriceZero.selector, tsla)); // no round yet
        px.getPriceUSD(tsla);
        _push(fTsla, 341_505e5); // $341.505
        (uint256 price, uint8 dec, uint256 at) = px.getPrice(tsla);
        assertEq(price, 341_505e5);
        assertEq(dec, 8);
        assertEq(at, block.timestamp);
        assertEq(px.getPriceUSD(tsla), 341_505_000); // pUSDC scale: 1 USD = 1e6
        vm.expectRevert(abi.encodeWithSelector(KursPortixOracle.TokenNotSupported.selector, address(0xDEAD)));
        px.getPriceUSD(address(0xDEAD));
        vm.warp(block.timestamp + 3601);
        vm.expectRevert(abi.encodeWithSelector(KursPortixOracle.OraclePriceStale.selector, tsla, at, 3600));
        px.getPriceUSD(tsla);
        (price,,) = px.getPrice(tsla); // the raw read stays available, as in Portix's own oracle
        assertEq(price, 341_505e5);
    }

    // ------------------------------------------------------------------ Aave

    function test_aavePrices() public {
        address wbtc = address(0xB7C);
        address idrx = address(0x1D3);
        address[] memory a = new address[](2);
        bytes32[] memory f = new bytes32[](2);
        bool[] memory inv = new bool[](2);
        (a[0], f[0], a[1], f[1], inv[1]) = (wbtc, F_BTC, idrx, F_IDR, true);
        KursAaveOracle aave = new KursAaveOracle(oracle, 300, a, f, inv);
        _push(F_BTC, 76_000e8);
        _push(F_IDR, 20_000e8);
        assertEq(aave.getAssetPrice(wbtc), 76_000e8);
        assertEq(aave.getAssetPrice(idrx), 5_000); // 1 / 20,000 USD in 1e8 units
        assertEq(aave.getAssetPrice(address(0)), 1e8);
        assertEq(aave.getAssetsPrices(a)[0], 76_000e8);
        assertEq(aave.getSourceOfAsset(wbtc), address(aave));
        assertEq(aave.getSourceOfAsset(address(0xDEAD)), address(0));
        vm.expectRevert(abi.encodeWithSelector(KursAaveOracle.UnknownAsset.selector, address(0xDEAD)));
        aave.getAssetPrice(address(0xDEAD));
        vm.warp(block.timestamp + 400); // no timestamp in this interface: stale must revert
        vm.expectRevert();
        aave.getAssetPrice(wbtc);
    }

    // ------------------------------------------------------- Euler, Silo

    function test_eulerGetQuotesBidEqualsAsk() public {
        _push(F_BTC, 76_000e8);
        _push(F_IDR, 18_000e8);
        assertEq(q.name(), "KursQuoteOracle");
        (uint256 bid, uint256 ask) = q.getQuotes(1e8, BTC, IDR); // 1 BTC, via USD
        assertEq(bid, 76_000 * 18_000e18);
        assertEq(ask, bid);
        assertEq(bid, q.getQuote(1e8, BTC, IDR));
        vm.expectRevert(abi.encodeWithSelector(KursQuoteOracle.OracleUnsupportedPair.selector, address(1), USD));
        q.getQuotes(1, address(1), USD);
    }

    function test_siloQuote() public {
        _push(F_IDR, 18_000e8);
        KursSiloOracle silo = new KursSiloOracle(IQuote(address(q)), IDR);
        silo.beforeQuote(USD);
        assertEq(silo.quoteToken(), IDR);
        assertEq(silo.quote(100e18, USD), 1_800_000e18); // 100 USD in IDR, 18 decimals
        vm.warp(block.timestamp + 400); // stale: ERC-7412 revert from the oracle
        vm.expectRevert();
        silo.quote(1e18, USD);
    }

    // ------------------------------------------------------------------ TWAP

    function test_twapTimeWeightsRounds() public {
        KursTwap t = new KursTwap(oracle, "BTC/USD");
        vm.expectRevert(KursTwap.NoHistory.selector);
        t.consult(60);
        _push(F_BTC, 70_000e8);
        assertTrue(t.poke());
        assertFalse(t.poke()); // same round: nothing written
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 3000);
        _push(F_BTC, 80_000e8);
        vm.warp(t0 + 3600);
        assertTrue(t.poke()); // late poke: the round still counts from its updatedAt (t0+3000)
        vm.warp(t0 + 4000);
        // last 1000 s: 0..1000 ago -> 80k since t0+3000 = all 1000 s at 80k
        assertEq(t.consult(1000), 80_000e8);
        // last 4000 s: 3000 s at 70k, 1000 s at 80k
        assertEq(t.consult(4000), 72_500e8);
        uint32[] memory ago = new uint32[](2);
        (ago[0], ago[1]) = (4000, 0);
        int256[] memory c = t.observe(ago);
        assertEq((c[1] - c[0]) / 4000, 72_500e8);
        vm.expectRevert(abi.encodeWithSelector(KursTwap.WindowTooLong.selector, uint32(4001), uint64(t0)));
        t.consult(4001);
        vm.expectRevert(KursTwap.ZeroWindow.selector);
        t.consult(0);
    }

    function test_twapRingWraps() public {
        KursTwap t = new KursTwap(oracle, "BTC/USD");
        for (uint256 i; i < 60; ++i) {
            _push(F_BTC, int192(int256(70_000e8 + i * 1e8)));
            t.poke();
            vm.warp(block.timestamp + 100);
        }
        assertEq(t.count(), 60);
        // 48 kept: the oldest is round 12, written 48 * 100 s before the last + 100
        assertEq(t.oldest(), block.timestamp - 100 - 47 * 100);
        assertEq(t.consult(100), 70_059e8); // the last 100 s are all the newest price
    }

    function test_twapKeeperChainlinkAndGelato() public {
        KursTwap[] memory ts = new KursTwap[](2);
        ts[0] = new KursTwap(oracle, "BTC/USD");
        ts[1] = new KursTwap(oracle, "USD/IDR");
        KursTwapKeeper k = new KursTwapKeeper(ts);
        (bool need,) = k.checkUpkeep("");
        assertFalse(need); // no rounds yet
        _push(F_BTC, 70_000e8);
        bytes memory data;
        (need, data) = k.checkUpkeep("");
        assertTrue(need);
        assertEq(abi.decode(data, (uint256)), 1); // only BTC/USD
        (bool can, bytes memory payload) = k.checker();
        assertTrue(can);
        (bool ok,) = address(k).call(payload); // Gelato executes the payload as is
        assertTrue(ok);
        assertEq(ts[0].count(), 1);
        (need,) = k.checkUpkeep("");
        assertFalse(need);
        k.performUpkeep(abi.encode(type(uint256).max)); // replayed / forged mask: harmless
        assertEq(ts[0].count(), 1);
        assertEq(ts[1].count(), 0);
    }

    /// The average always lies between the lowest and highest price recorded in the window.
    function testFuzz_twapBounded(int64[6] memory raw, uint16[6] memory gaps, uint32 window) public {
        KursTwap t = new KursTwap(oracle, "BTC/USD");
        int192 lo = type(int192).max;
        int192 hi = type(int192).min;
        uint256 start = block.timestamp;
        for (uint256 i; i < 6; ++i) {
            int192 p = int192(int256(1_000e8 + (uint256(uint64(raw[i])) % 1_000_000e8)));
            _push(F_BTC, p);
            t.poke();
            if (p < lo) lo = p;
            if (p > hi) hi = p;
            vm.warp(block.timestamp + 1 + gaps[i]);
        }
        uint256 span = block.timestamp - start;
        window = uint32(bound(window, 1, span));
        int192 avg = t.consult(window);
        assertGe(avg, lo);
        assertLe(avg, hi);
    }

    // ----------------------------------------------- global FX: Feed Registry, ERC-7726

    address constant EUR = address(978);
    address constant JPY = address(392);
    address constant XAU = address(959);
    bytes32 constant F_EUR = keccak256("EUR/USD");
    bytes32 constant F_JPY = keccak256("USD/JPY");
    bytes32 constant F_XAU = keccak256("XAU/USD");

    function _fx() internal {
        oracle.setFeed(F_EUR, "EUR / USD", 8, 3600, 100, 0.5e8, 2e8);
        oracle.setFeed(F_JPY, "USD / JPY", 8, 3600, 100, 50e8, 500e8);
        oracle.setFeed(F_XAU, "XAU / USD", 8, 3600, 150, 500e8, 20_000e8);
        _push(F_EUR, 1.125e8);
        _push(F_JPY, 158e8);
        _push(F_XAU, 4_000e8);
    }

    function test_feedRegistryChainlinkDenominations() public {
        _fx();
        KursAggregatorFactory f = new KursAggregatorFactory(oracle);
        f.deploy(F_EUR);
        f.deploy(F_XAU);
        address[] memory b = new address[](2);
        address[] memory qt = new address[](2);
        bytes32[] memory ids = new bytes32[](2);
        (b[0], qt[0], ids[0]) = (EUR, USD, F_EUR);
        (b[1], qt[1], ids[1]) = (XAU, USD, F_XAU);
        KursFeedRegistry reg = new KursFeedRegistry(f, b, qt, ids);
        (, int256 eur,,,) = reg.latestRoundData(EUR, USD);
        assertEq(eur, 1.125e8);
        assertEq(reg.latestAnswer(XAU, USD), 4_000e8);
        assertEq(reg.decimals(EUR, USD), 8);
        assertEq(reg.description(XAU, USD), "XAU / USD");
        assertEq(address(reg.getFeed(EUR, USD)), f.aggregatorOf(F_EUR)); // the same AggregatorV3 clone
        (uint80 rid,,,,) = reg.latestRoundData(EUR, USD);
        (, int256 again,,,) = reg.getRoundData(EUR, USD, rid);
        assertEq(again, eur);
        assertEq(reg.latestRound(EUR, USD), rid);
        // Chainlink's registry serves only the feed's own direction
        vm.expectRevert(abi.encodeWithSelector(KursFeedRegistry.FeedNotFound.selector, USD, EUR));
        reg.latestRoundData(USD, EUR);
        // a pair in the table whose clone is not deployed yet is also not found
        vm.expectRevert(abi.encodeWithSelector(KursFeedRegistry.FeedNotFound.selector, JPY, USD));
        reg.latestRoundData(JPY, USD);
    }

    function test_erc7726GlobalCrossRates() public {
        _fx();
        address[] memory b = new address[](3);
        address[] memory qt = new address[](3);
        bytes32[] memory f = new bytes32[](3);
        uint8[] memory bd = new uint8[](3);
        uint8[] memory qd = new uint8[](3);
        (b[0], qt[0], f[0], bd[0], qd[0]) = (EUR, USD, F_EUR, 18, 18);
        (b[1], qt[1], f[1], bd[1], qd[1]) = (USD, JPY, F_JPY, 18, 18);
        (b[2], qt[2], f[2], bd[2], qd[2]) = (XAU, USD, F_XAU, 18, 18);
        KursQuoteOracle g = new KursQuoteOracle(oracle, 300, b, qt, f, bd, qd);
        assertEq(g.getQuote(100e18, EUR, JPY), 17_775e18); // 100 EUR -> USD 112.5 -> JPY 17,775
        assertEq(g.getQuote(1e18, XAU, EUR), uint256(4_000e18 * 1e18) / 1.125e18); // gold in euros, rounded down
        assertEq(g.getQuote(17_775e18, JPY, EUR), 100e18);
    }
}
