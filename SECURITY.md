# Security policy

Kurs runs on testnets only (Portaldot V3 testnet, Ethereum Sepolia). No contract holds user funds.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on
https://github.com/PugarHuda/kurs/security/advisories/new. Please do not open a public issue.
Expect a first reply within 72 hours.

In scope: `contracts/src/*`, the reporter and relay (`reporter/`), the HTTP API (`api/`),
and the dashboard's in-browser signature verification (`web/`).

## What is already known

[docs/security.md](docs/security.md) lists every static-analysis finding with its triage,
the one accepted issue (`fulfillOracleQuery` is `payable` with no withdraw), the Foundry
invariants, and the Halmos proofs. Checks that run on every push: Foundry tests and
invariants, gas snapshot, Slither (`--fail-medium`), CodeQL, Playwright with axe. Halmos
(`.github/workflows/halmos.yml`) runs when the oracle or the proofs change, and weekly.

## Trust model in one paragraph

A round is accepted only with signatures from a strict majority of the configured
reporters, observations no older than `maxObservationAge`, a spread within the feed's
`maxSpreadBps`, and a median inside `[minAnswer, maxAnswer]`. The owner can change
reporters and feeds; on Portaldot the owner is a pure proxy behind a 2-of-3
`pallet-multisig` with a 600-block `pallet-proxy` delay, on Sepolia a 2-of-3 Safe.
