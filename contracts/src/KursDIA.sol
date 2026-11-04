// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// DIA's IDIAOracleV2 over Kurs. DIA is the oracle most Polkadot-ecosystem dApps
/// (Moonbeam, Astar) already read, so they switch to Kurs by changing one address.
///
/// getValue("BTC/USD") -> (value, timestamp), as DIA does:
///  - key = the Kurs pair string, which is DIA's key format; feedId = keccak256(key)
///  - value: 8 decimals (DIA's convention), rescaled from the feed's decimals
///  - timestamp: the oldest observation in the round, not the block time
///  - unknown key or no round yet: (0, 0), exactly like DIA; callers check timestamp
/// No staleness check here: DIA consumers compare timestamp themselves.
contract KursDIA {
    KursOracle public immutable oracle;

    error BadPrice(string key);

    constructor(KursOracle oracle_) {
        oracle = oracle_;
    }

    function getValue(string memory key) external view returns (uint128 value, uint128 timestamp) {
        bytes32 id = keccak256(bytes(key));
        KursOracle.Feed memory f = oracle.feed(id);
        if (!f.exists) return (0, 0);
        (uint80 roundId, int192 answer, uint64 observedAt,) = oracle.latestRound(id);
        if (roundId == 0) return (0, 0);
        if (answer < 0) revert BadPrice(key);
        uint256 v = uint256(int256(answer));
        v = f.decimals >= 8 ? v / 10 ** (f.decimals - 8) : v * 10 ** (8 - f.decimals);
        if (v > type(uint128).max) revert BadPrice(key); // cast would truncate
        return (uint128(v), observedAt);
    }
}
