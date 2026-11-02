import { defineChain, recoverTypedDataAddress, type Hex, type LocalAccount, type Address } from "viem";
import { foundry, sepolia } from "viem/chains";
import { FEEDS, feedId, type FeedConfig, type SourceId } from "./feeds.js";
import { SOURCES } from "./sources.js";

// ------------------------------------------------------------------ chains

export const portaldotTestnet = defineChain({
  id: 420420777,
  name: "Portaldot V3 Testnet",
  nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
  rpcUrls: { default: { http: [process.env.PORTALDOT_EVM_RPC ?? "https://test-evm-rpc-v3.portaldot.dev"] } },
  blockExplorers: { default: { name: "Portaldot Scanner", url: "https://scanner-testnet-v3.portaldot.dev" } },
});

export const CHAINS = { portaldot: portaldotTestnet, sepolia, local: foundry } as const;
export type ChainKey = keyof typeof CHAINS;

// ------------------------------------------------------------------ EIP-712

/** Must match KursOracle: name/version only, no chainId — the bundle is chain-portable. */
export const DOMAIN = { name: "Kurs", version: "1" } as const;
export const TYPES = {
  Observation: [
    { name: "feedId", type: "bytes32" },
    { name: "roundId", type: "uint80" },
    { name: "answer", type: "int192" },
    { name: "observedAt", type: "uint64" },
  ],
} as const;

export interface SignedObservation {
  reporter: Address;
  feedId: Hex;
  pair: string;
  roundId: bigint;
  answer: bigint;
  observedAt: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/** Rounds are time buckets, so independent reporters agree on roundId without talking. */
export const ROUND_SECONDS = Number(process.env.KURS_ROUND_SECONDS ?? 60);
export const roundOf = (unixSeconds: number) => BigInt(Math.floor(unixSeconds / ROUND_SECONDS));

// ------------------------------------------------------------------ observe

export interface SourceReading {
  source: SourceId;
  price?: number;
  error?: string;
}

export interface FeedReading {
  feed: FeedConfig;
  readings: SourceReading[];
  /** median of the sources that answered, scaled to feed decimals; undefined = abstain */
  answer?: bigint;
}

export function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Drop readings more than `pct` away from the median, so one broken source cannot drag it. */
export function trimOutliers(xs: number[], pct = 0.05): number[] {
  if (xs.length < 3) return xs;
  const m = median(xs);
  return xs.filter((x) => Math.abs(x - m) / m <= pct);
}

export function scale(price: number, decimals: number): bigint {
  // toFixed keeps this exact for the magnitudes we feed (< 1e7 with 8 decimals)
  return BigInt(price.toFixed(decimals).replace(".", ""));
}

export async function readFeed(feed: FeedConfig): Promise<FeedReading> {
  const entries = Object.entries(feed.sources) as [SourceId, string][];
  const readings = await Promise.all(
    entries.map(async ([source, symbol]): Promise<SourceReading> => {
      try {
        return { source, price: await SOURCES[source](symbol) };
      } catch (e) {
        return { source, error: (e as Error).message.slice(0, 120) };
      }
    }),
  );
  const prices = trimOutliers(readings.flatMap((r) => (r.price === undefined ? [] : [r.price])));
  const answer = prices.length >= feed.minSources ? scale(median(prices), feed.decimals) : undefined;
  return { feed, readings, answer };
}

export const readAll = (feeds = FEEDS) => Promise.all(feeds.map(readFeed));

// ------------------------------------------------------------------ sign

export async function sign(
  account: LocalAccount,
  pair: string,
  roundId: bigint,
  answer: bigint,
  observedAt: bigint,
): Promise<SignedObservation> {
  const id = feedId(pair);
  const sig = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "Observation",
    message: { feedId: id, roundId, answer, observedAt },
  });
  return {
    reporter: account.address,
    feedId: id,
    pair,
    roundId,
    answer,
    observedAt,
    r: `0x${sig.slice(2, 66)}`,
    s: `0x${sig.slice(66, 130)}`,
    v: parseInt(sig.slice(130, 132), 16),
  };
}

