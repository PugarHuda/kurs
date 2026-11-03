# Static analysis and invariants

## Slither (Trail of Bits)

`cd contracts && slither .` with Slither 0.11.6 and 102 detectors reports 16 results (15 by default plus `reentrancy-no-eth`, shown once the low-severity duplicates are filtered).
CI runs Slither on every push and fails on any medium or high finding that is not
triaged below. The detectors listed here are excluded in `contracts/slither.config.json`,
each for the reason given.

The deployed contracts are verified on Sourcify with an exact match, and
`slither-disable` comments would change the metadata hash, so the triage lives here
instead of in the source.

| Detector | Severity | Where | Decision |
|---|---|---|---|
| locked-ether | Medium | `KursOracle.fulfillOracleQuery` is `payable` | **Real, accepted for the testnet deployments.** ERC-7412 declares `fulfillOracleQuery` payable so oracles can charge a fee; Kurs charges none and has no withdraw, so ETH sent there would be locked. The Kurs client (`reporter/src/pull.ts`) always sends value 0. Fix for the next deployment: drop `payable` or add an owner `sweep`. |
| reentrancy-no-eth | Medium | `KursAggregatorFactory.deploy` writes `aggregatorOf` after calling `initialize` on the new clone | `initialize` makes no external call, so nothing can re-enter; a second `deploy` for the same feed reverts at `create2` (same salt, address taken). |
| reentrancy-benign, reentrancy-events | Low | `KursAggregatorFactory.deploy` calls `initialize` on the clone it just created | The callee is a fresh EIP-1167 clone of a fixed implementation; it cannot call back. |
| unused-return | Medium | `KursConverter.convert` ignores two return values of `latestRoundFresh` | Intentional: it needs only `roundId` and `answer`; freshness is enforced inside `latestRoundFresh`. |
| shadowing-local | Low | `reporters`, `feed` parameters and locals | Naming only; no storage is shadowed. |
| missing-zero-check | Low | `transferOwnership(address)` | Two-step ownership: `address(0)` can never call `acceptOwnership`, and setting it cancels a pending transfer. |
| timestamp | Low | freshness and observation-age checks | Comparing against `block.timestamp` is the purpose of these checks. Validators can skew timestamps by seconds; the limits are minutes. |
| assembly, too-many-digits | Info | EIP-1167 clone bytecode in the factory | Standard minimal-proxy bytecode. |
| naming-convention | Info | `DOMAIN_SEPARATOR` | The EIP-712 name. |
| cache-array-length | Optimization | `_reporters.length` in a loop | At most 32 reporters; the code path runs only in owner configuration. |

## Foundry invariants

`contracts/test/KursInvariant.t.sol` drives `transmit` with random bundles: round
replays and gaps, prices across the range, spreads up to ±3%, outsiders and
duplicate signers, and observations up to 400 s old against a 300 s limit. After every
call it checks:

- the stored round is the last accepted one: rejected bundles never change state and round ids never go backwards;
- the median lies inside that round's signed observations;
- the accepted spread is within the feed's 2% limit, the same rule as the contract;
- the answer is within the feed bounds;
- the ring buffer returns the latest round by id with the same answer.

`afterInvariant` fails the run unless both accepted and rejected bundles occurred.
Default profile: 256 runs × 500 calls = 128,000 transmits per CI run.
