// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// Pyth's PythStructs, same layout, so IPyth callers decode it unchanged.
library PythStructs {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }
}

/// The IPyth price interface over Kurs, so an app already integrated with Pyth reads
/// Kurs by changing one address. Pyth price id = Kurs feedId = keccak256(pair).
///
///  - price / expo: the signed median, expo = -feed decimals
///  - conf: the feed's spread bound (|price| * maxSpreadBps / 10000). Every
///    observation in the round was within it, or the oracle rejected the round.
///  - publishTime: the oldest observation in the round, not the block time
///  - updatePriceFeeds(updateData): Pyth's pull flow. Each element is a Kurs signed
///    bundle (the `payload` from /api/bundle) and is forwarded to
///    KursOracle.fulfillOracleQuery, so it is verified exactly like a relay round.
///    The update fee is 0.
///
/// EMA prices are not provided; those calls are absent and revert.
contract KursPyth {
    KursOracle public immutable oracle;
    uint256 public immutable validTimePeriod;

    // Pyth's own error names (same selectors), so callers matching on them keep working
    error PriceFeedNotFound();
    error StalePrice();
    // Kurs-specific
    error FeeNotAccepted();
    error PriceOverflow(bytes32 id);

    constructor(KursOracle oracle_, uint256 validTimePeriod_) {
        oracle = oracle_;
        validTimePeriod = validTimePeriod_;
    }

    function getPriceUnsafe(bytes32 id) public view returns (PythStructs.Price memory p) {
        KursOracle.Feed memory f = oracle.feed(id);
        if (!f.exists) revert PriceFeedNotFound();
        (uint80 roundId, int192 answer, uint64 observedAt,) = oracle.latestRound(id);
        if (roundId == 0) revert PriceFeedNotFound();
        if (answer > type(int64).max || answer < type(int64).min) revert PriceOverflow(id);
        uint256 abs = uint256(int256(answer < 0 ? -answer : answer));
        p.price = int64(answer);
        p.conf = uint64((abs * f.maxSpreadBps) / 10_000);
        p.expo = -int32(uint32(f.decimals));
        p.publishTime = observedAt;
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) public view returns (PythStructs.Price memory p) {
        p = getPriceUnsafe(id);
        if (block.timestamp > p.publishTime + age) revert StalePrice();
    }

    function getPrice(bytes32 id) external view returns (PythStructs.Price memory) {
        return getPriceNoOlderThan(id, validTimePeriod);
    }

    function getValidTimePeriod() external view returns (uint256) {
        return validTimePeriod;
    }

    function priceFeedExists(bytes32 id) external view returns (bool) {
        return oracle.feed(id).exists;
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    /// Fee is 0; rejecting value keeps ETH from being locked here.
    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value != 0) revert FeeNotAccepted();
        for (uint256 i; i < updateData.length; ++i) {
            oracle.fulfillOracleQuery(updateData[i]);
        }
    }
}
