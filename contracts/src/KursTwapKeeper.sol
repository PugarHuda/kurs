// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursTwap} from "./KursTwap.sol";

/// Keeps a set of KursTwap contracts up to date through the two keeper interfaces in wide
/// use, so any network registers it as is:
///   Chainlink Automation  checkUpkeep(bytes) -> (bool, bytes), performUpkeep(bytes)
///   Gelato Web3 Functions  checker() -> (bool canExec, bytes execPayload)
/// The check is a view: it reports which TWAPs have an unrecorded oracle round. perform
/// pokes them; poke is permissionless and a no-op on a recorded round, so a stale or
/// replayed performData cannot do harm. The Kurs relay calls it the same way.
contract KursTwapKeeper {
    KursTwap[] public twaps;

    constructor(KursTwap[] memory twaps_) {
        twaps = twaps_;
    }

    function twapCount() external view returns (uint256) {
        return twaps.length;
    }

    /// Bit i set: twaps[i] has an oracle round it has not recorded.
    function due() public view returns (uint256 mask) {
        for (uint256 i; i < twaps.length; ++i) {
            KursTwap t = twaps[i];
            (uint80 roundId,,,) = t.oracle().latestRound(t.feedId());
            if (roundId != 0 && roundId != t.lastRoundId()) mask |= 1 << i;
        }
    }

    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 mask = due();
        return (mask != 0, abi.encode(mask));
    }

    function performUpkeep(bytes calldata performData) external {
        _poke(abi.decode(performData, (uint256)));
    }

    function checker() external view returns (bool canExec, bytes memory execPayload) {
        uint256 mask = due();
        return (mask != 0, abi.encodeCall(this.performUpkeep, (abi.encode(mask))));
    }

    /// Pokes every TWAP in `mask`; returns how many recorded a new round.
    function _poke(uint256 mask) internal returns (uint256 n) {
        for (uint256 i; i < twaps.length; ++i) {
            if (mask & (1 << i) != 0 && twaps[i].poke()) ++n;
        }
    }
}
