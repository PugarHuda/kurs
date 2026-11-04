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
| calls-loop | Low | `KursPyth.updatePriceFeeds` calls `fulfillOracleQuery` once per update | Pyth's batch semantics. Every call goes to the immutable Kurs oracle, never to a caller-chosen address; one bad bundle reverts the whole batch, which is what Pyth does too. |
| missing-inheritance | Info | `KursQuoteOracle` does not inherit the `IERC7726` interface declared in `KursMorphoOracle.sol` | Same ABI either way; adding the `is` clause would change the deployed bytecode's metadata and break the Sourcify exact match of the live contract. |

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

## Symbolic proofs (Halmos)

`contracts/test/KursHalmos.t.sol` runs the oracle's own `_sort` and `_median` on symbolic
`int192` inputs, so each property holds for every input rather than a fuzzed sample, for
bundles of 3, 4 and 5 observations (the deployed set is 5 reporters, quorum 3):

- `check_sortN`: the output is ascending and a permutation of the input
- `check_medianBoundedN`: the median lies between the smallest and largest observation
- `check_minorityN`: if a strict majority of observations lie in `[lo, hi]`, the median does
  too, whatever the minority signed (2 of 3, 3 of 4, 3 of 5 honest)

All 9 proofs PASS in CI (halmos 0.3.3, `--loop 6`, one job per proof,
[run 41751934920](https://github.com/PugarHuda/kurs/actions/runs/41751934920)):

| proof | paths | time |
|---|---|---|
| `check_sort3` / `sort4` / `sort5` | 14 / 88 / 260 | 0.4 s / 1.9 s / 7.9 s |
| `check_medianBounded3` / `4` / `5` | 9 / 104 / 151 | 0.1 s / 9.5 s / 2.7 s |
| `check_minority3` / `4` / `5` | 15 / 102 / 171 | 51 s / 18 s / 126 s |

(3- and 4-observation times are from a local run, 5-observation from CI.) An earlier
single-job run timed out at 2 h with no result because the test's own helpers branched
per element; they are now branch-free (assembly `eq`/`slt`).
