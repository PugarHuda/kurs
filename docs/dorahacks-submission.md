# DoraHacks BUIDL fields (copy-paste)

**Name:** Kurs

**Logo:** `docs/brand/logo.png`

**One-line vision (≤ 120 chars):**
Price feeds for Portaldot V3, signed by independent reporters, readable from Solidity and ink!, portable to any EVM chain.

**Track:** Multi-Chain & Cross-Chain Infra

**Tags:** Oracle, DeFi, Infrastructure, Solidity, ink!, Cross-chain, Portaldot

**GitHub:** https://github.com/PugarHuda/kurs

**Demo (live):** https://kurs-ten-zeta.vercel.app

**Demo video:** (to add)

**Pitch deck:** https://github.com/PugarHuda/kurs/blob/main/docs/kurs-deck.pdf

---

## Description (markdown)

**Kurs** (Indonesian for "exchange rate") is a signed-observation price oracle built for Portaldot V3's dual VM.

### The problem
Portaldot V3 already has money apps: tokenised TSLA, NVDA, AAPL, AMZN and META trade against DUCAT in the runtime's own DEX, there is a pUSD test dollar, and hacker-house teams are shipping lending, escrow and stablecoin contracts. None of them can read a price. On the live V3 testnet (spec 3002) the `Oracle` pallet holds 0 values, its operator set is empty, no precompile exposes it to EVM, and no Chainlink, Pyth or RedStone is deployed. Routed through Portaldot's own pools, one TSLA token is worth about $0.04; the real price is about $410.

### How Kurs works
1. Reporters read exchanges, aggregators, Chainlink on Ethereum, FX and equity quotes, and Portaldot's own AssetConversion pools, then each signs its own observation with EIP-712.
2. Anyone can transmit the bundle; the contract trusts signatures, not the sender.
3. `KursOracle` (Solidity on pallet-revive) requires a strict-majority quorum, rejects stale, future, out-of-bounds and disagreeing reports, and stores the median. A dishonest minority cannot move it.
4. Solidity reads it through the unchanged Chainlink `AggregatorV3Interface` (a 45-byte clone per feed). ink! v6 reads the same contract through a Solidity-ABI call (`KursRemit`, USD to Rupiah).
5. The signature domain has no chain id, so a round signed once settles to the same answer on every chain. tPOT/pUSD, read from Portaldot's own DEX, is already live on Ethereum Sepolia.

### Built for Revive
Revive charges a deposit per byte of code and per storage item (we measured about 711 tPOT for the oracle). Kurs keeps a 64-round ring buffer per feed so new rounds add no deposit, and uses 45-byte clones for feed adapters.

### Feeds (11)
BTC, ETH, DOT, USDT, USD/IDR, TSLA, NVDA, AAPL, AMZN, META, and tPOT/pUSD from pallet-asset-conversion (median of 5 quotes across 20 minutes of blocks, thin pools refused).

### Proof
- Sepolia: KursOracle `0x5bdd9713ddc4f11e14bd3094882401cd122656f4`, verified on Sourcify (exact match), live rounds for all 11 feeds.
- Portaldot V3: deployment details and every tx hash in `docs/evidence.md`.
- 22 Solidity tests (incl. fuzz, cross-chain replay) + 15 TypeScript tests (incl. anvil end-to-end); CI green.
- Dashboard reads everything from public RPCs in the browser, no backend.

### Team
Pugar Huda Mantoro, author of pdk (Portaldot Dev Kit): 1st place, Portaldot Online Mini Hackathon S1, Builder Tools; Community Favorite #1.

---

## Check-in fields

**Current progress:** Contracts, reporter/transmitter, 11 feeds, ink! v6 consumer, dashboard and deck done. Live on Ethereum Sepolia with Sourcify-verified contracts and rounds for all feeds. Reads Portaldot V3 natively (AssetConversion runtime API) for the tPOT/pUSD feed.

**Outstanding items:** Deploy KursOracle + factory + KursRemit on Portaldot V3 testnet (needs ~1,900 tPOT for Revive storage deposits; requested via support ticket), run relay to both chains, record demo video.

**Testnet deployment:** see `docs/evidence.md`.
