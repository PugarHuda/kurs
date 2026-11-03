// Puts a time delay between the Portaldot multisig and the oracle, using only native
// pallets: ownership moves to a *pure proxy* that the 2-of-3 multisig controls with a
// pallet-proxy `delay`. Every owner action must first be announced (2-of-3), can only
// execute DELAY blocks later, and the multisig can veto it meanwhile with
// proxy.rejectAnnouncement. A Substrate-native TimelockController.
//
//   1. multisig: proxy.createPure(Any, DELAY, 0)                -> pure proxy P
//   2. signer A funds the multisig (announcement deposit) and P (Revive mapping deposit)
//   3. multisig: revive.call(oracle.transferOwnership(P's H160))
//   4. multisig: proxy.announce(P, hash(batchAll[revive.mapAccount, revive.call(acceptOwnership)]))
//   5. after DELAY blocks, anyone: proxy.proxyAnnounced(multisig, P, None, that call)
//
// Resumable: progress is stored under governance.timelock in deployments/portaldot.json.
// usage: npx tsx scripts/timelock-owner.ts
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import { createKeyMulti, encodeAddress, sortAddresses } from "@polkadot/util-crypto";
import { encodeFunctionData, type Address } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { kursOracleAbi } from "../src/abi.js";
import { clients, loadDeployment } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const DELAY = Number(process.env.KURS_TIMELOCK_BLOCKS ?? 600); // ~1 h at 6 s blocks
const UNIT = 10n ** 14n;
const path = new URL("../../deployments/portaldot.json", import.meta.url);
const j = JSON.parse(readFileSync(path, "utf8"));
const tl = (j.governance.timelock ??= { delayBlocks: DELAY, steps: {} });
const save = () => writeFileSync(path, JSON.stringify(j, null, 2) + "\n");

const d = loadDeployment("portaldot")!;
const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
const kr = new Keyring({ type: "sr25519", ss58Format: 42 });
const [A, B, C] = ["A", "B", "C"].map((k) => kr.addFromMnemonic(process.env[`SIGNER_${k}_MNEMONIC`]!));
const signers = [A, B, C].map((s) => s.address);
const M = encodeAddress(createKeyMulti(signers, 2), 42);
const others = (me: KeyringPair) => sortAddresses(signers.filter((a) => a !== me.address), 42);
const { pub } = clients("portaldot");
const owner = () => pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "owner" });
const gas = { refTime: 20_000_000_000n, proofSize: 1_000_000n };
const maxWeight = { refTime: 60_000_000_000n, proofSize: 3_000_000n };

function send(tx: SubmittableExtrinsic<"promise">, who: KeyringPair, label: string) {
  return new Promise<{ hash: string; block: string; events: any[] }>((resolve, reject) => {
    tx.signAndSend(who, ({ status, events, dispatchError, txHash }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return reject(new Error(`${label}: ${m ? `${m.section}.${m.name}` : dispatchError.toString()}`));
      }
      if (status.isInBlock) {
        if (events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event))) return reject(new Error(`${label}: ExtrinsicFailed`));
        resolve({ hash: txHash.toHex(), block: status.asInBlock.toHex(), events });
      }
    }).catch(reject);
  });
}

/** 2-of-3: A approves, B executes. Fails unless the inner call returned Ok. */
async function asMulti(inner: SubmittableExtrinsic<"promise">, label: string) {
  const a = await send(api.tx.multisig.asMulti(2, others(A), null, inner, maxWeight), A, `${label} (A)`);
  const when = (await api.query.multisig.multisigs(M, inner.method.hash)).unwrap().when;
  const b = await send(api.tx.multisig.asMulti(2, others(B), when, inner, maxWeight), B, `${label} (B)`);
  const ex = b.events.find(({ event }) => api.events.multisig.MultisigExecuted.is(event));
  const result = ex?.event.data.result;
  if (!result?.isOk) throw new Error(`${label}: inner call failed ${result?.toString()}`);
  tl.steps[label] = { approve: { hash: a.hash, block: a.block }, execute: { hash: b.hash, block: b.block } };
  save();
  console.log(`${label}: approved ${a.hash}, executed ${b.hash}`);
  return b;
}

