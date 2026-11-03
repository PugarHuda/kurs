// Measures what a transmit costs on a chain, split by ring-buffer slot: a round that
// overwrites an existing slot vs one that opens a new slot (new storage deposit on Revive).
// usage: npx tsx scripts/deposit-probe.ts [chain] [pair]
import { encodeFunctionData, formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kursOracleAbi } from "../src/abi.js";
import { clients, loadDeployment } from "../src/chain.js";
import { feedId } from "../src/feeds.js";
import { sign, type ChainKey } from "../src/kurs.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const chain = (process.argv[2] ?? "portaldot") as ChainKey;
const pair = process.argv[3] ?? "ETH/USD";
const d = loadDeployment(chain)!;
const { pub } = clients(chain);
const keys = [1, 2, 3, 4, 5].map((i) => privateKeyToAccount(process.env[`REPORTER_${i}_PK`] as Hex));
const id = feedId(pair);
const [latest, answer] = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "latestRound", args: [id] });
const now = BigInt(Math.floor(Date.now() / 1000));
const gasPrice = await pub.getGasPrice();

async function cost(roundId: bigint) {
  const obs = await Promise.all(keys.map((k) => sign(k, pair, roundId, answer, now)));
  const data = encodeFunctionData({
    abi: kursOracleAbi,
    functionName: "transmit",
    args: [id, roundId, obs.map((o) => ({ answer: o.answer, observedAt: o.observedAt, v: o.v, r: o.r, s: o.s }))],
  });
  const gas = await pub.estimateGas({ account: d.reporters[0], to: d.oracle, data });
  return formatEther(gas * gasPrice);
}

console.log({ chain, pair, latest: latest.toString() });
console.log("overwrite existing slot (round + 64):", await cost(latest + 64n), "tPOT/ETH");
console.log("open a new slot       (round + 1): ", await cost(latest + 1n), "tPOT/ETH");
process.exit(0);
