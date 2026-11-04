// Reads Kurs prices on Portaldot through the Substrate runtime API ReviveApi_call,
// with no EVM RPC involved: what a Polkadot wallet, an off-chain worker or any
// polkadot.js / PAPI client can do with only the node's WebSocket.
import { ApiPromise, WsProvider } from "@polkadot/api";
import { decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Address, type Hex } from "viem";
import { kursOracleAbi } from "./abi.js";

export const PORTALDOT_WS = "wss://test-node-v3.portaldot.dev";
// any account can be the origin of a read-only call; this is the oracle's multisig owner
const ORIGIN = "5EJwTgmFNcafDaMhVEiVZv11wpeWFdNtLTyAMsiHCFFXzPBk";

export interface SubstrateRead {
  pair: string;
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
}

export async function connect(ws = PORTALDOT_WS) {
  return ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
}

/** latestRound(feedId) for each pair via ReviveApi_call, at one block. */
export async function readViaSubstrate(api: ApiPromise, oracle: Address, pairs: string[]) {
  const head = await api.rpc.chain.getHeader();
  const at = await api.at(head.hash);
  const reads: SubstrateRead[] = [];
  const skipped: string[] = [];
  for (const pair of pairs) {
    const data = encodeFunctionData({ abi: kursOracleAbi, functionName: "latestRound", args: [keccak256(toBytes(pair))] });
    // origin, dest, value, gas_limit (None = max), storage_deposit_limit (None), input
    const res = (await (at.call as any).reviveApi.call(ORIGIN, oracle, 0, null, null, data)).toJSON() as {
      result: { ok?: { flags: number; data: Hex }; err?: unknown };
    };
    if (!res.result.ok) throw new Error(`${pair}: ReviveApi_call failed ${JSON.stringify(res.result.err)}`);
    // reverted: UnknownFeed, a feed listed in feeds.ts that this oracle's owner has not configured yet
    if (res.result.ok.flags & 1) {
      skipped.push(pair);
      continue;
    }
    const [roundId, answer, , updatedAt] = decodeFunctionResult({
      abi: kursOracleAbi,
      functionName: "latestRound",
      data: res.result.ok.data,
    }) as readonly [bigint, bigint, bigint, bigint];
    reads.push({ pair, roundId, answer, updatedAt });
  }
  return { block: head.number.toNumber(), blockHash: head.hash.toHex(), reads, skipped };
}
