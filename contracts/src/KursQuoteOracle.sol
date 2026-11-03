// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// ERC-7726 (Common Quote Oracle) view of Kurs, the interface Euler v2 and other
/// modular lenders consume: getQuote(baseAmount, base, quote) -> quoteAmount.
///
/// Assets use the ERC-7726 identifiers: ETH 0xEeee…EEeE (ERC-7528), BTC 0xbBbB…BBbB,
/// fiat as its ISO 4217 numeric code (USD = address(840), IDR = address(360)).
/// Amounts are in each asset's smallest unit; fiat uses 18 decimals (Euler's convention).
///
/// A pair resolves directly (feed base/quote), inverted (feed quote/base), or through
/// USD (base/USD then USD/quote), so BTC -> IDR comes from BTC/USD and USD/IDR.
/// Every price used must be younger than maxAge, else latestRoundFresh reverts with
/// ERC-7412 OracleDataRequired and a client can pull a signed bundle first.
/// Results round down. The pair table is fixed at construction: no owner.
contract KursQuoteOracle {
    address public constant USD = address(840);

    KursOracle public immutable oracle;
    uint32 public immutable maxAge;

    struct Leg {
        bytes32 feedId; // feed "base/quote"
        uint8 baseDecimals;
        uint8 quoteDecimals;
    }

    /// feedOf[base][quote]: the feed quoting `base` in `quote`
    mapping(address => mapping(address => Leg)) public feedOf;

    error OracleUnsupportedPair(address base, address quote);
    error BadPrice(bytes32 feedId, int192 answer);

    constructor(
        KursOracle oracle_,
        uint32 maxAge_,
        address[] memory bases,
        address[] memory quotes,
        bytes32[] memory feeds,
        uint8[] memory baseDecimals,
        uint8[] memory quoteDecimals
    ) {
        oracle = oracle_;
        maxAge = maxAge_;
        for (uint256 i; i < feeds.length; ++i) {
            feedOf[bases[i]][quotes[i]] = Leg(feeds[i], baseDecimals[i], quoteDecimals[i]);
        }
    }

    function getQuote(uint256 baseAmount, address base, address quote) external view returns (uint256) {
        if (base == quote) return baseAmount;
        (bool ok, uint256 out) = _leg(baseAmount, base, quote);
        if (ok) return out;
        // pivot through USD
        (bool a, uint256 usd) = _leg(baseAmount, base, USD);
        if (a) {
            (bool b, uint256 q) = _leg(usd, USD, quote);
            if (b) return q;
        }
        revert OracleUnsupportedPair(base, quote);
    }

    /// One hop, direct or inverted. ok = false when no feed covers the pair.
    function _leg(uint256 amount, address base, address quote) internal view returns (bool, uint256) {
        Leg memory l = feedOf[base][quote];
        if (l.feedId != bytes32(0)) {
            (uint256 p, uint256 pScale) = _price(l.feedId);
            // amount [base units] * price [quote per base] -> quote units
            return (true, (amount * p * 10 ** l.quoteDecimals) / (pScale * 10 ** l.baseDecimals));
        }
        l = feedOf[quote][base];
        if (l.feedId != bytes32(0)) {
            (uint256 p, uint256 pScale) = _price(l.feedId);
            // the feed quotes `quote` in `base`: divide
            return (true, (amount * pScale * 10 ** l.baseDecimals) / (p * 10 ** l.quoteDecimals));
        }
        return (false, 0);
    }

    function _price(bytes32 feedId) internal view returns (uint256 price, uint256 scale) {
        (, int192 answer,,) = oracle.latestRoundFresh(feedId, maxAge);
        if (answer <= 0) revert BadPrice(feedId, answer);
        price = uint256(int256(answer));
        scale = 10 ** oracle.feed(feedId).decimals;
    }
}
