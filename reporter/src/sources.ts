import { createPublicClient, http, parseAbi, type Address } from "viem";
import { sepolia } from "viem/chains";
import type { SourceId } from "./feeds.js";

/** Every source: symbol in -> USD-ish price out, or throw. */
type Fetcher = (symbol: string) => Promise<number>;

const UA = { "user-agent": "kurs-reporter/0.1 (+https://github.com/PugarHuda/kurs)" };

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, headers: { ...UA, ...init?.headers }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const num = (x: unknown): number => {
  const n = typeof x === "string" ? Number(x) : (x as number);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad price ${String(x)}`);
  return n;
};

// ---------------------------------------------------------------- Ethereum Sepolia

export const SEPOLIA_RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const sepoliaClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC, { timeout: 8_000 }) });
const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
/** Chainlink testnet feeds can stall; refuse anything older than this. */
const CHAINLINK_MAX_AGE = 2 * 3600;

// ---------------------------------------------------------------- Portaldot V3 native

export const PORTALDOT_RPC = process.env.PORTALDOT_RPC ?? "https://test-node-v3.portaldot.dev";
const TPOT_DECIMALS = 14;

/** SCALE: NativeOrWithId — 0x00 for native, 0x01 + u32 LE for an asset id. */
function encodeAsset(a: string): string {
  if (a === "native") return "00";
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(a));
  return "01" + b.toString("hex");
}

function u128le(x: bigint): string {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(x & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(x >> 64n, 8);
  return b.toString("hex");
}

async function assetDecimals(id: string): Promise<number> {
  if (id === "native") return TPOT_DECIMALS;
  // ponytail: the two assets Kurs reads today; read Assets.Metadata when this list grows
  const known: Record<string, number> = { "7777": 6, "8801000": 10 };
  const d = known[id];
  if (d === undefined) throw new Error(`unknown decimals for asset ${id}`);
  return d;
}

/**
 * Marginal price of 1 unit of `base` in `quote` from pallet-asset-conversion,
 * read with the runtime API (state_call), no fee: "native:7777" = tPOT in pUSD.
 */
export async function portaldotQuote(spec: string): Promise<number> {
  const [base, quote] = spec.split(":");
  const [bd, qd] = await Promise.all([assetDecimals(base), assetDecimals(quote)]);
  const amount = 10n ** BigInt(bd);
  const params = "0x" + encodeAsset(base) + encodeAsset(quote) + u128le(amount) + "00";
  const r = await getJson(PORTALDOT_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "state_call",
      params: ["AssetConversionApi_quote_price_exact_tokens_for_tokens", params],
    }),
  });
  const hex: string = r.result ?? "";
  if (!hex.startsWith("0x01") || hex.length < 4 + 32) throw new Error(`no pool quote for ${spec}`);
  const le = Buffer.from(hex.slice(4, 36), "hex");
  const out = le.readBigUInt64LE(0) + (le.readBigUInt64LE(8) << 64n);
  return Number(out) / 10 ** qd;
}

// ---------------------------------------------------------------- registry

export const SOURCES: Record<SourceId, Fetcher> = {
  binance: async (s) => num((await getJson(`https://api.binance.com/api/v3/ticker/price?symbol=${s}`)).price),
  coinbase: async (s) => num((await getJson(`https://api.coinbase.com/v2/prices/${s}/spot`)).data.amount),
  kraken: async (s) => {
    const r = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${s}`);
    const first = Object.values(r.result ?? {})[0] as { c: string[] } | undefined;
    return num(first?.c?.[0]);
  },
  okx: async (s) => num((await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${s}`)).data?.[0]?.last),
  coingecko: async (s) => {
    const [id, vs = "usd"] = s.split(":");
    const r = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=${vs}`);
    return num(r[id]?.[vs]);
  },
  coinpaprika: async (s) => num((await getJson(`https://api.coinpaprika.com/v1/tickers/${s}`)).quotes?.USD?.price),
  defillama: async (s) => num((await getJson(`https://coins.llama.fi/prices/current/${s}`)).coins?.[s]?.price),
  "chainlink-sepolia": async (addr) => {
    const [[, answer, , updatedAt], decimals] = await Promise.all([
      sepoliaClient.readContract({ address: addr as Address, abi: aggregatorAbi, functionName: "latestRoundData" }),
      sepoliaClient.readContract({ address: addr as Address, abi: aggregatorAbi, functionName: "decimals" }),
    ]);
    if (Date.now() / 1000 - Number(updatedAt) > CHAINLINK_MAX_AGE) throw new Error(`stale chainlink ${addr}`);
    return num(Number(answer) / 10 ** decimals);
  },
  yahoo: async (s) => {
    const r = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=1d`);
    return num(r.chart?.result?.[0]?.meta?.regularMarketPrice);
  },
  "er-api": async (s) => num((await getJson("https://open.er-api.com/v6/latest/USD")).rates?.[s]),
  "portaldot-assetconversion": portaldotQuote,
};