// 1. pure proxy owned by the multisig, with the delay
if (!tl.pure) {
  const r = await asMulti(api.tx.proxy.createPure("Any", DELAY, 0), "createPure");
  const ev = r.events.find(({ event }) => api.events.proxy.PureCreated.is(event));
  tl.pure = ev!.event.data.pure.toString();
  save();
}
const P = tl.pure as string;
const PH160 = (await api.call.reviveApi.address(P)).toHex() as Address;
tl.pureH160 = PH160;
save();
console.log({ multisig: M, pure: P, pureH160: PH160, delayBlocks: DELAY });

// 2. deposits: the multisig pays the announcement deposit, P its Revive mapping
const free = async (who: string) => (await api.query.system.account(who)).data.free.toBigInt();
if ((await free(M)) < 8n * UNIT) {
  const r = await send(api.tx.balances.transferKeepAlive(M, 6n * UNIT), A, "fund multisig");
  tl.steps["fund multisig"] = { hash: r.hash, block: r.block };
  save();
}
if ((await free(P)) < 2n * UNIT) {
  const r = await send(api.tx.balances.transferKeepAlive(P, 3n * UNIT), A, "fund pure proxy");
  tl.steps["fund pure proxy"] = { hash: r.hash, block: r.block };
  save();
}

// 3. the multisig (still owner) proposes P as the next owner
if ((await owner()).toLowerCase() !== PH160.toLowerCase()) {
  const pending = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "pendingOwner" });
  if (pending.toLowerCase() !== PH160.toLowerCase()) {
    const data = encodeFunctionData({ abi: kursOracleAbi, functionName: "transferOwnership", args: [PH160] });
    await asMulti(api.tx.revive.call(d.oracle, 0, gas, 10n * UNIT, data), "transferOwnership(pure proxy)");
  }
}

// 4. announce P's acceptOwnership; 5. execute it once the delay has passed
const accept = api.tx.utility.batchAll([
  api.tx.revive.mapAccount(),
  api.tx.revive.call(d.oracle, 0, gas, 10n * UNIT, encodeFunctionData({ abi: kursOracleAbi, functionName: "acceptOwnership" })),
]);
if ((await owner()).toLowerCase() !== PH160.toLowerCase()) {
  if (!tl.announcedAt) {
    const r = await asMulti(api.tx.proxy.announce(P, accept.method.hash), "announce acceptOwnership");
    tl.announcedAt = (await api.rpc.chain.getHeader(r.block)).number.toNumber();
    tl.callHash = accept.method.hash.toHex();
    save();
  }
  const now = (await api.rpc.chain.getHeader()).number.toNumber();
  const due = tl.announcedAt + DELAY;
  if (now < due) {
    console.log(`announced at #${tl.announcedAt}; executable from #${due} (now #${now}, ~${Math.ceil(((due - now) * 6) / 60)} min). Re-run then.`);
    await api.disconnect();
    process.exit(3);
  }
  const r = await send(api.tx.proxy.proxyAnnounced(M, P, null, accept), A, "proxyAnnounced");
  const ex = r.events.find(({ event }) => api.events.proxy.ProxyExecuted.is(event));
  if (!ex?.event.data.result.isOk) throw new Error(`proxyAnnounced: ${ex?.event.data.result.toString()}`);
  tl.steps["execute after delay (proxy.proxyAnnounced)"] = { hash: r.hash, block: r.block };
  tl.executedAt = (await api.rpc.chain.getHeader(r.block)).number.toNumber();
  save();
}

const now = await owner();
const ok = now.toLowerCase() === PH160.toLowerCase();
console.log("owner() =", now, ok ? "== pure proxy (multisig + delay)" : "!= pure proxy");
await api.disconnect();
process.exit(ok ? 0 : 1);
