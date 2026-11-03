# kurs-oracle

Read [Kurs](https://github.com/PugarHuda/kurs) signed price feeds on Portaldot V3 and Ethereum Sepolia with [viem](https://viem.sh), and pull a fresh signed price into your own transaction (ERC-7412) when the on-chain one is stale. ABIs and live contract addresses are included.

```sh
npm i kurs-oracle viem
```

## Read a price

```ts
import { createPublicClient, http } from "viem";
import { networks, getPrice } from "kurs-oracle";

const client = createPublicClient({ chain: networks.portaldot.chain, transport: http() });
const { price, roundId, updatedAt } = await getPrice(client, "USD/IDR"); // network inferred from the chain id
```

Feeds: BTC/USD, ETH/USD, DOT/USD, USDT/USD, USD/IDR, TSLA/USD, NVDA/USD, AAPL/USD, AMZN/USD, META/USD, tPOT/pUSD (`PAIRS`). `feedId(pair)` is `keccak256(pair)`.

## Pull a fresh price (ERC-7412)

Contracts that read Kurs through `latestRoundFresh` revert with `OracleDataRequired` when the price is too old. `writeWithFreshPrice` catches that, fetches a bundle signed by the Kurs reporters, and sends `Multicall3.aggregate3([fulfillOracleQuery(bundle), yourCall])` in one transaction (two transactions where Multicall3 is not deployed, as on Portaldot V3 today).

```ts
import { createWalletClient, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { networks, writeWithFreshPrice, kursConverterAbi } from "kurs-oracle";

const wallet = createWalletClient({ chain: networks.sepolia.chain, transport: http(), account: privateKeyToAccount(PK) });
const hashes = await writeWithFreshPrice(client, wallet, {
  to: networks.sepolia.converter,
  data: encodeFunctionData({ abi: kursConverterAbi, functionName: "convert", args: [10_000n] }), // $100.00 in cents -> Rupiah in sen
});
```

`fetchBundle(pair)` gives the raw signed payload: pass it to `KursOracle.fulfillOracleQuery`, or as an element of `KursPyth.updatePriceFeeds` on a Pyth-style integration.

## Other interfaces, same prices

| ABI export | Contract |
|---|---|
| `kursAggregatorAbi`, `kursAggregatorV2V3Abi` | Chainlink AggregatorV3 / V2 per feed (`networks.*.aggregators`, `aggregatorsV2`) |
| `kursQuoteAbi` | ERC-7726 `getQuote` (`networks.sepolia.quoteOracle`) |
| `kursPythAbi` | Pyth `IPyth` (`networks.sepolia.pyth`) |
| `kursMorphoOracleAbi` | Morpho Blue `IOracle` (`networks.sepolia.morphoOracleBtcIdr`) |

HTTP API, OpenAPI spec and MCP server: https://kurs-ten-zeta.vercel.app/llms.txt

Testnet software. MIT.
