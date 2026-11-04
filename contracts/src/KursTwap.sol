// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// Time-weighted average of one Kurs feed, Uniswap v3 oracle style: a price
/// accumulator sampled into a ring of observations, read with observe(secondsAgos)
/// or consult(window). A lender that wants manipulation resistance on top of the
/// signed median reads the TWAP; a single fresh round cannot move it far.
///
/// poke() is permissionless (the Kurs relay calls it after each round). Each new round
/// becomes effective at its on-chain updatedAt, so a late poke is still exact. A round
/// that is overwritten before anyone pokes is missed, and the previous price is
/// extended over its time. ponytail: 48 slots of hourly rounds = 2 days of window;
/// raise CARDINALITY if longer windows are needed.
contract KursTwap {
    uint256 public constant CARDINALITY = 48;

    struct Obs {
        uint64 t; // when `price` became effective (round updatedAt)
        int192 price; // the price from t onwards
        int256 cumulative; // sum of price * seconds up to t
    }

    KursOracle public immutable oracle;
    bytes32 public immutable feedId;
    Obs[CARDINALITY] public observations;
    uint256 public count; // observations written, ever
    uint80 public lastRoundId;

    event Poked(uint80 indexed roundId, int192 price, uint64 t);

    error NoHistory();
    error WindowTooLong(uint32 secondsAgo, uint64 oldest);
    error ZeroWindow();

    constructor(KursOracle oracle_, string memory pair) {
        oracle = oracle_;
        feedId = keccak256(bytes(pair));
    }

    /// Records the feed's latest round if it is new. Returns true when it wrote one.
    function poke() external returns (bool) {
        (uint80 roundId, int192 answer,, uint64 updatedAt) = oracle.latestRound(feedId);
        if (roundId == 0 || roundId == lastRoundId) return false;
        uint256 n = count;
        int256 cum = 0; // first observation: nothing accumulated yet
        if (n > 0) {
            Obs memory last = observations[(n - 1) % CARDINALITY];
            if (updatedAt < last.t) updatedAt = last.t; // never step back in time
            cum = last.cumulative + int256(last.price) * int256(uint256(updatedAt - last.t));
        }
        observations[n % CARDINALITY] = Obs(updatedAt, answer, cum);
        count = n + 1;
        lastRoundId = roundId;
        emit Poked(roundId, answer, updatedAt);
        return true;
    }

    /// Price accumulator at `secondsAgo` before now for each entry (Uniswap's observe).
    function observe(uint32[] calldata secondsAgos) external view returns (int256[] memory cumulatives) {
        cumulatives = new int256[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            cumulatives[i] = _cumulativeAt(block.timestamp - secondsAgos[i], secondsAgos[i]);
        }
    }

    /// Average price over the last `window` seconds, in the feed's decimals.
    function consult(uint32 window) external view returns (int192) {
        if (window == 0) revert ZeroWindow();
        int256 a = _cumulativeAt(block.timestamp - window, window);
        int256 b = _cumulativeAt(block.timestamp, 0);
        return int192((b - a) / int256(uint256(window)));
    }

    /// Oldest timestamp a window can reach back to.
    function oldest() public view returns (uint64) {
        uint256 n = count;
        if (n == 0) revert NoHistory();
        return observations[n > CARDINALITY ? n % CARDINALITY : 0].t;
    }

    function _cumulativeAt(uint256 t, uint32 secondsAgo) internal view returns (int256) {
        uint256 n = count;
        if (n == 0) revert NoHistory();
        uint64 first = oldest();
        if (t < first) revert WindowTooLong(secondsAgo, first);
        // newest observation at or before t (ponytail: linear scan over <= 48 slots)
        uint256 lo = n > CARDINALITY ? n - CARDINALITY : 0;
        for (uint256 k = n; k > lo; --k) {
            Obs memory o = observations[(k - 1) % CARDINALITY];
            if (o.t <= t) return o.cumulative + int256(o.price) * int256(t - o.t);
        }
        revert WindowTooLong(secondsAgo, first); // unreachable: t >= first
    }
}
