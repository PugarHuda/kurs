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

**Current Project Progress**
Done: KursOracle (signed median, strict-majority quorum, freshness, spread and bounds checks, 64-round ring buffer, ERC-7412 pull), Chainlink AggregatorV3 clones (45 bytes per feed), KursConverter pull consumer, KursRemit ink! v6 consumer verified cross-VM on pallet-revive (ink! reads the Solidity oracle via its ABI), reporter/transmitter CLI with 11 feeds (BTC, ETH, DOT, USDT, USD/IDR, 5 equities, tPOT/pUSD read natively from Portaldot's AssetConversion runtime API), ERC-7412 client, signed-bundle API, dashboard with in-browser signature verification, demo video, deck. Live on Ethereum Sepolia with all contracts Sourcify-verified, rounds pushed by 5 reporters, and an ERC-7412 pull in one transaction. 61 automated tests (29 Solidity, 16 TypeScript incl. anvil e2e, 16 Playwright incl. accessibility), CI green.

**Outstanding Items**
1. Deploy KursOracle, factory, KursConverter and KursRemit on Portaldot V3 testnet: needs about 1,900 tPOT for Revive storage deposits (measured with eth_estimateGas: ~711 tPOT for the oracle, ~900 for the ink! code). Requested via Discord ticket #1433; currently 9.9 tPOT from the faucet.
2. Relay rounds to Portaldot and Sepolia from the same signatures; regenerate docs/evidence.md with Portaldot tx hashes.
3. Re-record the demo with Portaldot testnet transactions.

**GitHub Repository**
https://github.com/PugarHuda/kurs

**Testnet deployment details**
Ethereum Sepolia (live): KursOracle 0xd3f6bf8e595e815de11598f23170b37341a2cbc3, KursAggregatorFactory 0x126793812e6a9ac8ac4c6368f230b1f87c9fa500, KursConverter 0xa8268109f331dd0b219d424c91c5d3e06c490877. ERC-7412 pull tx 0x9e2aa23575734bba9b24b2ea6d25e9fc414a9b18cf2c3f64e323c3e9b17c405f. Every feed, clone and tx: https://github.com/PugarHuda/kurs/blob/main/docs/evidence.md
Portaldot V3: native reads live (AssetConversionApi via state_call for tPOT/pUSD; Oracle pallet operator set read by the dashboard); contract deployment pending testnet tPOT (see Outstanding Items). Faucet claim to the deployer: 0x2d452d1d…5abdfa89.

**Demo video link**
https://kurs-ten-zeta.vercel.app/kurs-demo.mp4

**Pitch deck link**
https://github.com/PugarHuda/kurs/blob/main/docs/kurs-deck.pdf

**Looking for teammates**
No
