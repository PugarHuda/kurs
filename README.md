# Kurs

**Price feeds for Portaldot V3, signed by independent reporters, readable from Solidity and ink!, and portable to any EVM chain.**

*Kurs* is Indonesian for "exchange rate", the number on the board at every money changer.

Portaldot Hacker House 2026 · Track: **Multi-Chain & Cross-Chain Infra**

**Live dashboard:** https://kurs-ten-zeta.vercel.app · **Evidence:** [`docs/evidence.md`](docs/evidence.md) · **Deck:** [`docs/kurs-deck.pdf`](docs/kurs-deck.pdf)

| Network | KursOracle | Status |
|---|---|---|
| Ethereum Sepolia | [`0x5bdd9713…6656f4`](https://sepolia.etherscan.io/address/0x5bdd9713ddc4f11e14bd3094882401cd122656f4) | live, 11 feeds, source verified on Sourcify (exact match) |
| Portaldot V3 testnet | see [`deployments/`](deployments/) | deploying: waiting on testnet tPOT for Revive storage deposits (about 1,900 tPOT) |

![Kurs architecture](docs/architecture.png)

---

## Project overview

### Problem

Portaldot V3 runs EVM and ink! contracts side by side in `pallet-revive`, and people are already building money apps on it: tokenised TSLA, NVDA, AAPL, AMZN and META trade against DUCAT in the runtime's own DEX, there is a `pUSD` test dollar, and hacker-house teams are shipping lending, escrow and stablecoin contracts. **None of them can read a price.** We checked the live V3 testnet (spec `portaldot-v3` 3002):

| What we looked at | What is there |
|---|---|
| `Oracle` pallet (index 85) | Present, **0 values stored** |
| Oracle operator set (`TechnicalMembership.Members`) | **Empty**: no account can call `oracle.feedValues` |
| EVM precompiles | Assets, AssetsPermit, Vesting. **No oracle precompile** |
| Chainlink, Pyth, RedStone on Portaldot | Not deployed |
| Tokenised-stock pools on the native DEX | Price TSLA at about $0.04 when routed to pUSD (Kurs: about $410) |

A lending market listing those tokens today would have to price them from their own pools, which anyone can push around. That is how most DeFi exploits start.

### Solution

Kurs is a signed-observation oracle built for Portaldot's dual VM:

1. **Reporters** read many sources (exchanges, aggregators, Chainlink on Ethereum, FX and equity quotes, and Portaldot's own AssetConversion pools), take a median, and each **signs its own observation with EIP-712**.
2. **Anyone can transmit** a bundle of signatures. The transmitter is not trusted. The contract checks every signature.
3. **`KursOracle`** (Solidity on pallet-revive) requires a strict-majority quorum of distinct reporters, rejects stale or future timestamps and out-of-bounds values, **reverts when reporters disagree** by more than the feed's spread limit, and stores the **on-chain median**. A minority of dishonest reporters cannot move it.
4. **Solidity** consumers read it through the unchanged **Chainlink `AggregatorV3Interface`** (one 45-byte clone per feed). **ink!** consumers call the same contract through a Solidity-ABI cross-contract call: `KursRemit` (ink! v6, PolkaVM) reads `KursOracle` (EVM bytecode) inside the same pallet.
5. The signature domain carries **no chainId**, so **the same signed round settles to the same answer on any EVM chain** running Kurs. The tPOT price measured on Portaldot's own DEX can be exported to Ethereum, and ETH or BTC prices can be imported, with one set of signatures.

### Why it needs Portaldot

- Revive runs EVM and PolkaVM contracts in one pallet, so **one oracle serves both VMs**. On most chains you would deploy two.
- `pallet-asset-conversion` exposes pool prices through a runtime API (`AssetConversionApi_quote_price_exact_tokens_for_tokens`). Kurs reads it with `state_call` at several past blocks, which makes **a native Portaldot price** that other chains can consume.
- The runtime already reserves an `Oracle` pallet with an empty operator set. Kurs reporters are ready to be its operators: the value format (`u32` key, `u128` fixed point) maps directly.

### Blockchain relevance

Smart contracts (Solidity on pallet-revive, ink! v6 on PolkaVM), cross-VM calls, cross-chain data relay (EIP-712 portable signatures), DeFi infrastructure (Chainlink-compatible feeds), Substrate runtime APIs (`state_call` into AssetConversion), and Portaldot storage-deposit economics (ring buffer and clones, see below).

---

## Technical architecture

| Layer | Stack |
|---|---|
| Blockchain | Portaldot V3 testnet (`pallet-revive`, EVM chain id `420420777`), Ethereum Sepolia |
| Contracts | Solidity 0.8.28 (Foundry), ink! 6.0.0-beta.1 (PolkaVM, `cargo-contract` 6) |
| Reporter / transmitter | TypeScript, Node 22+, [viem](https://viem.sh) |
| Dashboard | Vite + TypeScript, no framework, no backend: reads public RPCs from the browser |

### Repository layout

```
contracts/          Foundry project
  src/KursOracle.sol          signed-median oracle (verify, aggregate, store)
  src/KursAggregatorV3.sol    Chainlink AggregatorV3 view + EIP-1167 clone factory
  test/KursOracle.t.sol       22 tests incl. fuzz, cross-chain replay, ring buffer
ink/kurs_consumer/  KursRemit, ink! v6 contract reading KursOracle via Solidity ABI
reporter/           sources, signing, bundle selection, transmit, deploy (CLI: kurs)
  src/feeds.ts                the 11 feeds and their sources (single source of truth)
  src/sources.ts              fetchers incl. Chainlink-on-Sepolia and AssetConversion
  src/kurs.ts                 EIP-712 signing, median, off-chain bundle checks
  src/chain.ts                deploy / configure / transmit
web/                dashboard ("Kurs hari ini" rate board)
deployments/        addresses + tx hashes written by `kurs deploy`
docs/               architecture diagram, evidence of on-chain activity
```

### Smart contracts

**`KursOracle`**

| Function | What it does |
|---|---|
| `transmit(feedId, roundId, Observation[])` | Permissionless. Verifies ≥ quorum distinct reporter signatures, freshness (`maxObservationAge`, 5-minute future skew), low-s signatures, spread ≤ `maxSpreadBps`, bounds. Stores the median. |
| `latestRound(feedId)` | `(roundId, answer, observedAt, updatedAt)` |
| `getRound(feedId, roundId)` | Any of the last 64 rounds; empty if overwritten |
| `observationDigest(...)` | The EIP-712 digest a reporter signs |
| `setReporters`, `setFeed`, `setMaxObservationAge` | Owner only. Quorum must be a strict majority. |
| `transferOwnership` / `acceptOwnership` | Two-step |

**`KursAggregatorFactory` / `KursAggregatorV3`**: `deploy(feedId)` creates a 45-byte EIP-1167 clone exposing `latestRoundData`, `getRoundData`, `decimals`, `description`, `version`.

**`KursRemit` (ink! v6)**: `latest()`, `quote(amount)`, `quote_and_log(amount)` (emits `Quoted`), refuses prices older than `max_age`.

### Designed for pallet-revive's costs

Revive charges a storage deposit per byte of code and per storage item (`depositPerByte` 0.06 tPOT, `depositPerItem` 0.15 tPOT on V3). We measured `KursOracle`'s deployment at about 711 tPOT with `eth_estimateGas`, then designed around it:

- **Ring buffer**: each feed keeps 64 rounds in fixed slots. After warm-up a new round overwrites a slot, so it adds no new deposit.
- **Clones**: each feed's Chainlink adapter is a 45-byte EIP-1167 clone (about 3 tPOT) instead of a 2 KB contract (about 150 tPOT).
- **Push on change**: the transmitter sends a round only when the price moves by the feed's deviation threshold or its heartbeat expires.

### Feeds

| Feed | Sources | Notes |
|---|---|---|
| BTC/USD, ETH/USD | Binance, Coinbase, Kraken, OKX, CoinGecko, CoinPaprika, DefiLlama, **Chainlink (Sepolia)** | 50 bps deviation, 1 h heartbeat |
| DOT/USD, USDT/USD | exchanges + aggregators | |
| **USD/IDR** | open.er-api, Yahoo FX, CoinGecko (USDT/IDR) | for Rupiah apps |
| TSLA, NVDA, AAPL, AMZN, META /USD | Yahoo | the tokenised stocks that already trade on Portaldot |
| **tPOT/pUSD** | Portaldot `pallet-asset-conversion`, median of 5 quotes 50 blocks apart, thin pools refused | native Portaldot price, exportable |

A reporter abstains on a feed when fewer than `minSources` answer, and drops any source more than 5% from the others.

---

## Installation & setup

Requirements: Node 22+, [Foundry](https://getfoundry.sh), and for the ink! contract Rust with `cargo-contract` 6.0.0-beta (`cargo install cargo-contract --version 6.0.0-beta.2 --locked`, build with Rust 1.92 plus `rust-src`).

```bash
git clone https://github.com/PugarHuda/kurs && cd kurs

# contracts
cd contracts && forge test && cd ..

# reporter
cd reporter && npm ci && npm test
npx tsx src/cli.ts observe        # live prices from every source, no keys needed
cd ..

# dashboard
cd web && npm ci && npm run dev   # http://localhost:5173
```

### Run your own deployment

```bash
cp .env.example .env              # DEPLOYER_PK, REPORTER_1_PK .. REPORTER_5_PK
cd reporter
npx tsx src/cli.ts deploy portaldot        # oracle + factory + 11 feeds + clones
npx tsx src/cli.ts deploy sepolia          # same reporter set on Sepolia
KURS_CHAINS=portaldot,sepolia npx tsx src/cli.ts run   # relay every round to both
```

Run a reporter on its own machine and point a transmitter at it:

```bash
REPORTER_PK=0x... PORT=8787 npx tsx src/cli.ts serve
KURS_REPORTER_URLS=https://reporter-a.example,https://reporter-b.example npx tsx src/cli.ts run
```

### ink! consumer

```bash
cd ink/kurs_consumer
cargo +1.92.0 contract build --release      # target/ink/kurs_consumer.polkavm
```

Instantiate with `new(oracle, keccak256("USD/IDR"), 3600)`, then call `quote(100_00)` to convert 100.00 USD to Rupiah.

### Local end-to-end

`reporter/test/e2e.test.ts` starts anvil, deploys, has five reporters sign different prices, transmits, and reads the median back through the AggregatorV3 clone.

---

## Deployment on Portaldot V3 testnet

| | |
|---|---|
| EVM RPC | `https://test-evm-rpc-v3.portaldot.dev` (chain id 420420777) |
| Substrate RPC | `wss://test-node-v3.portaldot.dev` |
| Explorer | https://scanner-testnet-v3.portaldot.dev |

Contract addresses, every transaction hash, and the reporter set are in [`deployments/`](deployments/) and summarised in [`docs/evidence.md`](docs/evidence.md) (regenerate with `cd reporter && npm run evidence`).

Measured on V3 before deploying: `eth_estimateGas` for `KursOracle` comes to about 711 tPOT, almost all of it the code storage deposit (0.06 tPOT per byte plus a 30% code-hash lockup). The ink! contract (11.6 KB of PolkaVM code) is about 900 tPOT. These deposits are refundable when code is removed.

## Testing

| Suite | Count | Command |
|---|---|---|
| Solidity (Foundry, 1,000 fuzz runs) | 22 | `cd contracts && forge test` |
| Reporter unit + anvil e2e (vitest) | 15 | `cd reporter && npm test` |
| **Cross-VM: ink! v6 reads the Solidity oracle** (local ink-node) | end to end | `cd reporter && npm run ink-e2e` |

The cross-VM run deploys KursOracle, transmits a 5-reporter USD/IDR round, deploys KursRemit (ink! v6, PolkaVM), and checks that `KursRemit.latest()` returns exactly the oracle's round, then sends `quote_and_log` as a real transaction. Output: [`docs/ink-e2e-local.txt`](docs/ink-e2e-local.txt). ink-node v0.47 does not accept EVM bytecode, so locally the oracle is compiled to PolkaVM with resolc 0.5.0; Portaldot V3 accepts EVM bytecode and runs the solc build. KursRemit only sees an H160 that speaks the Solidity ABI, so its code is the same in both cases.

What the tests cover: median of odd and even sets, a 2-of-5 lying minority cannot move the median, duplicate, outsider, tampered and high-s signatures, stale, future and replayed rounds, disagreement and bounds circuit breakers, strict-majority quorum, reporter rotation, two-step ownership, the AggregatorV3 adapter and clones, the ring buffer, **the same bundle verifying on a second chain id**, the viem digest matching the contract formula byte for byte, and off-chain bundle selection under vote spamming, malformed input and coordinated outliers.

## Security model and limits

- **Trust**: the reporter set and its strict-majority quorum. A minority cannot move the median and cannot forge a round. The owner can rotate reporters and change feed parameters; on mainnet that key belongs behind Portaldot's native `Multisig` and `Proxy` with a delay.
- **Transmitter**: untrusted. It can only choose *when* to submit, and it re-checks everything off chain so one bad reporter cannot make a bundle revert.
- **Today's reporters** are five keys run by the Kurs team. The protocol is built for independent operators (`kurs serve` plus `KURS_REPORTER_URLS`), and reporter rotation is one owner transaction.
- **Equities** come from one public source (Yahoo). A paid market-data feed is needed before mainnet.
- **tPOT/pUSD** comes from one AMM. It is sampled across about 20 minutes of blocks and rejects pools under 100 pUSD; the testnet pool holds about 127 pUSD.
- Not audited.

## Roadmap

- Done during the hacker house: oracle, clones, ring buffer, reporter and transmitter, 11 feeds, ink! v6 consumer, dashboard, Sepolia deployment with live rounds.
- Next: independent reporter operators from the Portaldot community; owner moved to a native Multisig with a time delay; Kurs reporters as operators of the runtime `Oracle` pallet, so native pallets and contracts read the same prices; a read precompile proposal for the `Oracle` pallet; more chains in the relay (Base, BSC, Arbitrum), plus the bridge at bridge.portaldot.dev for POT-denominated feeds.

## Prior work and third-party code

- [forge-std](https://github.com/foundry-rs/forge-std) (MIT, vendored in `contracts/lib`), [viem](https://github.com/wevm/viem) (MIT), [ink!](https://github.com/use-ink/ink) (Apache-2.0), [Vite](https://vitejs.dev) (MIT), [DSEG font](https://github.com/keshikan/DSEG) (OFL-1.1), Archivo (OFL-1.1).
- EIP-1167 minimal-proxy bytecode, Chainlink's `AggregatorV3Interface` shape.
- Same author as [pdk](https://github.com/PugarHuda/portaldot-dev-kit) (1st place, Portaldot Mini Hackathon S1, Builder Tools). No pdk code is reused in Kurs.

## Team

- **Pugar Huda Mantoro**: contracts, reporter, dashboard. GitHub [@PugarHuda](https://github.com/PugarHuda) · Discord: Bang Drop

## License

MIT, see [LICENSE](LICENSE).
