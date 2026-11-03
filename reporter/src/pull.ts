// ERC-7412 client: call a Kurs consumer; if the oracle answers OracleDataRequired,
// fetch a signed bundle, then send fulfillOracleQuery + the original call together.
import {
  decodeAbiParameters,
  decodeErrorResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from "viem";
import { kursOracleAbi } from "./abi.js";
import { clients, loadDeployment } from "./chain.js";
import { FEEDS, feedId } from "./feeds.js";
import { largestAgreeingWindow, observeAndSign, pullPayload, readFeed, type ChainKey } from "./kurs.js";

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

export interface Bundle {
  pair: string;
  roundId: bigint;
  answer: bigint;
  payload: Hex;
  source: "api" | "local";
}

/** A signed bundle from a Kurs bundle API, or signed here with local reporter keys. */
export async function fetchBundle(pair: string, localKeys: LocalAccount[]): Promise<Bundle> {
  const api = process.env.KURS_BUNDLE_URL;
  if (api) {
    const r = await fetch(`${api.replace(/\/$/, "")}/api/bundle?pair=${encodeURIComponent(pair)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`bundle API ${r.status}: ${await r.text()}`);
    const b = (await r.json()) as { roundId: string; answer: string; payload: Hex };
    if (!/^0x[0-9a-fA-F]+$/.test(b.payload)) throw new Error("bundle API returned no payload");
    return { pair, roundId: BigInt(b.roundId), answer: BigInt(b.answer), payload: b.payload, source: "api" };
  }
  if (localKeys.length === 0) throw new Error("set KURS_BUNDLE_URL or REPORTER_n_PK to obtain a signed bundle");
  const feed = FEEDS.find((f) => f.pair === pair);
  if (!feed) throw new Error(`unknown pair ${pair}`);
  const reading = await readFeed(feed);
  if (reading.answer === undefined) throw new Error(`not enough sources for ${pair}`);
  const signed = (await Promise.all(localKeys.map((k) => observeAndSign(k, [reading])))).flat();
  const bundle = largestAgreeingWindow(signed, feed.maxSpreadBps);
  return { pair, roundId: bundle[0].roundId, answer: reading.answer, payload: pullPayload(bundle), source: "local" };
}

/** Raw revert bytes from a viem error chain, if any. */
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

export interface PullResult {
  pulled?: Bundle;
  batched: boolean;
  hashes: Hex[];
  receipt: TransactionReceipt;
}

/**
 * Sends `data` to `to`. When the call would revert with ERC-7412 OracleDataRequired,
 * pulls a signed bundle and sends multicall(fulfillOracleQuery, call) (or two
 * transactions on chains without Multicall3).
 */
export async function sendWithFreshPrice(
  chain: ChainKey,
  account: LocalAccount,
  to: Address,
  data: Hex,
  localKeys: LocalAccount[],
): Promise<PullResult> {
  const { pub, wallet } = clients(chain, account);
  if (!wallet) throw new Error("no wallet");

  let needed: { oracle: Address; pair: string } | undefined;
  try {
    await pub.call({ account, to, data });
  } catch (e) {
    const raw = revertData(e);
    if (!raw) throw e;
    const err = decodeErrorResult({ abi: kursOracleAbi, data: raw });
    if (err.errorName !== "OracleDataRequired") throw e;
    const [oracle, query] = err.args as [Address, Hex];
    const [fid] = decodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }], query);
    const pair = FEEDS.find((f) => feedId(f.pair) === fid)?.pair;
    if (!pair) throw new Error(`oracle asked for unknown feed ${fid}`);
    needed = { oracle, pair };
  }

  if (!needed) {
    const hash = await wallet.sendTransaction({ to, data, chain: wallet.chain });
    return { batched: false, hashes: [hash], receipt: await pub.waitForTransactionReceipt({ hash, timeout: 180_000 }) };
  }

  const bundle = await fetchBundle(needed.pair, localKeys);
  const fulfill = encodeFunctionData({ abi: kursOracleAbi, functionName: "fulfillOracleQuery", args: [bundle.payload] });
  const hasMulticall = ((await pub.getCode({ address: MULTICALL3 })) ?? "0x") !== "0x";

  if (hasMulticall) {
    const hash = await wallet.writeContract({
      address: MULTICALL3,
      abi: multicallAbi,
      functionName: "aggregate3",
      args: [
        [
          { target: needed.oracle, allowFailure: false, callData: fulfill },
          { target: to, allowFailure: false, callData: data },
        ],
      ],
      chain: wallet.chain,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`multicall reverted ${hash}`);
    return { pulled: bundle, batched: true, hashes: [hash], receipt };
  }

  // no Multicall3 (e.g. Portaldot V3 today): two transactions, fulfil first
  const h1 = await wallet.sendTransaction({ to: needed.oracle, data: fulfill, chain: wallet.chain });
  await pub.waitForTransactionReceipt({ hash: h1, timeout: 180_000 });
  const h2 = await wallet.sendTransaction({ to, data, chain: wallet.chain });
  const receipt = await pub.waitForTransactionReceipt({ hash: h2, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`consumer call reverted ${h2}`);
  return { pulled: bundle, batched: false, hashes: [h1, h2], receipt };
}

export const converterOf = (chain: ChainKey) => {
  const d = loadDeployment(chain);
  if (!d?.converter) throw new Error(`no KursConverter deployed on ${chain}`);
  return d.converter;
};
