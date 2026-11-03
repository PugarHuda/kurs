# DoraHacks submission (copy-paste)

## Build page

| Field | Value |
|---|---|
| Name | Kurs |
| Logo | `docs/brand/logo.png` |
| Brief description | Price feeds for Portaldot V3, signed by independent reporters, readable from Solidity and ink!, portable to any EVM chain. Push or pull (ERC-7412). |
| Tags | Crypto / Web3 |
| GitHub | https://github.com/PugarHuda/kurs |
| Video | https://kurs-ten-zeta.vercel.app/kurs-demo.mp4 (2:13) |
| Website | https://kurs-ten-zeta.vercel.app |

## Organizer questions (submission form)

**Project name**
Kurs

**Track**
Multi-Chain & Cross-Chain Infra

**One-sentence project overview**
Kurs is a price oracle for Portaldot V3: independent reporters sign prices, KursOracle stores the median for Solidity and ink! contracts, and the same signed rounds settle on any EVM chain, pushed by a relayer or pulled into a transaction with ERC-7412.

**Current Project Progress** (max 960 characters)
Done and LIVE on Portaldot V3: KursOracle (signed median, strict-majority quorum, freshness/spread/bounds checks, ERC-7412 pull), 11 Chainlink AggregatorV3 feeds (crypto, USD/IDR from 5 sources, 5 equities from 3 sources, tPOT/pUSD read from Portaldot's AssetConversion runtime API), KursConverter pull consumer. ERC-7412 pull executed on Portaldot. Oracle owned by a native 2-of-3 pallet-multisig (acceptOwnership via multisig.asMulti + revive.call); Sepolia mirror owned by a 2-of-3 Safe. Relay on GitHub Actions pushes slot-aligned rounds (measured 7.9 tPOT to open a Revive slot vs 0.107 to overwrite) and mirrors the identical signed bundle to Sepolia; /api/health monitors feed ages. ink! v6 consumer reads the Solidity oracle cross-VM (verified on local pallet-revive). Dashboard verifies signatures in-browser. 66 tests (29 Solidity, 17 TS, 20 Playwright), CI green.

**Outstanding Items**
1. Deploy KursRemit (ink! v6, 11.6 KB PolkaVM code, ~900 tPOT of Revive deposit) on Portaldot V3: the cross-VM call is already verified on a local pallet-revive node (docs/ink-e2e-local.txt); remaining tPOT after the oracle deployment is ~330. 2. Keep the relay running through Demo Day and accumulate on-chain history. 3. Re-record the demo with the Portaldot rounds.

**GitHub Repository**
https://github.com/PugarHuda/kurs

**Testnet deployment details**
Portaldot V3 testnet (chain 420420777, live): KursOracle 0x5bdd9713ddc4f11e14bd3094882401cd122656f4, KursAggregatorFactory 0xd8ec774514bd01e2fd0d81845d9e56b31cd3915b, KursConverter 0xbfc639efc469056d9d4dcd8d4215060bae1fd676, 11 feeds with AggregatorV3 clones; oracle deploy tx 0x9856a155d12baf06ce8c7e9b1f952f5a403cf6b5d8f4ebcb3e7f1b85760dbb3a; first USD/IDR round tx 0x459d6ae3b9ed39362ba6c681b622f41f6a8867eb3b9d98e383e7db4c604e97b4 (block 299579). Ethereum Sepolia (live, same reporters): KursOracle 0xd3f6bf8e595e815de11598f23170b37341a2cbc3, KursConverter 0xa8268109f331dd0b219d424c91c5d3e06c490877, ERC-7412 pull tx 0x9e2aa23575734bba9b24b2ea6d25e9fc414a9b18cf2c3f64e323c3e9b17c405f, all Sourcify-verified. Every contract, feed and tx with explorer links: https://github.com/PugarHuda/kurs/blob/main/docs/evidence.md

**Demo video link**
https://kurs-ten-zeta.vercel.app/kurs-demo.mp4

**Pitch deck link**
https://github.com/PugarHuda/kurs/blob/main/docs/kurs-deck.pdf

**Looking for teammates**
No
