// Hands KursOracle ownership on Portaldot V3 to a native 2-of-3 pallet-multisig account.
//
//   1. signer A funds the multisig account (balances.transferKeepAlive)
//   2. the current owner calls KursOracle.transferOwnership(H160 of the multisig)   [EVM]
//   3. multisig.asMulti(batchAll[revive.mapAccount, revive.call(acceptOwnership)])   [Substrate]
//      approved by A, then executed by B
//
// After this, setFeed/setReporters/transferOwnership on the Portaldot oracle need two
// of three Substrate signers. Ownership is two-step: if step 3 never runs, the EOA
// keeps it. Signer mnemonics: SIGNER_{A,B,C}_MNEMONIC in .env.
// usage: npx tsx scripts/multisig-owner.ts
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import { createKeyMulti, encodeAddress, sortAddresses } from "@polkadot/util-crypto";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kursOracleAbi } from "../src/abi.js";
import { clients, loadDeployment } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const d = loadDeployment("portaldot")!;
const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
const kr = new Keyring({ type: "sr25519", ss58Format: 42 });
const [A, B, C] = ["A", "B", "C"].map((k) => kr.addFromMnemonic(process.env[`SIGNER_${k}_MNEMONIC`]!));
const THRESHOLD = 2;
const signers = [A, B, C].map((s) => s.address);
const multisig = encodeAddress(createKeyMulti(signers, THRESHOLD), 42);
const multisigH160 = (await api.call.reviveApi.address(multisig)).toHex() as Address;
const others = (me: KeyringPair) => sortAddresses(signers.filter((a) => a !== me.address), 42);
const UNIT = 10n ** 14n; // tPOT has 14 decimals natively

function send(tx: SubmittableExtrinsic<"promise">, who: KeyringPair, label: string) {
  return new Promise<{ hash: string; block: string; events: any[] }>((resolve, reject) => {
    tx.signAndSend(who, ({ status, events, dispatchError, txHash }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return reject(new Error(`${label}: ${m ? `${m.section}.${m.name}` : dispatchError.toString()}`));
      }
      if (status.isInBlock) {
        const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
        if (failed) return reject(new Error(`${label}: ExtrinsicFailed`));
        resolve({ hash: txHash.toHex(), block: status.asInBlock.toHex(), events });
      }
    }).catch(reject);
  });
}

console.log({ multisig, multisigH160, signers });
const { pub, wallet } = clients("portaldot", privateKeyToAccount(process.env.DEPLOYER_PK as Hex));
const ownerNow = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "owner" });
if (ownerNow.toLowerCase() === multisigH160.toLowerCase()) {
  console.log("already owned by the multisig");
  process.exit(0);
}

// 1. fund the multisig account so it can pay its own Revive mapping deposit
const funded = (await api.query.system.account(multisig)).data.free.toBigInt();
if (funded < 2n * UNIT) {
  const r = await send(api.tx.balances.transferKeepAlive(multisig, 3n * UNIT), A, "fund multisig");
  console.log("1. funded multisig with 3 tPOT", r.hash);
}

// 2. current owner proposes the multisig (EVM, two-step ownership)
const pending = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "pendingOwner" });
if (pending.toLowerCase() !== multisigH160.toLowerCase()) {
  const hash = await wallet!.writeContract({
    address: d.oracle,
    abi: kursOracleAbi,
    functionName: "transferOwnership",
    args: [multisigH160],
    chain: wallet!.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log("2. transferOwnership(multisig) tx", hash);
}

// 3. the multisig maps itself into Revive and accepts ownership, in one batch
const accept = encodeFunctionData({ abi: kursOracleAbi, functionName: "acceptOwnership" });
const inner = api.tx.utility.batchAll([
  api.tx.revive.mapAccount(),
  api.tx.revive.call(d.oracle, 0, { refTime: 20_000_000_000n, proofSize: 1_000_000n }, 10n * UNIT, accept),
]);
const maxWeight = { refTime: 60_000_000_000n, proofSize: 3_000_000n };

const a = await send(api.tx.multisig.asMulti(THRESHOLD, others(A), null, inner, maxWeight), A, "approve (A)");
console.log("3a. A approved", a.hash, "in", a.block);
const pendingOp = await api.query.multisig.multisigs(multisig, inner.method.hash);
if (pendingOp.isNone) throw new Error("multisig operation not found after A's approval");
const timepoint = pendingOp.unwrap().when;

const b = await send(api.tx.multisig.asMulti(THRESHOLD, others(B), timepoint, inner, maxWeight), B, "execute (B)");
const executed = b.events.find(({ event }) => api.events.multisig.MultisigExecuted.is(event));
console.log("3b. B executed", b.hash, "in", b.block, "result", executed?.event.data.result.toString());

const owner = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "owner" });
console.log("owner() =", owner, owner.toLowerCase() === multisigH160.toLowerCase() ? "== multisig" : "!= multisig");
process.exit(owner.toLowerCase() === multisigH160.toLowerCase() ? 0 : 1);
