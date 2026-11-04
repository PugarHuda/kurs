// Deploys the global-FX views of Kurs on Sepolia and reads each against the live oracle:
//   KursFeedRegistry   Chainlink Feed Registry: latestRoundData(base, quote) with Denominations
//   KursQuoteOracle v3 ERC-7726 / Euler IPriceOracle over crypto, FX majors and gold (v2, BTC/ETH/IDR
//                      only, stays live as quoteOracleV2: KursSiloOracle was built on it)
//   npx tsx scripts/deploy-global.ts > ../docs/global-sepolia.txt
import { formatEther, formatUnits, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import * as A from "../src/abi.js";
import { clients } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const path = new URL("../../deployments/sepolia.json", import.meta.url);
const j = JSON.parse(readFileSync(path, "utf8"));
const save = () => writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
const { pub, wallet } = clients("sepolia", privateKeyToAccount(process.env.DEPLOYER_PK as Hex));
const fid = (p: string) => keccak256(toBytes(p));
const iso = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address; // ISO 4217 numeric code
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const BTC = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" as Address;
const [USD, EUR, GBP, JPY, CNY, IDR, XAU] = [840, 978, 826, 392, 156, 360, 959].map(iso);

async function deploy(key: string, abi: any, bytecode: Hex, args: readonly unknown[]): Promise<Address> {
  if (j[key]) return j[key];
  const hash = await wallet!.deployContract({ abi, bytecode, args, chain: wallet!.chain });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  j[key] = rc.contractAddress;
  j.txs[`deploy ${key}`] = hash;
  save();
  console.error(key, rc.contractAddress, hash, `paid ${formatEther(rc.gasUsed * rc.effectiveGasPrice)}`);
  return rc.contractAddress as Address;
}

// [base, quote, pair, base decimals, quote decimals] (ERC-7726: fiat and gold 18, BTC 8, ETH 18)
const table: [Address, Address, string, number, number][] = [
  [BTC, USD, "BTC/USD", 8, 18],
  [ETH, USD, "ETH/USD", 18, 18],
  [EUR, USD, "EUR/USD", 18, 18],
  [GBP, USD, "GBP/USD", 18, 18],
  [XAU, USD, "XAU/USD", 18, 18],
  [USD, JPY, "USD/JPY", 18, 18],
  [USD, CNY, "USD/CNY", 18, 18],
  [USD, IDR, "USD/IDR", 18, 18],
];
const registry = await deploy("feedRegistry", A.kursFeedRegistryAbi, A.kursFeedRegistryBytecode, [j.factory, table.map((t) => t[0]), table.map((t) => t[1]), table.map((t) => fid(t[2]))]);
if (!j.quoteOracleV2 && j.quoteOracle) {
  j.quoteOracleV2 = j.quoteOracle;
  delete j.quoteOracle;
  save();
}
const quote = await deploy("quoteOracle", A.kursQuoteAbi, A.kursQuoteBytecode, [j.oracle, 7200, table.map((t) => t[0]), table.map((t) => t[1]), table.map((t) => fid(t[2])), table.map((t) => t[3]), table.map((t) => t[4])]);

await new Promise((r) => setTimeout(r, 15_000)); // load-balanced RPC
const r = (address: Address, abi: any, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args }).catch((e: any) => {
    const d = e?.walk?.((x: any) => x?.data?.errorName)?.data;
    return d ? `revert ${d.errorName}(${(d.args ?? []).join(", ")})` : `revert: ${(e as Error).message.split("\n")[0]}`;
  }) as Promise<any>;
const block = await pub.getBlock();
console.log(`# Kurs global FX views on sepolia, read at block ${block.number} (${new Date(Number(block.timestamp) * 1000).toISOString()})`);
console.log(`oracle ${j.oracle}\n\nChainlink Feed Registry  KursFeedRegistry ${registry}`);
for (const [b, q, pair] of table) {
  const [, answer, , updatedAt] = await r(registry, A.kursFeedRegistryAbi, "latestRoundData", [b, q]);
  console.log(`  latestRoundData(${pair.split("/")[0]}, ${pair.split("/")[1]}) = ${formatUnits(answer, 8)} updated ${new Date(Number(updatedAt) * 1000).toISOString()}`);
}
console.log(`  latestRoundData(USD, EUR) = ${await r(registry, A.kursFeedRegistryAbi, "latestRoundData", [USD, EUR])}  (only the feed's own direction, as Chainlink)`);
console.log(`\nERC-7726 / Euler  KursQuoteOracle v3 ${quote}`);
for (const [amt, b, q, label] of [
  [100n * 10n ** 18n, EUR, JPY, "100 EUR in JPY"],
  [100n * 10n ** 18n, GBP, EUR, "100 GBP in EUR"],
  [10n ** 18n, XAU, EUR, "1 oz gold in EUR"],
  [10n ** 8n, BTC, JPY, "1 BTC in JPY"],
  [10_000n * 10n ** 18n, CNY, USD, "10,000 CNY in USD"],
] as const) {
  const v = await r(quote, A.kursQuoteAbi, "getQuote", [amt, b, q]);
  console.log(`  getQuote ${label.padEnd(18)} = ${typeof v === "bigint" ? Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 }) : v}`);
}
