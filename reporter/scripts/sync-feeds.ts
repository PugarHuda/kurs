// Brings each oracle's on-chain feed config (setFeed) back in line with reporter/src/feeds.ts,
// through the governance that owns it. Only feeds that differ are touched.
//
//   Sepolia:   one Safe transaction (MultiSend of every setFeed), signed by 2 of the 3 Safe
//              owners, executed by the deployer. The same batch is written as a Safe
//              Transaction Builder file (docs/safe/), importable in the Safe{Wallet} UI.
//   Portaldot: the owner is a pure proxy behind a 600-block pallet-proxy delay. The 2-of-3
//              multisig announces utility.batchAll[revive.call(setFeed) ...]; after the delay
//              anyone executes it with proxy.proxyAnnounced. Re-run to continue; progress is
//              kept in deployments/portaldot.json under governance.ops.
//
//   npx tsx scripts/sync-feeds.ts [sepolia|portaldot|both]   (default both)
//   npx tsx scripts/sync-feeds.ts --check                    drift report only, sends nothing
import Safe from "@safe-global/protocol-kit";
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import { createKeyMulti, encodeAddress, sortAddresses } from "@polkadot/util-crypto";
import { encodeFunctionData, keccak256, parseEventLogs, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FEEDS, type FeedConfig } from "../src/feeds.js";
import { kursFactoryAbi, kursOracleAbi } from "../src/abi.js";
import { clients, loadDeployment, type ChainKey } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const arg = process.argv[2] ?? "both";
const CHECK = process.argv.includes("--check");
const KEYS = ["decimals", "maxSpreadBps", "heartbeat", "minAnswer", "maxAnswer", "description"] as const;

async function drift(chain: ChainKey) {
  const { pub } = clients(chain);
  const d = loadDeployment(chain)!;
  const out: { f: FeedConfig; diffs: string[]; data: Hex }[] = [];
  for (const f of FEEDS) {
    const c = (await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "feed", args: [keccak256(toBytes(f.pair))] })) as Record<string, unknown>;
    const diffs = KEYS.filter((k) => c[k] !== f[k]).map((k) => `${k} ${c[k]} -> ${f[k]}`);
    if (diffs.length)
      out.push({
        f,
        diffs,
        data: encodeFunctionData({
          abi: kursOracleAbi,
          functionName: "setFeed",
          args: [keccak256(toBytes(f.pair)), f.description, f.decimals, f.heartbeat, f.maxSpreadBps, f.minAnswer, f.maxAnswer],
        }),
      });
  }
  for (const x of out) console.log(`${chain.padEnd(9)} ${x.f.pair.padEnd(10)} ${x.diffs.join("; ")}`);
  if (!out.length) console.log(`${chain.padEnd(9)} in sync with feeds.ts`);
  return out;
}

/** An AggregatorV3 clone for every configured feed that has none (factory.deploy is permissionless). */
async function clones(chain: ChainKey) {
  const path = new URL(`../../deployments/${chain}.json`, import.meta.url);
  const j = JSON.parse(readFileSync(path, "utf8"));
  const { pub, wallet } = clients(chain, privateKeyToAccount(process.env.DEPLOYER_PK as Hex));
  for (const f of FEEDS) {
    if (j.aggregators[f.pair]) continue;
    const id = keccak256(toBytes(f.pair));
    const cfg = await pub.readContract({ address: j.oracle, abi: kursOracleAbi, functionName: "feed", args: [id] });
    if (!cfg.exists) continue; // the owner has not run setFeed for it here yet
    const existing = await pub.readContract({ address: j.factory, abi: kursFactoryAbi, functionName: "aggregatorOf", args: [id] });
    if (existing !== zeroAddress) j.aggregators[f.pair] = existing;
    else {
      const hash = await wallet!.writeContract({ address: j.factory, abi: kursFactoryAbi, functionName: "deploy", args: [id], chain: wallet!.chain, account: wallet!.account! });
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
      const [ev] = parseEventLogs({ abi: kursFactoryAbi, logs: rc.logs, eventName: "AggregatorDeployed" });
      if (!ev) throw new Error(`no AggregatorDeployed in ${hash}`);
      j.aggregators[f.pair] = ev.args.aggregator;
      j.txs[`aggregator ${f.pair}`] = hash;
    }
    writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
    console.log(`${chain.padEnd(9)} ${f.pair.padEnd(10)} AggregatorV3 clone ${j.aggregators[f.pair]}`);
  }
}

