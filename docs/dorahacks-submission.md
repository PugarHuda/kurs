# DoraHacks submission (copy-paste)

## Build page

| Field | Value |
|---|---|
| Name | Kurs |
| Logo | `docs/brand/logo.png` |
| Brief description | Price feeds for Portaldot V3, signed by independent reporters, readable from Solidity and ink!, portable to any EVM chain. Push or pull (ERC-7412). |
| Tags | Crypto / Web3 |
| GitHub | https://github.com/PugarHuda/kurs |
| Video | https://kurs-ten-zeta.vercel.app/kurs-demo.mp4 (3:13) |
| Website | https://kurs-ten-zeta.vercel.app |

## Organizer questions (submission form)

**Project name**
Kurs

**Track**
Multi-Chain & Cross-Chain Infra

**One-sentence project overview**
Kurs is a price oracle for Portaldot V3: independent reporters sign prices, KursOracle stores the median for Solidity and ink! contracts, and the same signed rounds settle on any EVM chain, pushed by a relayer or pulled into a transaction with ERC-7412.

**Current Project Progress** (max 960 characters)
LIVE on Portaldot V3: KursOracle (EIP-712 signed median, strict-majority quorum, freshness/spread/bounds checks, ERC-7412 pull), DIA getValue adapter, Chainlink feeds for crypto, stocks, IDR, EUR, gold, tPOT/pUSD from Portaldot's AssetConversion API. Owner: 2-of-3 pallet-multisig behind a 600-block proxy timelock, used live to sync feed config (Safe batch on Sepolia). Hourly relay mirrors the same signed rounds to Sepolia, which adds GBP, JPY, CNY and speaks Chainlink V2/V3/Feed Registry, Pyth, DIA, Band, API3, Chronicle, Aave v3, ERC-7726, Euler, Silo v2, Morpho Blue and an on-chain TWAP + Automation keeper (all Sourcify-verified). ink! v6 KursRemit is live on Portaldot and reads the Solidity oracle cross-VM. API: bundle, history, health, Substrate read, Prometheus, x402, MCP server that verifies signatures for agents; npm SDK kurs-oracle. 141 tests + 9 Halmos proofs, invariants over 128k transmits, Slither, CodeQL, Scorecard in CI.

**Outstanding Items**
1. Deploy the remaining adapters (Feed Registry, ERC-7726, Band, API3, Chronicle, Aave, Pyth, Morpho) on Portaldot, ~1,805 tPOT in total; they are live on Sepolia, and autodeploy.yml deploys them as soon as the gas payer is funded. 2. Keep the relay running through Demo Day: a workflow claims the testnet faucet for the relay's own keys whenever its gas balance falls below 100 tPOT. 3. More independent reporter operators.

**GitHub Repository**
https://github.com/PugarHuda/kurs

**Testnet deployment details**
Portaldot V3 testnet (chain 420420777, live): KursOracle 0x5bdd9713ddc4f11e14bd3094882401cd122656f4, KursAggregatorFactory 0xd8ec774514bd01e2fd0d81845d9e56b31cd3915b, KursConverter 0xbfc639efc469056d9d4dcd8d4215060bae1fd676, KursRemit (ink! v6) 0x26d22f75a6d33b5bdb4e598335826f3fa8553530, KursDIA 0x969b85f2c66b8504bb4f33e16333e7328187dfd9, 13 feeds with AggregatorV3 clones; oracle deploy tx 0x9856a155d12baf06ce8c7e9b1f952f5a403cf6b5d8f4ebcb3e7f1b85760dbb3a; first USD/IDR round tx 0x459d6ae3b9ed39362ba6c681b622f41f6a8867eb3b9d98e383e7db4c604e97b4 (block 299579). Ethereum Sepolia (live, same reporters): KursOracle 0xd3f6bf8e595e815de11598f23170b37341a2cbc3, KursConverter 0xa8268109f331dd0b219d424c91c5d3e06c490877, ERC-7412 pull tx 0x9e2aa23575734bba9b24b2ea6d25e9fc414a9b18cf2c3f64e323c3e9b17c405f, all Sourcify-verified. Every contract, feed and tx with explorer links: https://github.com/PugarHuda/kurs/blob/main/docs/evidence.md

**Demo video link**
https://kurs-ten-zeta.vercel.app/kurs-demo.mp4

**Pitch deck link**
https://github.com/PugarHuda/kurs/blob/main/docs/kurs-deck.pdf

**Looking for teammates**
No
