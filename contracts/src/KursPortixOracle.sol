// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// Portix's IPortixPriceOracle over Kurs (github.com/rikokurnia/portix, a Portaldot Hacker
/// House 2026 lending market for tokenised stocks against pUSDC). Portix ships an owner-set
/// oracle (setPrice); pointing its market at this contract prices the same stock tokens from
/// Kurs's signed equity feeds instead, with Portix's own errors and 6-decimal pUSDC scale.
///
/// Each token maps to a USD feed ("TSLA" token -> "TSLA/USD"), fixed at construction: no owner.
contract KursPortixOracle {
    KursOracle public immutable oracle;
    /// Portix's maxPriceAge (heartbeat): getPriceUSD refuses older rounds
    uint256 public immutable maxPriceAge;

    mapping(address => bytes32) public feedOf;

    // the same errors as IPortixPriceOracle, so Portix's market handles them unchanged
    error OraclePriceStale(address token, uint256 updatedAt, uint256 maxAge);
    error OraclePriceZero(address token);
    error TokenNotSupported(address token);

    constructor(KursOracle oracle_, uint256 maxPriceAge_, address[] memory tokens, bytes32[] memory feeds) {
        require(tokens.length == feeds.length, "length");
        oracle = oracle_;
        maxPriceAge = maxPriceAge_;
        for (uint256 i; i < tokens.length; ++i) feedOf[tokens[i]] = feeds[i];
    }

    /// Raw Kurs answer, its decimals, and when the round was written.
    function getPrice(address token) public view returns (uint256 price, uint8 decimals, uint256 updatedAt) {
        bytes32 id = feedOf[token];
        if (id == bytes32(0)) revert TokenNotSupported(token);
        (, int192 answer,, uint64 written) = oracle.latestRound(id);
        if (answer <= 0) revert OraclePriceZero(token);
        return (uint256(int256(answer)), oracle.feed(id).decimals, written);
    }

    /// Fresh USD price in pUSDC units (1 USD = 1e6), as Portix's market expects.
    function getPriceUSD(address token) external view returns (uint256 priceUSD6) {
        (uint256 price, uint8 decimals, uint256 updatedAt) = getPrice(token);
        if (block.timestamp > updatedAt + maxPriceAge) revert OraclePriceStale(token, updatedAt, maxPriceAge);
        priceUSD6 = decimals >= 6 ? price / 10 ** (decimals - 6) : price * 10 ** (6 - decimals);
        if (priceUSD6 == 0) revert OraclePriceZero(token);
    }
}
