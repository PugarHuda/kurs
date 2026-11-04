// Deploys the lending-protocol views of Kurs on Sepolia and reads each against the live oracle:
//   KursQuoteOracle v2: ERC-7726 + Euler IPriceOracle (name, getQuotes), replacing v1 as "quoteOracle"
//   KursSiloOracle:     Silo v2 ISiloOracle, collateral priced in IDR
//   KursTwap:           time-weighted average (Uniswap v3 observe/consult style) for BTC/USD and USD/IDR,
//                       poked by the relay after every round
//   npx tsx scripts/deploy-lending.ts sepolia > ../docs/lending-sepolia.txt
// Resumable: addresses and txs go to deployments/<chain>.json.
import { formatEther, formatUnits, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import * as A from "../src/abi.js";
import { clients, type ChainKey } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const chain = (process.argv[2] ?? "sepolia") as ChainKey;
const path = new URL(`../../deployments/${chain}.json`, import.meta.url);
const j = JSON.parse(readFileSync(path, "utf8"));
const save = () => writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
const { pub, wallet } = clients(chain, privateKeyToAccount(process.env.DEPLOYER_PK as Hex));
const fid = (p: string) => keccak256(toBytes(p));

async function deploy(key: string, abi: any, bytecode: Hex, args: readonly unknown[]): Promise<Address> {
  const [k1, k2] = key.split(".");
  const have = k2 ? j[k1]?.[k2] : j[k1];
  if (have) return have;
  const hash = await wallet!.deployContract({ abi, bytecode, args, chain: wallet!.chain });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (k2) (j[k1] ??= {})[k2] = rc.contractAddress;
  else j[k1] = rc.contractAddress;
  j.txs[`deploy ${key}`] = hash;
  save();
  console.error(key, rc.contractAddress, hash, `paid ${formatEther(rc.gasUsed * rc.effectiveGasPrice)}`);
  return rc.contractAddress as Address;
}

const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const BTC = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" as Address;
const USD = "0x0000000000000000000000000000000000000348" as Address; // ISO 4217 840
const IDR = "0x0000000000000000000000000000000000000168" as Address; // ISO 4217 360

// v1 (ERC-7726 only) stays live for KursMorphoOracle, which was built on it
if (j.quoteOracle && !j.quoteOracleV1) {
  j.quoteOracleV1 = j.quoteOracle;
  delete j.quoteOracle;
  save();
}
const quote = await deploy("quoteOracle", A.kursQuoteAbi, A.kursQuoteBytecode, [
  j.oracle, 7200, [BTC, ETH, USD], [USD, USD, IDR], [fid("BTC/USD"), fid("ETH/USD"), fid("USD/IDR")], [8, 18, 18], [18, 18, 18],
]);
const silo = await deploy("siloOracle", A.kursSiloOracleAbi, A.kursSiloOracleBytecode, [quote, IDR]);
const twap: Record<string, Address> = {};
for (const p of ["BTC/USD", "USD/IDR"]) twap[p] = await deploy(`twap.${p}`, A.kursTwapAbi, A.kursTwapBytecode, [j.oracle, p]);
for (const [p, a] of Object.entries(twap)) {
  const { result } = await pub.simulateContract({ account: wallet!.account, address: a, abi: A.kursTwapAbi, functionName: "poke" });
  if (!result) continue;
  const hash = await wallet!.writeContract({ address: a, abi: A.kursTwapAbi, functionName: "poke", chain: wallet!.chain, account: wallet!.account! });
  await pub.waitForTransactionReceipt({ hash });
  j.txs[`poke twap ${p}`] = hash;
  save();
}

// the public Sepolia RPC is load-balanced: give every backend time to see the pokes
await new Promise((res) => setTimeout(res, 15_000));
const r = (address: Address, abi: any, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args }).catch((e: any) => {
    const d = e?.walk?.((x: any) => x?.data?.errorName)?.data;
    return d ? `revert ${d.errorName}(${(d.args ?? []).join(", ")})` : `revert: ${(e as Error).message.split("\n")[0]}`;
  }) as Promise<any>;
const t = (s: bigint | number) => new Date(Number(s) * 1000).toISOString();
const block = await pub.getBlock();
console.log(`# Kurs lending-protocol views on ${chain}, read at block ${block.number} (${t(block.timestamp)})`);
console.log(`oracle ${j.oracle}\n`);

console.log(`Euler IPriceOracle / ERC-7726  KursQuoteOracle ${quote}`);
console.log(`  name() = "${await r(quote, A.kursQuoteAbi, "name")}"`);
const [bid, ask] = await r(quote, A.kursQuoteAbi, "getQuotes", [10n ** 8n, BTC, IDR]);
console.log(`  getQuotes(1e8, BTC, IDR) = (${bid}, ${ask})  -> 1 BTC = Rp ${Number(formatUnits(bid, 18)).toLocaleString("en-US")} (bid == ask)`);
const eth = await r(quote, A.kursQuoteAbi, "getQuote", [10n ** 24n, IDR, ETH]);
console.log(`  getQuote(1e24, IDR, ETH) = ${eth}  -> Rp 1,000,000 = ${formatUnits(eth, 18)} ETH`);

console.log(`\nSilo v2 ISiloOracle  KursSiloOracle ${silo}  (quoteToken IDR)`);
console.log(`  quoteToken() = ${await r(silo, A.kursSiloOracleAbi, "quoteToken")}`);
const sq = await r(silo, A.kursSiloOracleAbi, "quote", [10n ** 8n, BTC]);
console.log(`  quote(1e8, BTC) = ${sq}  -> 1 BTC collateral = Rp ${Number(formatUnits(sq, 18)).toLocaleString("en-US")}`);

for (const [p, a] of Object.entries(twap)) {
  const [count, oldest, last] = await Promise.all([r(a, A.kursTwapAbi, "count"), r(a, A.kursTwapAbi, "oldest"), r(a, A.kursTwapAbi, "lastRoundId")]);
  console.log(`\nTWAP ${p}  KursTwap ${a}`);
  console.log(`  count() = ${count}, lastRoundId() = ${last}, oldest() = ${typeof oldest === "bigint" ? t(oldest) : oldest}`);
  for (const w of [600, 3600]) {
    const v = await r(a, A.kursTwapAbi, "consult", [w]);
    console.log(`  consult(${w}) = ${typeof v === "bigint" ? `${v}  -> ${formatUnits(v, 8)}` : v}`);
  }
}
