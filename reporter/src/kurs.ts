import { defineChain, encodeAbiParameters, recoverTypedDataAddress, type Hex, type LocalAccount, type Address } from "viem";
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

// Sepolia's base fee swings several-fold within minutes; a 3x headroom keeps
// transactions from sitting in the mempool (unused headroom is never charged).
const sepoliaWithHeadroom = { ...sepolia, fees: { baseFeeMultiplier: 3 } } as const;

export const CHAINS = { portaldot: portaldotTestnet, sepolia: sepoliaWithHeadroom, local: foundry } as const;
export type ChainKey = keyof typeof CHAINS;

// ------------------------------------------------------------------ EIP-712

export { DOMAIN, TYPES } from "./eip712.js";
import { DOMAIN, TYPES } from "./eip712.js";

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
  /** unix seconds when the sources answered; signatures must not claim a later time */
  observedAt?: number;
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
  return { feed, readings, answer, observedAt: Math.floor(Date.now() / 1000) };
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
  const out: SignedObservation[] = [];
  for (const r of readings) {
    if (r.answer === undefined) continue;
    // sign the time the sources answered, not the (possibly later) signing time
    const observedAt = BigInt(Math.floor(Math.min(r.observedAt ?? now, now)));
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
  /** Accept exactly these rounds instead of the current/previous time bucket (slot-aligned relays). */
  rounds?: readonly bigint[];
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
    if (!wellFormed(o)) continue;
    if (BigInt(o.s) > SECP256K1_HALF_N) continue;
    if (rules.rounds ? !rules.rounds.includes(o.roundId) : o.roundId !== current && o.roundId !== current - 1n) continue;
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
  const bundle = best ? [...best[1].values()].slice(0, 31) : [];

  return largestAgreeingWindow(bundle, rules.maxSpreadBps);
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Remote reporters are untrusted: check every field's shape before using it. */
function wellFormed(o: SignedObservation): boolean {
  return (
    (o.v === 27 || o.v === 28) &&
    typeof o.r === "string" &&
    HEX32.test(o.r) &&
    typeof o.s === "string" &&
    HEX32.test(o.s) &&
    typeof o.feedId === "string" &&
    HEX32.test(o.feedId) &&
    typeof o.reporter === "string" &&
    ADDR.test(o.reporter) &&
    typeof o.roundId === "bigint" &&
    typeof o.answer === "bigint" &&
    typeof o.observedAt === "bigint"
  );
}

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const medianOf = (sorted: bigint[]) => {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2n;
};

/**
 * Largest contiguous run of sorted answers whose spread fits maxSpreadBps and
 * that still contains the median of all valid answers. Trimming one value at
 * a time from a moving median would let a coordinated minority walk the
 * result; anchoring on the full-set median cannot. No such run => empty
 * bundle, and the round is skipped.
 */
export function largestAgreeingWindow(obs: SignedObservation[], maxSpreadBps: number): SignedObservation[] {
  if (obs.length === 0) return [];
  const sorted = [...obs].sort((a, b) => cmp(a.answer, b.answer));
  const anchor = medianOf(sorted.map((o) => o.answer));
  let best: [number, number] | undefined; // [start, end) indices
  for (let i = 0; i < sorted.length; i++) {
    for (let j = sorted.length; j > i; j--) {
      if (best && j - i <= best[1] - best[0]) break;
      const lo = sorted[i].answer;
      const hi = sorted[j - 1].answer;
      if (anchor < lo || anchor > hi) continue;
      const mid = medianOf(sorted.slice(i, j).map((o) => o.answer));
      const abs = mid < 0n ? -mid : mid;
      if ((hi - lo) * 10_000n <= BigInt(maxSpreadBps) * abs) {
        best = [i, j];
        break;
      }
    }
  }
  return best ? sorted.slice(best[0], best[1]) : [];
}

/** ERC-7412 payload for KursOracle.fulfillOracleQuery: abi.encode(feedId, roundId, Observation[]). */
export function pullPayload(obs: SignedObservation[]): Hex {
  if (obs.length === 0) throw new Error("empty bundle");
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint80" },
      {
        type: "tuple[]",
        components: [
          { name: "answer", type: "int192" },
          { name: "observedAt", type: "uint64" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    [obs[0].feedId, obs[0].roundId, obs.map((o) => ({ answer: o.answer, observedAt: o.observedAt, v: o.v, r: o.r, s: o.s }))],
  );
}