// ------------------------------------------------------------------ Sepolia: Safe 2-of-3
async function sepolia() {
  const todo = await drift("sepolia");
  if (!CHECK && !todo.length) await clones("sepolia");
  if (CHECK || !todo.length) return;
  const d = loadDeployment("sepolia")! as ReturnType<typeof loadDeployment> & { governance: { account: Address } };
  const safe = d.governance.account;
  const txs = todo.map((x) => ({ to: d.oracle, value: "0", data: x.data }));

  // Safe Transaction Builder file: the same batch, for owners who sign in the Safe{Wallet} UI
  mkdirSync(new URL("../../docs/safe/", import.meta.url), { recursive: true });
  const builder = {
    version: "1.0",
    chainId: String(d.chainId),
    createdAt: Date.now(),
    meta: {
      name: "Kurs: sync feed config with feeds.ts",
      description: todo.map((x) => `${x.f.pair}: ${x.diffs.join("; ")}`).join(" | "),
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: "",
    },
    transactions: todo.map((x) => ({
      to: d.oracle,
      value: "0",
      data: null,
      contractMethod: {
        name: "setFeed",
        payable: false,
        inputs: kursOracleAbi.find((i) => i.type === "function" && i.name === "setFeed")!.inputs.map((i) => ({ name: i.name, type: i.type, internalType: i.internalType })),
      },
      contractInputsValues: {
        feedId: keccak256(toBytes(x.f.pair)),
        description: x.f.description,
        decimals: String(x.f.decimals),
        heartbeat: String(x.f.heartbeat),
        maxSpreadBps: String(x.f.maxSpreadBps),
        minAnswer: x.f.minAnswer.toString(),
        maxAnswer: x.f.maxAnswer.toString(),
      },
    })),
  };
  const file = new URL("../../docs/safe/sync-feeds-sepolia.json", import.meta.url);
  writeFileSync(file, JSON.stringify(builder, null, 2) + "\n");
  console.log("Safe Transaction Builder batch:", "docs/safe/sync-feeds-sepolia.json");

  const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const [s1, s2] = [1, 2].map((i) => process.env[`SAFE_SIGNER_${i}_PK`] as Hex);
  const deployerPk = process.env.DEPLOYER_PK as Hex;
  const kit = await Safe.init({ provider: RPC, signer: s1, safeAddress: safe });
  let stx = await kit.createTransaction({ transactions: txs }); // > 1 call: MultiSend (delegatecall)
  stx = await kit.signTransaction(stx);
  stx = await (await kit.connect({ signer: s2 })).signTransaction(stx);
  const exec = await (await kit.connect({ signer: deployerPk })).executeTransaction(stx);
  const { pub } = clients("sepolia");
  const rc = await pub.waitForTransactionReceipt({ hash: exec.hash as Hex });
  console.log(`Safe execTransaction (MultiSend of ${txs.length} setFeed) ${rc.status} ${exec.hash}`);
  const path = new URL("../../deployments/sepolia.json", import.meta.url);
  const j = JSON.parse(readFileSync(path, "utf8"));
  j.txs[`Safe execTransaction(MultiSend ${txs.length}x setFeed: sync feeds.ts)`] = exec.hash;
  writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
  // the public RPC is load-balanced: a backend may not have seen the block yet
  let left = 1;
  for (let i = 0; i < 4 && left; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    left = (await drift("sepolia")).length;
  }
  if (left) throw new Error("Sepolia still differs after the Safe transaction");
  await clones("sepolia");
}

