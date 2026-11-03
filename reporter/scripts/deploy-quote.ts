// Deploys KursQuoteOracle (ERC-7726 getQuote) next to an existing Kurs oracle, then
// reads real quotes from it and records the address in deployments/<chain>.json.
//   npx tsx scripts/deploy-quote.ts <sepolia|portaldot>
// On Portaldot the Revive storage deposit is estimated first; the script stops if the
// deployer cannot cover it.
import { encodeDeployData, formatEther, formatUnits, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { kursQuoteAbi, kursQuoteBytecode } from "../src/abi.js";
import { clients, loadDeployment, type ChainKey } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const chain = (process.argv[2] ?? "sepolia") as ChainKey;
const d = loadDeployment(chain);
if (!d) throw new Error(`no deployment for ${chain}`);

// ERC-7726 asset ids
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const BTC = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" as Address;
const USD = "0x0000000000000000000000000000000000000348" as Address; // 840
const IDR = "0x0000000000000000000000000000000000000168" as Address; // 360
const feed = (p: string) => keccak256(toBytes(p));

// Portaldot rounds every ~64 min (slot-aligned relay); accept up to 2 h old
const MAX_AGE = 7200;
const args = [
  d.oracle,
  MAX_AGE,
  [BTC, ETH, USD],
  [USD, USD, IDR],
  [feed("BTC/USD"), feed("ETH/USD"), feed("USD/IDR")],
  [8, 18, 18],
  [18, 18, 18],
] as const;

const { pub, wallet } = clients(chain, privateKeyToAccount(process.env.DEPLOYER_PK as Hex));
const me = wallet!.account!.address;
const balance = await pub.getBalance({ address: me });
const gas = await pub.estimateGas({ account: me, data: encodeDeployData({ abi: kursQuoteAbi, bytecode: kursQuoteBytecode, args }) });
const price = await pub.getGasPrice();
const cost = gas * price;
console.log(`${chain}: estimated ${formatEther(cost)} (gas ${gas}) of ${formatEther(balance)} available`);
if (cost * 12n / 10n > balance) {
  console.log("not enough balance for the deposit with a 20% margin; stopping");
  process.exit(2);
}

const hash = await wallet!.deployContract({ abi: kursQuoteAbi, bytecode: kursQuoteBytecode, args, chain: wallet!.chain });
const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
const quote = rc.contractAddress as Address;
console.log("KursQuoteOracle", quote, hash, `paid ${formatEther(rc.gasUsed * rc.effectiveGasPrice)}`);

const read = async (amount: bigint, base: Address, q: Address) =>
  pub.readContract({ address: quote, abi: kursQuoteAbi, functionName: "getQuote", args: [amount, base, q] }).catch((e) => (e as Error).message.split("\n")[0]);
const quotes = {
  "1 BTC in USD": await read(10n ** 8n, BTC, USD),
  "1 ETH in USD": await read(10n ** 18n, ETH, USD),
  "1 USD in IDR": await read(10n ** 18n, USD, IDR),
  "1 BTC in IDR (via USD)": await read(10n ** 8n, BTC, IDR),
  "Rp 1,000,000 in ETH (via USD)": await read(10n ** 24n, IDR, ETH),
};
for (const [k, v] of Object.entries(quotes)) console.log(k.padEnd(30), typeof v === "bigint" ? formatUnits(v, 18) : v);

const path = new URL(`../../deployments/${chain}.json`, import.meta.url);
const j = JSON.parse(readFileSync(path, "utf8"));
j.quoteOracle = quote;
j.txs = { ...j.txs, "deploy KursQuoteOracle (ERC-7726)": hash };
writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
