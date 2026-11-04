// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// Band Protocol's IStdReference over Kurs (Band also serves Astar and Moonbeam).
///
/// getReferenceData("BTC", "IDR") -> rate (1e18), lastUpdatedBase, lastUpdatedQuote.
/// Every symbol is priced in USD: "USD" is 1, otherwise the feed "SYM/USD" or the
/// inverse of "USD/SYM" (that is how IDR is quoted). rate = base in USD / quote in USD.
/// lastUpdated* = the oldest observation in that symbol's round (0 for USD), so
/// callers apply their own staleness rule, as with Band.
/// Unknown symbol or empty feed: revert, as Band does.
contract KursBand {
    struct ReferenceData {
        uint256 rate;
        uint256 lastUpdatedBase;
        uint256 lastUpdatedQuote;
    }

    KursOracle public immutable oracle;

    error RefDataNotAvailable(string symbol);

    constructor(KursOracle oracle_) {
        oracle = oracle_;
    }

    function getReferenceData(string memory base, string memory quote) public view returns (ReferenceData memory r) {
        (uint256 b, uint256 tb) = _usd(base);
        (uint256 q, uint256 tq) = _usd(quote);
        return ReferenceData((b * 1e18) / q, tb, tq);
    }

    function getReferenceDataBulk(string[] memory bases, string[] memory quotes)
        external
        view
        returns (ReferenceData[] memory r)
    {
        require(bases.length == quotes.length, "BAD_INPUT_LENGTH");
        r = new ReferenceData[](bases.length);
        for (uint256 i; i < bases.length; ++i) r[i] = getReferenceData(bases[i], quotes[i]);
    }

    /// symbol price in USD, 18 decimals, and the time it was observed
    function _usd(string memory s) internal view returns (uint256 price, uint256 at) {
        if (keccak256(bytes(s)) == keccak256("USD")) return (1e18, 0);
        (bool ok, uint256 p, uint256 t) = _read(keccak256(abi.encodePacked(s, "/USD")));
        if (ok) return (p, t);
        (ok, p, t) = _read(keccak256(abi.encodePacked("USD/", s)));
        if (ok) return (1e36 / p, t);
        revert RefDataNotAvailable(s);
    }

    function _read(bytes32 id) internal view returns (bool, uint256, uint256) {
        KursOracle.Feed memory f = oracle.feed(id);
        if (!f.exists) return (false, 0, 0);
        (uint80 roundId, int192 answer, uint64 observedAt,) = oracle.latestRound(id);
        if (roundId == 0 || answer <= 0) return (false, 0, 0);
        return (true, (uint256(int256(answer)) * 1e18) / 10 ** f.decimals, observedAt);
    }
}
