import { keccak256, toBytes, type Hex } from "viem";

/** A source returns a price as a float, or throws. */
export type SourceId =
  | "binance"
  | "coinbase"
  | "kraken"
  | "okx"
  | "coingecko"
  | "coinpaprika"
  | "defillama"
  | "chainlink-sepolia"
  | "yahoo"
  | "er-api"
  | "frankfurter"
  | "fawaz-fx"
  | "nasdaq"
  | "tradingview"
  | "portaldot-assetconversion";

export interface FeedConfig {
  pair: string; // "ETH/USD" — feedId = keccak256(pair)
  description: string;
  decimals: number;
  heartbeat: number; // seconds: transmit at least this often
  deviationBps: number; // transmit early when price moves this much
  maxSpreadBps: number; // contract rejects bundles whose reporters disagree more
  minAnswer: bigint;
  maxAnswer: bigint;
  minSources: number; // a reporter abstains if fewer sources answered
  sources: Partial<Record<SourceId, string>>; // source -> symbol/id in that source
}

const d8 = (x: number) => BigInt(Math.round(x * 1e8));

export const FEEDS: FeedConfig[] = [
  {
    pair: "BTC/USD",
    description: "BTC / USD",
    decimals: 8,
    heartbeat: 3600,
    deviationBps: 50,
    maxSpreadBps: 100,
    minAnswer: d8(1_000),
    maxAnswer: d8(10_000_000),
    minSources: 2,
    sources: {
      binance: "BTCUSDT",
      coinbase: "BTC-USD",
      kraken: "XBTUSD",
      okx: "BTC-USDT",
      coingecko: "bitcoin",
      coinpaprika: "btc-bitcoin",
      defillama: "coingecko:bitcoin",
      "chainlink-sepolia": "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43",
    },
  },
  {
    pair: "ETH/USD",
    description: "ETH / USD",
    decimals: 8,
    heartbeat: 3600,
    deviationBps: 50,
    maxSpreadBps: 100,
    minAnswer: d8(10),
    maxAnswer: d8(1_000_000),
    minSources: 2,
    sources: {
      binance: "ETHUSDT",
      coinbase: "ETH-USD",
      kraken: "ETHUSD",
      okx: "ETH-USDT",
      coingecko: "ethereum",
      coinpaprika: "eth-ethereum",
      defillama: "coingecko:ethereum",
      "chainlink-sepolia": "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    },
  },
  {
    pair: "DOT/USD",
    description: "DOT / USD",
    decimals: 8,
    heartbeat: 3600,
    deviationBps: 100,
    maxSpreadBps: 200,
    minAnswer: d8(0.01),
    maxAnswer: d8(10_000),
    minSources: 2,
    sources: {
      binance: "DOTUSDT",
      coinbase: "DOT-USD",
      kraken: "DOTUSD",
      okx: "DOT-USDT",
      coingecko: "polkadot",
      coinpaprika: "dot-polkadot",
      defillama: "coingecko:polkadot",
    },
  },
  {
    pair: "USDT/USD",
    description: "USDT / USD",
    decimals: 8,
    heartbeat: 3600,
    deviationBps: 25,
    maxSpreadBps: 50,
    minAnswer: d8(0.5),
    maxAnswer: d8(2),
    minSources: 2,
    sources: {
      coinbase: "USDT-USD",
      kraken: "USDTZUSD",
      coingecko: "tether",
      coinpaprika: "usdt-tether",
      defillama: "coingecko:tether",
    },
  },
  {
    pair: "USD/IDR",
    description: "USD / IDR (Rupiah)",
    decimals: 8,
    heartbeat: 3600,
    deviationBps: 25,
    maxSpreadBps: 100,
    minAnswer: d8(1_000),
    maxAnswer: d8(100_000),
    minSources: 2,
    sources: { "er-api": "IDR", yahoo: "IDR=X", coingecko: "tether:idr", frankfurter: "IDR", "fawaz-fx": "idr" },
  },
  // Tokenised stocks already trade in AssetConversion pools on Portaldot V3
  // (TSLA, NVDA, AAPL, AMZN, META against DUCAT) with no reference price.
  ...(["TSLA", "NVDA", "AAPL", "AMZN", "META"] as const).map(
    (s): FeedConfig => ({
      pair: `${s}/USD`,
      description: `${s} / USD (equity)`,
      decimals: 8,
      // ponytail: US markets are closed ~70% of the week, so an unchanged quote is pushed at
      // most every 4 h (each Portaldot round costs tPOT); a 0.25% move still goes out on the
      // next hourly tick. Market-hours-aware scheduling if this ever needs to be tighter.
      heartbeat: 4 * 3600,
      deviationBps: 25,
      maxSpreadBps: 100,
      minAnswer: d8(1),
      maxAnswer: d8(100_000),
      minSources: 2, // three independent public quotes; a reporter abstains if fewer than two answer
      sources: { yahoo: s, nasdaq: s, tradingview: `NASDAQ:${s}` },
    }),
  ),
  // Native Portaldot price: tPOT quoted in pUSD by the runtime's own DEX
  // (pallet-asset-conversion). This is the feed Kurs exports to other chains.
  // One AMM is one source: it is sampled over ~20 min of blocks, thin pools
  // are refused, and the 50% bounds stop a pushed pool from jumping the feed.
  {
    pair: "tPOT/pUSD",
    description: "tPOT / pUSD (Portaldot AssetConversion)",
    decimals: 8,
    heartbeat: 3600,
    deviationBps: 100,
    maxSpreadBps: 100,
    minAnswer: d8(0.1),
    maxAnswer: d8(10),
    minSources: 1,
    sources: { "portaldot-assetconversion": "native:7777" },
  },
];

export const feedId = (pair: string): Hex => keccak256(toBytes(pair));

/** The feed for user input: case-insensitive, "/", "-" or "_" between the assets
 * ("usd-idr", "BTC_USD"). The canonical spelling is f.pair; feedId uses only that. */
export const findFeed = (input: string | null | undefined): FeedConfig | undefined => {
  const k = (input ?? "").trim().toUpperCase().replace(/[-_]/g, "/");
  return FEEDS.find((f) => f.pair.toUpperCase() === k);
};
