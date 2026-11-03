// Deploys the Pyth (IPyth) and Morpho Blue (IOracle) views of Kurs, then exercises
// them for real: Pyth's pull flow (updatePriceFeeds with /api/bundle payloads, a
// transaction), getPrice, and a Morpho price() for a BTC-collateral, Rupiah-loan market.
//   npx tsx scripts/deploy-adapters.ts sepolia
// Resumable: addresses and txs go to deployments/<chain>.json.
import { formatEther, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { kursMorphoOracleAbi, kursMorphoOracleBytecode, kursPythAbi, kursPythBytecode } from "../src/abi.js";
import { clients, type ChainKey } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const chain = (process.argv[2] ?? "sepolia") as ChainKey;
const path = new URL(`../../deployments/${chain}.json`, import.meta.url);
const j = JSON.parse(readFileSync(path, "utf8"));
const save = () => writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
if (!j.quoteOracle) throw new Error("deploy KursQuoteOracle first (scripts/deploy-quote.ts)");
const { pub, wallet } = clients(chain, privateKeyToAccount(process.env.DEPLOYER_PK as Hex));
const API = process.env.KURS_API ?? "https://kurs-ten-zeta.vercel.app";

const BTC = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" as Address;
const IDR = "0x0000000000000000000000000000000000000168" as Address; // ISO 4217 360

async function deploy(key: string, abi: any, bytecode: Hex, args: readonly unknown[]) {
  if (j[key]) return j[key] as Address;
  const hash = await wallet!.deployContract({ abi, bytecode, args, chain: wallet!.chain });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  j[key] = rc.contractAddress;
  j.txs[`deploy ${key}`] = hash;
  save();
  console.log(key, rc.contractAddress, hash, `paid ${formatEther(rc.gasUsed * rc.effectiveGasPrice)}`);
  return rc.contractAddress as Address;
}

// Pyth's getPrice() validity window: 2 h, like the quote oracle (hourly relay)
const pyth = await deploy("pyth", kursPythAbi, kursPythBytecode, [j.oracle, 7200n]);
// Morpho market: collateral an 8-decimal BTC token, loan a 2-decimal Rupiah token (IDRX uses 2)
const morpho = await deploy("morphoOracleBtcIdr", kursMorphoOracleAbi, kursMorphoOracleBytecode, [j.quoteOracle, BTC, 8, 8, IDR, 18, 2]);

// Pyth pull flow, with real signed bundles from the public API
const pairs = ["BTC/USD", "USD/IDR"];
const payloads = await Promise.all(
  pairs.map(async (p) => {
    const r = await fetch(`${API}/api/bundle?pair=${encodeURIComponent(p)}`);
    if (!r.ok) throw new Error(`bundle ${p}: ${r.status} ${await r.text()}`);
    return (await r.json()).payload as Hex;
  }),
);
const fee = await pub.readContract({ address: pyth, abi: kursPythAbi, functionName: "getUpdateFee", args: [payloads] });
const hash = await wallet!.writeContract({ address: pyth, abi: kursPythAbi, functionName: "updatePriceFeeds", args: [payloads], value: fee, chain: wallet!.chain });
const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
if (rc.status !== "success") throw new Error(`updatePriceFeeds reverted: ${hash}`);
j.txs["Pyth updatePriceFeeds (BTC/USD, USD/IDR bundles)"] = hash;
save();
console.log("updatePriceFeeds", hash, "block", rc.blockNumber);

for (const p of pairs) {
  const px = await pub.readContract({ address: pyth, abi: kursPythAbi, functionName: "getPrice", args: [keccak256(toBytes(p))] });
  console.log(`Pyth getPrice(${p})`, `${Number(px.price) * 10 ** px.expo} ±${Number(px.conf) * 10 ** px.expo}`, "published", new Date(Number(px.publishTime) * 1000).toISOString());
}
const mp = await pub.readContract({ address: morpho, abi: kursMorphoOracleAbi, functionName: "price" });
// loan units per collateral unit = price / 1e36; 1 BTC = 1e8 units, Rp in 1e2 units
console.log("Morpho price()", mp, `= 1 BTC is Rp ${(Number((mp * 10n ** 8n) / 10n ** 36n) / 100).toLocaleString("en-US")}`);
