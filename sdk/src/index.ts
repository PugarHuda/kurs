// kurs-oracle: read Kurs price feeds and pull fresh signed prices (ERC-7412) with viem.
import {
  decodeAbiParameters,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  keccak256,
  parseAbi,
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
import { deployments, kursOracleAbi } from "./generated.js";

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

/** Latest signed round of `pair`, read from the KursOracle contract. */
export async function getPrice(client: PublicClient<Transport, Chain | undefined>, pair: string, opts: { network?: Network } = {}): Promise<Price> {
  const net = networks[networkOf(client, opts.network)];
  const id = feedId(pair);
  const [[roundId, answer, observedAt, updatedAt], feed] = await Promise.all([
    client.readContract({ address: net.oracle, abi: kursOracleAbi, functionName: "latestRound", args: [id] }),
    client.readContract({ address: net.oracle, abi: kursOracleAbi, functionName: "feed", args: [id] }),
  ]);
  if (roundId === 0n) throw new Error(`${pair} has no round yet`);
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
