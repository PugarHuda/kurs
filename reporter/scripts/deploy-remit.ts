// Deploys KursRemit (ink! v6, PolkaVM) on Portaldot V3 from the EVM deployer key: on pallet-revive an
// Ethereum deploy transaction carries PolkaVM code + the SCALE constructor input. Then reads latest()
// (ink! -> Solidity oracle, cross-VM) and sends quote_and_log as a transaction.
//   npx tsx scripts/deploy-remit.ts --estimate   # cost estimate only, sends nothing
//   npx tsx scripts/deploy-remit.ts              # deploy + call, resumable via deployments/portaldot.json
import { concat, formatEther, keccak256, toBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { clients } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const path = new URL("../../deployments/portaldot.json", import.meta.url);
const j = JSON.parse(readFileSync(path, "utf8"));
const account = privateKeyToAccount(process.env.DEPLOYER_PK as Hex);
const { pub, wallet } = clients("portaldot", account);
const code = toHex(readFileSync(new URL("../../ink/kurs_consumer/target/ink/kurs_consumer.polkavm", import.meta.url)));

const le = (v: bigint, bytes: number) => {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return toHex(b);
};
// new(oracle: H160, feed_id: [u8; 32], max_age: u64); 2 h, the hourly relay plus slack
const ctor = concat(["0x9bae9d5e", j.oracle, keccak256(toBytes("USD/IDR")), le(7200n, 8)]);
const data = concat([code, ctor]);
console.log(`KursRemit code ${(code.length - 2) / 2} bytes`);

if (process.argv.includes("--estimate")) {
  const [gas, gasPrice, bal] = await Promise.all([
    pub.estimateGas({ account: account.address, data }),
    pub.getGasPrice(),
    pub.getBalance({ address: account.address }),
  ]);
  console.log(`estimate: gas ${gas} x ${gasPrice} = ${formatEther(gas * gasPrice)} tPOT (incl. storage deposit); balance ${formatEther(bal)}`);
  process.exit(0);
}

if (!j.kursRemit) {
  const before = await pub.getBalance({ address: account.address });
  const hash = await wallet!.deployContract({ abi: [], bytecode: data, chain: wallet!.chain });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy failed ${hash}`);
  j.kursRemit = rc.contractAddress;
  j.txs["deploy KursRemit (ink! v6)"] = hash;
  writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
  console.log(`KursRemit ${rc.contractAddress} tx ${hash} block ${rc.blockNumber}; cost ${formatEther(before - (await pub.getBalance({ address: account.address })))} tPOT`);
}

// latest(): Result<(u128, i128, u64, u64), LangError> = 0x00 ++ 16 ++ 16 ++ 8 ++ 8 bytes LE
const { data: out } = await pub.call({ to: j.kursRemit, data: "0x46d8a35e" });
const raw = toBytes(out!);
if (raw[0] !== 0) throw new Error(`ink! LangError ${out}`);
const rd = (from: number, n: number) => raw.slice(from, from + n).reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
const [roundId, answer] = [rd(1, 16), rd(17, 16)];
const [oRound, oAnswer] = await pub.readContract({
  address: j.oracle,
  abi: [{ type: "function", name: "latestRound", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint80" }, { type: "int192" }, { type: "uint64" }, { type: "uint64" }] }],
  functionName: "latestRound",
  args: [keccak256(toBytes("USD/IDR"))],
});
console.log(`ink! latest() -> round ${roundId}, answer ${answer}; Solidity oracle -> round ${oRound}, answer ${oAnswer}`);
if (roundId !== oRound || answer !== oAnswer) throw new Error("ink! read does not match the oracle");

// quote_and_log(10_000 USD cents) -> IDR cents, a transaction that emits Quoted
const hash = await wallet!.sendTransaction({ to: j.kursRemit, data: concat(["0x37a2fa0a", le(10_000n, 16)]), chain: wallet!.chain });
const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
j.txs["KursRemit quote_and_log(10000)"] = hash;
writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
console.log(`quote_and_log tx ${hash} status ${rc.status}, logs ${rc.logs.length}`);
console.log(`OK: on Portaldot V3, ink! read round ${roundId} = ${Number(answer) / 1e8} IDR per USD from the Solidity oracle`);
