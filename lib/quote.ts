// On-chain reads and conversions shared by /api/mcp and /api/quote: every number is a
// KursOracle round read live from the chain, with its age.
import { transportFor } from "./rpc.js";
import { createPublicClient, http, keccak256, parseAbi, toBytes, type Address } from "viem";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import sepolia from "../deployments/sepolia.json" with { type: "json" };
import { FEEDS } from "../reporter/src/feeds.js";

export const NETS = {
  portaldot: { d: portaldot, rpc: "https://test-evm-rpc-v3.portaldot.dev" },
  sepolia: { d: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com" },
} as const;
export type Net = keyof typeof NETS;

const abi = parseAbi(["function latestRound(bytes32) view returns (uint80, int192, uint64, uint64)"]);
export const pairs = FEEDS.map((f) => f.pair) as [string, ...string[]];

export async function latest(net: Net, pair: string) {
  const n = NETS[net];
  const f = FEEDS.find((x) => x.pair === pair)!;
  const c = createPublicClient({ transport: transportFor(n.rpc, { retryCount: 2 }) });
  const [roundId, answer, observedAt, updatedAt] = await c.readContract({ address: n.d.oracle as Address, abi, functionName: "latestRound", args: [keccak256(toBytes(pair))] });
  if (roundId === 0n) throw new Error(`${pair} has no round on ${net} yet`);
  const now = Math.floor(Date.now() / 1000);
  return {
    network: net,
    pair,
    price: Number(answer) / 10 ** f.decimals,
    roundId: roundId.toString(),
    observedAt: new Date(Number(observedAt) * 1000).toISOString(),
    updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
    // age of the oldest observation in the round, the contract's latestRoundFresh rule
    ageSeconds: now - Number(observedAt),
    heartbeatSeconds: f.heartbeat,
    // the dashboard's rule: older than 1.5x the heartbeat (Portaldot's slot-aligned relay: at least 64 min)
    stale: now - Number(updatedAt) > 1.5 * Math.max(f.heartbeat, net === "portaldot" ? 3840 : 0),
    oracle: n.d.oracle,
  };
}
export type Latest = Awaited<ReturnType<typeof latest>>;

const legs = FEEDS.map((f) => f.pair.split("/") as [string, string]);
/** canonical spelling of an asset symbol ("tpot" -> "tPOT"), or the input upper-cased if no feed has it */
export const asset = (x: string) => legs.flat().find((a) => a.toUpperCase() === x.trim().toUpperCase()) ?? x.trim().toUpperCase();

/**
 * Units of `to` per one `from`: a direct feed (from/to), its inverse (to/from), or a
 * pivot through USD (from/USD or USD/from, then the same for to). Returns the rounds used.
 */
export async function rate(net: Net, from: string, to: string): Promise<{ rate: number; rounds: Latest[] }> {
  if (from === to) return { rate: 1, rounds: [] };
  if (pairs.includes(`${from}/${to}`)) {
    const r = await latest(net, `${from}/${to}`);
    return { rate: r.price, rounds: [r] };
  }
  if (pairs.includes(`${to}/${from}`)) {
    const r = await latest(net, `${to}/${from}`);
    return { rate: 1 / r.price, rounds: [r] };
  }
  const direct = (a: string, b: string) => pairs.includes(`${a}/${b}`) || pairs.includes(`${b}/${a}`);
  if (from !== "USD" && to !== "USD" && direct(from, "USD") && direct("USD", to)) {
    const [a, b] = await Promise.all([rate(net, from, "USD"), rate(net, "USD", to)]);
    return { rate: a.rate * b.rate, rounds: [...a.rounds, ...b.rounds] };
  }
  throw new QuoteError(`no Kurs feed path from ${from} to ${to}`, 404);
}

/** A refusal the caller should see as is (bad input, no path, too old): `status` is its HTTP code. */
export class QuoteError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** `amount` of `from` in `to`, with every round used. maxAgeSeconds refuses older prices. */
export async function convert(amount: number, from: string, to: string, network: Net, maxAgeSeconds?: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new QuoteError("amount must be a positive finite number", 400);
  const [f, t] = [asset(from), asset(to)];
  const { rate: r, rounds } = await rate(network, f, t);
  const tooOld = maxAgeSeconds === undefined ? [] : rounds.filter((x) => x.ageSeconds > maxAgeSeconds);
  if (tooOld.length)
    throw new QuoteError(
      `refused: ${tooOld.map((x) => `${x.pair} is ${x.ageSeconds}s old`).join(", ")} (maxAgeSeconds ${maxAgeSeconds}). Pull a fresh bundle (/api/bundle or get_signed_bundle).`,
      409,
    );
  const result = amount * r;
  if (!Number.isFinite(result)) throw new QuoteError("result overflows a double; use a smaller amount", 400);
  return {
    amount,
    from: f,
    to: t,
    result,
    rate: r,
    network,
    feedsUsed: rounds.map((x) => ({ pair: x.pair, price: x.price, roundId: x.roundId, ageSeconds: x.ageSeconds, stale: x.stale })),
  };
}
