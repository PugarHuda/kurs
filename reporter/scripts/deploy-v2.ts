// Deploys one KursAggregatorV2V3 (Chainlink V2 + V3, e.g. for Aave V3's AaveOracle)
// per Kurs feed, checks latestAnswer() against the oracle, and records the addresses.
//   npx tsx scripts/deploy-v2.ts sepolia
// Direct deployments, not clones: fine on Sepolia; on Portaldot a clone factory keeps
// the Revive code deposit at 45 bytes per feed (see KursAggregatorFactory).
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { kursAggregatorV2V3Abi, kursAggregatorV2V3Bytecode, kursOracleAbi } from "../src/abi.js";
import { clients, loadDeployment, type ChainKey } from "../src/chain.js";
import { FEEDS } from "../src/feeds.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const chain = (process.argv[2] ?? "sepolia") as ChainKey;
const d = loadDeployment(chain)!;
const path = new URL(`../../deployments/${chain}.json`, import.meta.url);
const j = JSON.parse(readFileSync(path, "utf8"));
j.aggregatorsV2 ??= {};
const { pub, wallet } = clients(chain, privateKeyToAccount(process.env.DEPLOYER_PK as Hex));

for (const f of FEEDS) {
  const id = keccak256(toBytes(f.pair));
  let agg = j.aggregatorsV2[f.pair] as Address | undefined;
  if (!agg) {
    const hash = await wallet!.deployContract({ abi: kursAggregatorV2V3Abi, bytecode: kursAggregatorV2V3Bytecode, args: [d.oracle, id], chain: wallet!.chain });
    agg = (await pub.waitForTransactionReceipt({ hash, timeout: 300_000 })).contractAddress as Address;
    j.aggregatorsV2[f.pair] = agg;
    writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
  }
  const [answer, [, oracleAnswer]] = await Promise.all([
    pub.readContract({ address: agg, abi: kursAggregatorV2V3Abi, functionName: "latestAnswer" }),
    pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "latestRound", args: [id] }),
  ]);
  console.log(f.pair.padEnd(10), agg, "latestAnswer", answer, answer === oracleAnswer ? "== oracle" : `!= oracle ${oracleAnswer}`);
}