// ------------------------------------------------- Portaldot: multisig -> announce -> delay
async function portaldot() {
  const todo = await drift("portaldot");
  const path = new URL("../../deployments/portaldot.json", import.meta.url);
  const j = JSON.parse(readFileSync(path, "utf8"));
  // every announced batch, by name; several can wait out the delay at the same time
  const ops: Record<string, any> = (j.governance.ops ??= {});
  const pending = Object.entries(ops).filter(([, o]) => o.pending);
  const covered = new Set(pending.flatMap(([, o]) => o.pairs as string[]));
  const fresh = todo.filter((x) => !covered.has(x.f.pair));
  if (CHECK || (!fresh.length && !pending.length)) return;
  const d = loadDeployment("portaldot")!;
  const UNIT = 10n ** 14n;
  const DELAY = j.governance.timelock.delayBlocks as number;
  const P = j.governance.timelock.pure as string;
  const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
  const kr = new Keyring({ type: "sr25519", ss58Format: 42 });
  const [A, B, C] = ["A", "B", "C"].map((k) => kr.addFromMnemonic(process.env[`SIGNER_${k}_MNEMONIC`]!));
  const signers = [A, B, C].map((s) => s.address);
  const M = encodeAddress(createKeyMulti(signers, 2), 42);
  const others = (me: KeyringPair) => sortAddresses(signers.filter((a) => a !== me.address), 42);
  const gas = { refTime: 20_000_000_000n, proofSize: 1_000_000n };
  const maxWeight = { refTime: 60_000_000_000n, proofSize: 3_000_000n };
  const save = () => writeFileSync(path, JSON.stringify(j, null, 2) + "\n");

  const send = (tx: SubmittableExtrinsic<"promise">, who: KeyringPair, label: string) =>
    new Promise<{ hash: string; block: string; events: any[] }>((resolve, reject) => {
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
  const free = async (who: string) => (await api.query.system.account(who)).data.free.toBigInt();
  const afford = async (tx: SubmittableExtrinsic<"promise">, who: KeyringPair, label: string) => {
    const fee = (await tx.paymentInfo(who)).partialFee.toBigInt();
    const have = await free(who.address);
    console.log(`  ${label}: fee ${Number(fee) / 1e14} tPOT, ${who === A ? "A" : "B"} has ${Number(have) / 1e14}`);
    if (fee * 2n > have) throw new Error(`${label}: signer cannot cover the fee`);
  };

  // the call the pure proxy makes: every setFeed in one batch. A new feed opens storage,
  // paid as a Revive deposit by the proxy, so the per-call deposit limit is 20 tPOT
  // (an op keeps the limit it was announced with: the call hash depends on it).
  const batchOf = (datas: Hex[], limit: number) => api.tx.utility.batchAll(datas.map((data) => api.tx.revive.call(d.oracle, 0, gas, BigInt(limit) * UNIT, data)));

  if (fresh.length) {
    const limit = 20;
    const batch = batchOf(fresh.map((x) => x.data), limit);
    // announcement deposit is reserved from the multisig account
    const inner = api.tx.proxy.announce(P, batch.method.hash);
    const first = api.tx.multisig.asMulti(2, others(A), null, inner, maxWeight);
    await afford(first, A, "asMulti(announce) by A");
    const a = await send(first, A, "announce (A)");
    const when = (await api.query.multisig.multisigs(M, inner.method.hash)).unwrap().when;
    const second = api.tx.multisig.asMulti(2, others(B), when, inner, maxWeight);
    await afford(second, B, "asMulti(announce) by B");
    const b = await send(second, B, "announce (B)");
    const ex = b.events.find(({ event }) => api.events.multisig.MultisigExecuted.is(event));
    if (!ex?.event.data.result.isOk) throw new Error(`announce: ${ex?.event.data.result.toString()}`);
    const at = (await api.rpc.chain.getHeader(b.block)).number.toNumber();
    ops[`sync-feeds #${at}`] = { pending: true, limit, datas: fresh.map((x) => x.data), pairs: fresh.map((x) => x.f.pair), callHash: batch.method.hash.toHex(), announcedAt: at, approve: a.hash, announce: b.hash };
    save();
    console.log(`announced setFeed x${fresh.length} (${fresh.map((x) => x.f.pair).join(", ")}) at #${at} (approve ${a.hash}, execute ${b.hash}); executable from #${at + DELAY}`);
  }

  const now = (await api.rpc.chain.getHeader()).number.toNumber();
  let executed = 0;
  for (const [name, o] of Object.entries(ops).filter(([, o]) => o.pending)) {
    if (now < o.announcedAt + DELAY) {
      console.log(`${name} (${o.pairs.join(", ")}): executable from #${o.announcedAt + DELAY}, now #${now} (~${Math.ceil(((o.announcedAt + DELAY - now) * 14) / 60)} min at ~14 s blocks). Re-run then.`);
      continue;
    }
    const execTx = api.tx.proxy.proxyAnnounced(M, P, null, batchOf(o.datas, o.limit ?? 10));
    await afford(execTx, A, `proxyAnnounced ${name} by A`);
    const r = await send(execTx, A, `proxyAnnounced ${name}`);
    const ex = r.events.find(({ event }) => api.events.proxy.ProxyExecuted.is(event));
    if (!ex?.event.data.result.isOk) throw new Error(`proxyAnnounced ${name}: ${ex?.event.data.result.toString()}`);
    Object.assign(o, { pending: false, executedAt: (await api.rpc.chain.getHeader(r.block)).number.toNumber(), execute: r.hash });
    save();
    executed++;
    console.log(`${name}: executed after the delay, proxy.proxyAnnounced ${r.hash} (block #${o.executedAt})`);
  }
  await api.disconnect();
  if (executed && !Object.values(ops).some((o) => o.pending) && (await drift("portaldot")).length) throw new Error("Portaldot still differs after execution");
  if (executed) await clones("portaldot");
}

if (arg === "sepolia" || arg === "both" || arg === "--check") await sepolia();
if (arg === "portaldot" || arg === "both" || arg === "--check") await portaldot();
process.exit(0);
