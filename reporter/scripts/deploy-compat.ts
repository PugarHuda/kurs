// Deploys the DIA, Band, API3, Chronicle and Aave v3 views of Kurs and reads each one
// against the live oracle, printing what an integrator of that protocol would see.
//   npx tsx scripts/deploy-compat.ts sepolia > ../docs/compat-sepolia.txt
// Resumable: addresses and txs go to deployments/<chain>.json.
import { formatEther, keccak256, toBytes, type Address, type Hex } from "viem";
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

// Aave asset keys: the ERC-7726 BTC identifier and IDR's ISO 4217 code stand in for a
// WBTC and a Rupiah-stablecoin token address (a fork sets its own token addresses).
const BTC = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" as Address;
const IDR = "0x0000000000000000000000000000000000000168" as Address;

const dia = await deploy("dia", A.kursDiaAbi, A.kursDiaBytecode, [j.oracle]);
const band = await deploy("band", A.kursBandAbi, A.kursBandBytecode, [j.oracle]);
const api3: Record<string, Address> = {};
for (const p of ["BTC/USD", "USD/IDR"]) api3[p] = await deploy(`api3.${p}`, A.kursApi3Abi, A.kursApi3Bytecode, [j.oracle, fid(p)]);
const chronicle = await deploy("chronicle.BTC/USD", A.kursChronicleAbi, A.kursChronicleBytecode, [j.oracle, "BTC/USD"]);
const aave = await deploy("aaveOracle", A.kursAaveOracleAbi, A.kursAaveOracleBytecode, [j.oracle, 7200, [BTC, IDR], [fid("BTC/USD"), fid("USD/IDR")], [false, true]]);

const r = (address: Address, abi: any, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args }) as Promise<any>;
const t = (s: bigint | number) => new Date(Number(s) * 1000).toISOString();
const block = await pub.getBlock();
console.log(`# Kurs protocol-compatible views on ${chain}, read at block ${block.number} (${t(block.timestamp)})`);
console.log(`oracle ${j.oracle}\n`);

const [dv, dt] = await r(dia, A.kursDiaAbi, "getValue", ["BTC/USD"]);
console.log(`DIA ${dia}\n  getValue("BTC/USD") = (${dv}, ${dt})  -> $${Number(dv) / 1e8} observed ${t(dt)}`);
const [iv, it] = await r(dia, A.kursDiaAbi, "getValue", ["USD/IDR"]);
console.log(`  getValue("USD/IDR") = (${iv}, ${it})  -> Rp ${Number(iv) / 1e8}`);

const bd = await r(band, A.kursBandAbi, "getReferenceData", ["BTC", "IDR"]);
console.log(`\nBand ${band}\n  getReferenceData("BTC","IDR").rate = ${bd.rate}  -> 1 BTC = Rp ${(Number(bd.rate) / 1e18).toLocaleString("en-US")}`);
console.log(`  lastUpdatedBase ${t(bd.lastUpdatedBase)}, lastUpdatedQuote ${t(bd.lastUpdatedQuote)}`);
const bulk = await r(band, A.kursBandAbi, "getReferenceDataBulk", [["ETH", "DOT"], ["USD", "IDR"]]);
console.log(`  getReferenceDataBulk(["ETH","DOT"],["USD","IDR"]) = ${bulk.map((x: any) => (Number(x.rate) / 1e18).toFixed(4)).join(", ")}`);

for (const [p, a] of Object.entries(api3)) {
  const [v, ts] = await r(a, A.kursApi3Abi, "read");
  console.log(`\nAPI3 ReaderProxy ${p} ${a}\n  read() = (${v}, ${ts})  -> ${Number(v) / 1e18} observed ${t(ts)}`);
}

const [cv, ca] = await r(chronicle, A.kursChronicleAbi, "readWithAge");
console.log(`\nChronicle BTC/USD ${chronicle}\n  readWithAge() = (${cv}, ${ca})  -> $${Number(cv) / 1e18} observed ${t(ca)}`);

const prices = await r(aave, A.kursAaveOracleAbi, "getAssetsPrices", [[BTC, IDR]]);
console.log(`\nAave v3 IPriceOracleGetter ${aave}  (BASE_CURRENCY_UNIT 1e8, maxAge 7200 s)`);
console.log(`  getAssetsPrices([BTC, IDR]) = [${prices.join(", ")}]  -> BTC $${Number(prices[0]) / 1e8}, Rp 1 = $${Number(prices[1]) / 1e8}`);
