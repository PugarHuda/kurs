// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC7726 {
    function getQuote(uint256 baseAmount, address base, address quote) external view returns (uint256);
}

/// Morpho Blue IOracle over Kurs: price() is what one market's collateral is worth in
/// its loan token, scaled by 1e36 as Morpho Blue expects
/// (loan units = collateral units * price / 1e36).
///
/// It prices through KursQuoteOracle (ERC-7726), so pivots such as BTC -> USD -> IDR
/// come for free and a stale feed reverts with ERC-7412 OracleDataRequired instead of
/// returning an old price. One deployment per market, no owner.
contract KursMorphoOracle {
    IERC7726 public immutable quoteOracle;
    address public immutable collateralAsset; // ERC-7726 id, e.g. BTC 0xbBbB…BBbB
    address public immutable loanAsset; // e.g. IDR = address(360)
    uint256 internal immutable ONE_COLLATERAL_ASSET; // 10^(collateral asset decimals in the quote oracle)
    // price = quote * 10^(36 + loan token dec - collateral token dec - loan asset dec):
    // one combined power, applied as a multiply (MUL) or a divide (DIV), never both
    uint256 internal immutable MUL;
    uint256 internal immutable DIV;

    constructor(
        IERC7726 quoteOracle_,
        address collateralAsset_,
        uint8 collateralAssetDecimals,
        uint8 collateralTokenDecimals,
        address loanAsset_,
        uint8 loanAssetDecimals,
        uint8 loanTokenDecimals
    ) {
        quoteOracle = quoteOracle_;
        collateralAsset = collateralAsset_;
        loanAsset = loanAsset_;
        ONE_COLLATERAL_ASSET = 10 ** collateralAssetDecimals;
        int256 e = 36 + int256(uint256(loanTokenDecimals)) - int256(uint256(collateralTokenDecimals))
            - int256(uint256(loanAssetDecimals));
        MUL = e >= 0 ? 10 ** uint256(e) : 1;
        DIV = e < 0 ? 10 ** uint256(-e) : 1;
    }

    /// @notice Morpho Blue IOracle.
    function price() external view returns (uint256) {
        // quote one whole collateral unit, then rescale to token decimals and 1e36
        // (pricing 1e36 units directly would overflow on a pivot)
        return (quoteOracle.getQuote(ONE_COLLATERAL_ASSET, collateralAsset, loanAsset) * MUL) / DIV;
    }
}
