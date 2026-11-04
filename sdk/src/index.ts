// kurs-oracle: read Kurs price feeds and pull fresh signed prices (ERC-7412) with viem.
import {
  decodeAbiParameters,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  toBytes,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { sepolia } from "viem/chains";
import { deployments, kursOracleAbi, kursTwapAbi } from "./generated.js";

export * from "./generated.js";

export const portaldotTestnet: Chain = defineChain({
  id: 420420777,
  name: "Portaldot V3 Testnet",
  nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
  rpcUrls: { default: { http: ["https://test-evm-rpc-v3.portaldot.dev"] } },
});

export const networks: {
  portaldot: { chain: Chain } & typeof deployments.portaldot;
  sepolia: { chain: Chain } & typeof deployments.sepolia;
} = {
  portaldot: { chain: portaldotTestnet, ...deployments.portaldot },
  sepolia: { chain: sepolia, ...deployments.sepolia },
};
export type Network = keyof typeof networks;

/** Public Kurs HTTP API (signed bundles, history, health). */
export const DEFAULT_API = "https://kurs-ten-zeta.vercel.app";

export const PAIRS = Object.keys(deployments.sepolia.aggregators) as (keyof typeof deployments.sepolia.aggregators)[];
export type Pair = (typeof PAIRS)[number];

/** Kurs feed id: keccak256 of the pair string, e.g. feedId("USD/IDR"). */
export const feedId = (pair: string): Hex => keccak256(toBytes(pair));

const networkOf = (client: PublicClient<Transport, Chain | undefined>, network?: Network): Network => {
  if (network) return network;
  const id = client.chain?.id;
  const n = (Object.keys(networks) as Network[]).find((k) => networks[k].chainId === id);
  if (!n) throw new Error(`Kurs is not deployed on chain ${id}; pass { network }`);
  return n;
};

export interface Price {
  pair: string;
  /** decimal price, e.g. 18140 for USD/IDR */
  price: number;
  answer: bigint;
  decimals: number;
  roundId: bigint;
  /** oldest observation in the round (unix seconds) */
  observedAt: number;
  /** block time the round landed (unix seconds) */
  updatedAt: number;
}

/** Thrown by getPrice({ maxAge }) when the newest observation is older than maxAge. */
export class StalePriceError extends Error {
  constructor(public pair: string, public ageSeconds: number, public maxAge: number) {
    super(`${pair} is ${ageSeconds}s old, older than maxAge ${maxAge}s`);
    this.name = "StalePriceError";
  }
}

/**
 * Latest signed round of `pair`, read from the KursOracle contract. With `maxAge`
 * (seconds) it throws StalePriceError when the oldest observation in the round is older,
 * the same rule as the contract's latestRoundFresh.
 */
export async function getPrice(client: PublicClient<Transport, Chain | undefined>, pair: string, opts: { network?: Network; maxAge?: number } = {}): Promise<Price> {
  const net = networks[networkOf(client, opts.network)];
  const id = feedId(pair);
  const [[roundId, answer, observedAt, updatedAt], feed] = await Promise.all([
    client.readContract({ address: net.oracle, abi: kursOracleAbi, functionName: "latestRound", args: [id] }),
    client.readContract({ address: net.oracle, abi: kursOracleAbi, functionName: "feed", args: [id] }),
  ]);
  if (roundId === 0n) throw new Error(`${pair} has no round yet`);
  if (opts.maxAge !== undefined) {
    const age = Math.floor(Date.now() / 1000) - Number(observedAt);
    if (age > opts.maxAge) throw new StalePriceError(pair, age, opts.maxAge);
  }
  return { pair, price: Number(answer) / 10 ** feed.decimals, answer, decimals: feed.decimals, roundId, observedAt: Number(observedAt), updatedAt: Number(updatedAt) };
}

export interface Bundle {
  pair: string;
  roundId: bigint;
  answer: bigint;
  /** argument for KursOracle.fulfillOracleQuery, or one element of KursPyth.updatePriceFeeds */
  payload: Hex;
}

/** A fresh observation bundle signed by the Kurs reporters. Verifies on every chain running Kurs. */
export async function fetchBundle(pair: string, opts: { api?: string; signal?: AbortSignal } = {}): Promise<Bundle> {
  const r = await fetch(`${(opts.api ?? DEFAULT_API).replace(/\/$/, "")}/api/bundle?pair=${encodeURIComponent(pair)}`, { signal: opts.signal ?? AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`bundle API ${r.status}: ${await r.text()}`);
  const b = (await r.json()) as { roundId: string; answer: string; payload: Hex };
  if (!/^0x[0-9a-fA-F]+$/.test(b.payload ?? "")) throw new Error("bundle API returned no payload");
  return { pair, roundId: BigInt(b.roundId), answer: BigInt(b.answer), payload: b.payload };
}

/** EIP-712 domain and type the reporters sign. No chainId: one bundle verifies on every chain. */
export const DOMAIN = { name: "Kurs", version: "1" } as const;
export const TYPES = {
  Observation: [
    { name: "feedId", type: "bytes32" },
    { name: "roundId", type: "uint80" },
    { name: "answer", type: "int192" },
    { name: "observedAt", type: "uint64" },
  ],
} as const;

const payloadParams = [
  { type: "bytes32" },
  { type: "uint80" },
  { type: "tuple[]", components: [{ name: "answer", type: "int192" }, { name: "observedAt", type: "uint64" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
] as const;

export interface BundleCheck {
  /** at least `quorum` distinct current reporters signed this round */
  ok: boolean;
  pair: string | undefined;
  feedId: Hex;
  roundId: bigint;
  quorum: number;
  /** the oracle's current reporter set on this network */
  reporters: readonly Address[];
  observations: { signer: Address; answer: bigint; observedAt: number; isReporter: boolean }[];
  /** median of the answers signed by distinct current reporters, as the contract computes it */
  median: bigint | undefined;
}

/**
 * Checks a signed bundle without trusting the API that served it: recovers every
 * EIP-712 signer and compares them with the reporter set and quorum read from the
 * oracle on chain. It does not check freshness or the spread limit; the contract does
 * that when the bundle is submitted.
 */
export async function verifyBundle(client: PublicClient<Transport, Chain | undefined>, bundle: Bundle | Hex, opts: { network?: Network } = {}): Promise<BundleCheck> {
  const net = networks[networkOf(client, opts.network)];
  const payload = typeof bundle === "string" ? bundle : bundle.payload;
  const [id, roundId, obs] = decodeAbiParameters(payloadParams, payload);
  const [reporters, quorum] = await Promise.all([
    client.readContract({ address: net.oracle, abi: kursOracleAbi, functionName: "reporters" }),
    client.readContract({ address: net.oracle, abi: kursOracleAbi, functionName: "quorum" }),
  ]);
  const set = new Set(reporters.map((r) => r.toLowerCase()));
  const observations = await Promise.all(
    obs.map(async (o) => {
      const signer = await recoverTypedDataAddress({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Observation",
        message: { feedId: id, roundId, answer: o.answer, observedAt: o.observedAt },
        signature: `${o.r}${o.s.slice(2)}${o.v.toString(16).padStart(2, "0")}` as Hex,
      });
      return { signer, answer: o.answer, observedAt: Number(o.observedAt), isReporter: set.has(signer.toLowerCase()) };
    }),
  );
  const seen = new Set<string>();
  const valid = observations.filter((o) => o.isReporter && !seen.has(o.signer.toLowerCase()) && seen.add(o.signer.toLowerCase()));
  const a = valid.map((o) => o.answer).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const m = a.length >> 1;
  const median = a.length === 0 ? undefined : a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2n;
  return { ok: valid.length >= quorum, pair: PAIRS.find((p) => feedId(p) === id), feedId: id, roundId, quorum, reporters, observations, median };
}

/**
 * Time-weighted average of `pair` over the last `window` seconds from its KursTwap
 * contract (Sepolia: BTC/USD and USD/IDR). Reverts on chain when the TWAP's history
 * does not reach back that far.
 */
export async function getTwap(client: PublicClient<Transport, Chain | undefined>, pair: string, window: number, opts: { network?: Network } = {}) {
  const net = networks[networkOf(client, opts.network)] as { oracle: Address; twap?: Record<string, Address> };
  const address = net.twap?.[pair];
  if (!address) throw new Error(`no KursTwap for ${pair} on this network`);
  const [answer, oldest, feed] = await Promise.all([
    client.readContract({ address, abi: kursTwapAbi, functionName: "consult", args: [window] }),
    client.readContract({ address, abi: kursTwapAbi, functionName: "oldest" }),
    client.readContract({ address: net.oracle, abi: kursOracleAbi, functionName: "feed", args: [feedId(pair)] }),
  ]);
  return { pair, window, answer, price: Number(answer) / 10 ** feed.decimals, oldest: Number(oldest), twap: address };
}

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

function revertData(e: unknown): Hex | undefined {
  let cur: any = e;
  for (let i = 0; cur && i < 12; i++) {
    for (const k of ["data", "raw"]) {
      const v = cur[k];
      if (typeof v === "string" && v.startsWith("0x") && v.length >= 10) return v as Hex;
      if (v && typeof v === "object" && typeof v.data === "string" && v.data.startsWith("0x")) return v.data as Hex;
    }
    cur = cur.cause;
  }
  return undefined;
}

/**
 * The feed a call needs, if it would revert with ERC-7412 OracleDataRequired; undefined
 * if the call succeeds as is. Other reverts are rethrown.
 */
export async function requiredFeed(client: PublicClient<Transport, Chain | undefined>, call: { account?: Address; to: Address; data: Hex }) {
  try {
    await client.call(call);
    return undefined;
  } catch (e) {
    const raw = revertData(e);
    if (!raw) throw e;
    let err;
    try {
      err = decodeErrorResult({ abi: kursOracleAbi, data: raw });
    } catch {
      throw e;
    }
    if (err.errorName !== "OracleDataRequired") throw e;
    const [oracle, query] = err.args as readonly [Address, Hex];
    const [id, maxAge] = decodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }], query);
    const pair = PAIRS.find((p) => feedId(p) === id);
    if (!pair) throw new Error(`oracle asked for unknown feed ${id}`);
    return { oracle, pair, maxAge };
  }
}

/**
 * ERC-7412 in one call: sends `data` to `to`; if a Kurs price it reads is stale, pulls a
 * signed bundle and sends Multicall3.aggregate3([fulfillOracleQuery, your call]) instead,
 * or two transactions where Multicall3 is not deployed (Portaldot V3 today).
 * Returns the transaction hashes.
 */
export async function writeWithFreshPrice(
  client: PublicClient<Transport, Chain | undefined>,
  wallet: WalletClient<Transport, Chain, Account>,
  call: { to: Address; data: Hex },
  opts: { api?: string } = {},
): Promise<Hex[]> {
  const need = await requiredFeed(client, { account: wallet.account.address, ...call });
  if (!need) return [await wallet.sendTransaction({ ...call, chain: wallet.chain, account: wallet.account })];
  const bundle = await fetchBundle(need.pair, opts);
  const fulfill = encodeFunctionData({ abi: kursOracleAbi, functionName: "fulfillOracleQuery", args: [bundle.payload] });
  if (((await client.getCode({ address: MULTICALL3 })) ?? "0x") !== "0x") {
    const hash = await wallet.writeContract({
      address: MULTICALL3,
      abi: multicallAbi,
      functionName: "aggregate3",
      args: [[{ target: need.oracle, allowFailure: false, callData: fulfill }, { target: call.to, allowFailure: false, callData: call.data }]],
      chain: wallet.chain,
      account: wallet.account,
    });
    return [hash];
  }
  const h1 = await wallet.sendTransaction({ to: need.oracle, data: fulfill, chain: wallet.chain, account: wallet.account });
  await client.waitForTransactionReceipt({ hash: h1 });
  const h2 = await wallet.sendTransaction({ ...call, chain: wallet.chain, account: wallet.account });
  return [h1, h2];
}
