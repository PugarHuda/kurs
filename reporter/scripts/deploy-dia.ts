// Deploys only KursDIA (DIA's getValue over Kurs) and reads it; used for Portaldot, where each
// contract costs a Revive deposit (~0.078 tPOT per byte), so adapters go up one at a time.
//   npx tsx scripts/deploy-dia.ts portaldot
import { formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { kursDiaAbi, kursDiaBytecode } from "../src/abi.js";
import { clients, type ChainKey } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const chain = (process.argv[2] ?? "portaldot") as ChainKey;
const path = new URL(`../../deployments/${chain}.json`, import.meta.url);
const j = JSON.parse(readFileSync(path, "utf8"));
const account = privateKeyToAccount(process.env.DEPLOYER_PK as Hex);
const { pub, wallet } = clients(chain, account);

if (!j.dia) {
  const before = await pub.getBalance({ address: account.address });
  const hash = await wallet!.deployContract({ abi: kursDiaAbi, bytecode: kursDiaBytecode, args: [j.oracle], chain: wallet!.chain });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy failed ${hash}`);
  const after = await pub.getBalance({ address: account.address });
  j.dia = rc.contractAddress;
  j.txs[`deploy dia`] = hash;
  writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
  console.log(`KursDIA ${rc.contractAddress} tx ${hash} block ${rc.blockNumber}; cost incl. deposit ${formatEther(before - after)} tPOT`);
}
for (const key of ["BTC/USD", "USD/IDR", "tPOT/pUSD", "XXX/USD"]) {
  const [v, t] = await pub.readContract({ address: j.dia, abi: kursDiaAbi, functionName: "getValue", args: [key] });
  console.log(`getValue("${key}") = (${v}, ${t})  -> ${Number(v) / 1e8}${t ? ` observed ${new Date(Number(t) * 1000).toISOString()}` : " (unknown key: (0, 0) like DIA)"}`);
}
