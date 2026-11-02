// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// @title KursConverter
/// @notice A real Kurs consumer that only acts on a fresh price, pulled on demand.
/// `convert` reads `latestRoundFresh`; when the price is older than `maxAge` the
/// oracle's ERC-7412 `OracleDataRequired` revert bubbles up unchanged, an ERC-7412
/// client fetches a signed bundle, and retries as multicall(fulfillOracleQuery, convert).
/// Example: USD/IDR with 8 decimals, amounts in any base unit (e.g. cents).
contract KursConverter {
    KursOracle public immutable oracle;
    bytes32 public immutable feedId;
    uint32 public immutable maxAge;

    event Converted(address indexed caller, uint256 amount, uint256 converted, uint80 roundId, int192 price);

    error BadPrice(int192 price);

    constructor(KursOracle oracle_, bytes32 feedId_, uint32 maxAge_) {
        oracle = oracle_;
        feedId = feedId_;
        maxAge = maxAge_;
    }

    /// @notice amount * price / 1e8 at a price observed at most `maxAge` seconds ago.
    function convert(uint256 amount) external returns (uint256 converted) {
        (uint80 roundId, int192 price,,) = oracle.latestRoundFresh(feedId, maxAge);
        if (price <= 0) revert BadPrice(price);
        converted = amount * uint256(uint192(price)) / 1e8;
        emit Converted(msg.sender, amount, converted, roundId, price);
    }
}
