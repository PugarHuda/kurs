// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ERC-7726 getQuote, as served by KursQuoteOracle.
interface IQuote {
    function getQuote(uint256 baseAmount, address base, address quote) external view returns (uint256);
}

/// Silo v2's ISiloOracle over KursQuoteOracle: a Silo market prices collateral
/// `_baseToken` in its `quoteToken`. Same asset ids, decimals and ERC-7412 staleness
/// revert as the quote oracle. beforeQuote has nothing to update: Kurs is pushed
/// (or pulled in the same transaction) before the Silo call.
contract KursSiloOracle {
    IQuote public immutable quoteOracle;
    address public immutable quoteToken;

    constructor(IQuote quoteOracle_, address quoteToken_) {
        quoteOracle = quoteOracle_;
        quoteToken = quoteToken_;
    }

    function beforeQuote(address) external {}

    function quote(uint256 _baseAmount, address _baseToken) external view returns (uint256 quoteAmount) {
        return quoteOracle.getQuote(_baseAmount, _baseToken, quoteToken);
    }
}
