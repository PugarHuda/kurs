// Hands KursOracle ownership on Ethereum Sepolia to a 2-of-3 Safe (Safe{Core} protocol-kit),
// the EVM counterpart of the native pallet-multisig that owns the Portaldot oracle.
//
//   1. deploy a 2-of-3 Safe (deployer pays gas; owners are SAFE_SIGNER_{1,2,3}_PK)
//   2. the current owner calls KursOracle.transferOwnership(safe)
//   3. signers 1 and 2 sign a Safe transaction calling acceptOwnership(); the deployer executes it
//
// Two-step ownership: if step 3 never runs, the EOA keeps ownership.
// usage: npx tsx scripts/safe-owner.ts
import Safe from "@safe-global/protocol-kit";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kursOracleAbi } from "../src/abi.js";
import { clients, loadDeployment } from "../src/chain.js";
import { readFileSync, writeFileSync } from "node:fs";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const d = loadDeployment("sepolia")!;
const deployerPk = process.env.DEPLOYER_PK as Hex;
const signerPks = [1, 2, 3].map((i) => process.env[`SAFE_SIGNER_${i}_PK`] as Hex);
const owners = signerPks.map((k) => privateKeyToAccount(k).address);
const { pub, wallet } = clients("sepolia", privateKeyToAccount(deployerPk));

// 1. Safe (deterministic address from owners + threshold + saltNonce)
const predictedSafe = { safeAccountConfig: { owners, threshold: 2 }, safeDeploymentConfig: { saltNonce: "7412" } };
let kit = await Safe.init({ provider: RPC, signer: deployerPk, predictedSafe });
const safe = (await kit.getAddress()) as Address;
if (!(await kit.isSafeDeployed())) {
  const tx = await kit.createSafeDeploymentTransaction();
  const hash = await wallet!.sendTransaction({ to: tx.to as Address, data: tx.data as Hex, value: BigInt(tx.value), chain: wallet!.chain });
  await pub.waitForTransactionReceipt({ hash });
  console.log("1. Safe deployed", safe, hash);
} else console.log("1. Safe already deployed", safe);
kit = await kit.connect({ safeAddress: safe });

// 2. propose the Safe as owner
const owner = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "owner" });
if (owner.toLowerCase() === safe.toLowerCase()) {
  console.log("already owned by the Safe");
  process.exit(0);
}
const pending = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "pendingOwner" });
let proposeHash: Hex | undefined;
if (pending.toLowerCase() !== safe.toLowerCase()) {
  proposeHash = await wallet!.writeContract({ address: d.oracle, abi: kursOracleAbi, functionName: "transferOwnership", args: [safe], chain: wallet!.chain });
  await pub.waitForTransactionReceipt({ hash: proposeHash });
  console.log("2. transferOwnership(safe)", proposeHash);
}

// 3. two owners sign acceptOwnership(), anyone executes
const data = encodeFunctionData({ abi: kursOracleAbi, functionName: "acceptOwnership" });
let stx = await kit.createTransaction({ transactions: [{ to: d.oracle, value: "0", data }] });
stx = await (await kit.connect({ signer: signerPks[0] })).signTransaction(stx);
stx = await (await kit.connect({ signer: signerPks[1] })).signTransaction(stx);
const exec = await (await kit.connect({ signer: deployerPk })).executeTransaction(stx);
await pub.waitForTransactionReceipt({ hash: exec.hash as Hex });
console.log("3. Safe executed acceptOwnership", exec.hash);

const now = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "owner" });
const ok = now.toLowerCase() === safe.toLowerCase();
console.log("owner() =", now, ok ? "== Safe" : "!= Safe");

// record it next to the deployment
const path = new URL("../../deployments/sepolia.json", import.meta.url);
const j = JSON.parse(readFileSync(path, "utf8"));
j.governance = { type: "Safe 2-of-3 (Safe{Core} protocol-kit)", threshold: 2, signatories: owners, account: safe, h160: safe };
j.txs = { ...j.txs, ...(proposeHash ? { "transferOwnership(safe)": proposeHash } : {}), "Safe execTransaction(acceptOwnership)": exec.hash };
writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
process.exit(ok ? 0 : 1);