/** One reporter's view of one tick: sign every feed it could price. */
export async function observeAndSign(account: LocalAccount, readings: FeedReading[], now = Date.now() / 1000) {
  const roundId = roundOf(now);
  const observedAt = BigInt(Math.floor(now));
  const out: SignedObservation[] = [];
  for (const r of readings) {
    if (r.answer === undefined) continue;
    out.push(await sign(account, r.feed.pair, roundId, r.answer, observedAt));
  }
  return out;
}

export const toJson = (o: SignedObservation) => ({
  ...o,
  roundId: o.roundId.toString(),
  answer: o.answer.toString(),
  observedAt: o.observedAt.toString(),
});

export const fromJson = (o: ReturnType<typeof toJson>): SignedObservation => ({
  ...o,
  roundId: BigInt(o.roundId),
  answer: BigInt(o.answer),
  observedAt: BigInt(o.observedAt),
});

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const MAX_FUTURE_SKEW = 300; // matches KursOracle.MAX_FUTURE_SKEW

export interface BundleRules {
  allowed: readonly Address[]; // on-chain reporter set
  maxObservationAge: number; // seconds, from the contract
  maxSpreadBps: number; // from the feed
  now?: number; // unix seconds
}

/**
 * Repeats the contract's checks off-chain so one bad reporter cannot make a
 * whole bundle revert: signature form (v, low-s) and signer, membership,
 * freshness, current/previous round only, one vote per reporter, then trims
 * the observation furthest from the median until the spread fits.
 */
export async function selectBundle(obs: SignedObservation[], rules: BundleRules): Promise<SignedObservation[]> {
  const now = rules.now ?? Math.floor(Date.now() / 1000);
  const allow = new Set(rules.allowed.map((a) => a.toLowerCase()));
  const current = roundOf(now);
  const valid: SignedObservation[] = [];

  for (const o of obs) {
    if (o.v !== 27 && o.v !== 28) continue;
    if (BigInt(o.s) > SECP256K1_HALF_N) continue;
    if (o.roundId !== current && o.roundId !== current - 1n) continue;
    const at = Number(o.observedAt);
    if (at > now + MAX_FUTURE_SKEW || at + rules.maxObservationAge < now) continue;
    try {
      const signer = await recoverTypedDataAddress({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Observation",
        message: { feedId: o.feedId, roundId: o.roundId, answer: o.answer, observedAt: o.observedAt },
        signature: `${o.r}${o.s.slice(2)}${o.v.toString(16).padStart(2, "0")}` as Hex,
      });
      if (signer.toLowerCase() === o.reporter.toLowerCase() && allow.has(signer.toLowerCase())) valid.push(o);
    } catch {
      // malformed signature: drop it
    }
  }

  // one vote per reporter per round; prefer the current round on a tie
  const byRound = new Map<bigint, Map<string, SignedObservation>>();
  for (const o of valid) {
    const m = byRound.get(o.roundId) ?? new Map<string, SignedObservation>();
    if (!m.has(o.reporter.toLowerCase())) m.set(o.reporter.toLowerCase(), o);
    byRound.set(o.roundId, m);
  }
  const best = [...byRound.entries()].sort((a, b) => b[1].size - a[1].size || (a[0] === current ? -1 : 1))[0];
  let bundle = best ? [...best[1].values()].slice(0, 31) : [];

  // drop the observation furthest from the median while the spread is too wide
  while (bundle.length >= 2) {
    const sorted = bundle.map((o) => o.answer).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const m = sorted.length >> 1;
    const med = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2n;
    const abs = med < 0n ? -med : med;
    if ((sorted[sorted.length - 1] - sorted[0]) * 10_000n <= BigInt(rules.maxSpreadBps) * abs) break;
    const dist = (o: SignedObservation) => (o.answer > med ? o.answer - med : med - o.answer);
    const worst = bundle.reduce((w, o) => (dist(o) > dist(w) ? o : w));
    bundle = bundle.filter((o) => o !== worst);
  }
  return bundle;
}
