// Cross-VM end-to-end on a local ink-node (pallet-revive):
//   1. deploy KursOracle (Solidity) ,
//   2. five reporters sign a USD/IDR round, transmit it,
//   3. deploy KursRemit (ink! v6, PolkaVM),
//   4. KursRemit reads KursOracle through a Solidity-ABI call and quotes USD -> IDR.
//
// ink-node v0.47 sets allowEVMBytecode=false, so locally the oracle is compiled to
// PolkaVM with resolc (`contracts/out-pvm`). Portaldot V3 allows EVM bytecode; there
// the same KursRemit calls the solc-built oracle. The ink! side is identical either way:
// it only sees a contract at an H160 that speaks the Solidity ABI.
//
// usage: npx tsx scripts/ink-e2e.ts [ws://127.0.0.1:9944]
import { readFileSync } from "node:fs";
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import { encodeAbiParameters, encodeFunctionData, decodeFunctionResult, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kursOracleAbi } from "../src/abi.js";
import { feedId } from "../src/feeds.js";
import { roundOf, sign } from "../src/kurs.js";

const WS = process.argv[2] ?? "ws://127.0.0.1:9944";
const ORACLE_PVM = "../contracts/out-pvm/src_KursOracle_sol_KursOracle.polkavm";
const REMIT_PVM = "../ink/kurs_consumer/target/ink/kurs_consumer.polkavm";
const GAS = { refTime: 200_000_000_000n, proofSize: 3_000_000n };
const DEPOSIT = 10n ** 22n;

const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
const alice = new Keyring({ type: "sr25519" }).addFromUri("//Alice");

async function send(tx: SubmittableExtrinsic<"promise">, label: string) {
  return new Promise<{ events: any[]; hash: string }>((resolve, reject) => {
    tx.signAndSend(alice, ({ status, events, dispatchError, txHash }) => {
      if (dispatchError) {
        const msg = dispatchError.isModule
          ? (() => {
              const m = api.registry.findMetaError(dispatchError.asModule);
              return `${m.section}.${m.name}`;
            })()
          : dispatchError.toString();
        reject(new Error(`${label}: ${msg}`));
      } else if (status.isInBlock) {
        resolve({ events, hash: txHash.toHex() });
      }
    }).catch(reject);
  });
}

const instantiated = (events: any[]) => {
  const e = events.find(({ event }) => api.events.revive.Instantiated.is(event));
  if (!e) throw new Error("no Instantiated event");
  return e.event.data.contract.toHex() as Hex;
};

async function dryCall(dest: Hex, data: Hex) {
  const r: any = await api.call.reviveApi.call(alice.address, dest, 0, null, null, data);
  const out = r.result.toJSON() as any;
  if (!out.ok) throw new Error(`dry-run failed: ${JSON.stringify(out)}`);
  if (out.ok.flags & 1) throw new Error(`reverted: ${out.ok.data}`);
  return out.ok.data as Hex;
}

await send(api.tx.revive.mapAccount(), "mapAccount").catch((e) => console.log("(map)", e.message));

// 1. oracle with 5 reporters, quorum 3
const reporters = [1, 2, 3, 4, 5].map((i) => privateKeyToAccount(`0x${(i + 100).toString(16).padStart(64, "0")}`));
const ctorArgs = encodeAbiParameters(
  [{ type: "address[]" }, { type: "uint8" }],
  [reporters.map((r) => r.address), 3],
);
const oracleCode = readFileSync(ORACLE_PVM);
const dep = await send(
  api.tx.revive.instantiateWithCode(0, GAS, DEPOSIT, u8aToHex(oracleCode), ctorArgs, null),
  "deploy KursOracle",
);
const oracle = instantiated(dep.events);
console.log("KursOracle (Solidity via resolc)", oracle);

const IDR = feedId("USD/IDR");
const setFeed = encodeFunctionData({
  abi: kursOracleAbi,
  functionName: "setFeed",
  args: [IDR, "USD / IDR (Rupiah)", 8, 3600, 100, 100_000_000_000n, 10_000_000_000_000n],
});
await send(api.tx.revive.call(oracle, 0, GAS, DEPOSIT, setFeed), "setFeed");

// 2. a signed round
const now = Math.floor(Date.now() / 1000);
const round = roundOf(now);
const prices = [1_815_270_000_000n, 1_815_300_000_000n, 1_815_250_000_000n, 1_815_280_000_000n, 1_815_260_000_000n];
const obs = await Promise.all(reporters.map((r, i) => sign(r, "USD/IDR", round, prices[i], BigInt(now - 5))));
const transmit = encodeFunctionData({
  abi: kursOracleAbi,
  functionName: "transmit",
  args: [IDR, round, obs.map((o) => ({ answer: o.answer, observedAt: o.observedAt, v: o.v, r: o.r, s: o.s }))],
});
const tx = await send(api.tx.revive.call(oracle, 0, GAS, DEPOSIT, transmit), "transmit");
const latest = decodeFunctionResult({
  abi: kursOracleAbi,
  functionName: "latestRound",
  data: await dryCall(oracle, encodeFunctionData({ abi: kursOracleAbi, functionName: "latestRound", args: [IDR] })),
});
console.log("round on oracle", latest, "tx", tx.hash);

// 3. ink! consumer: new(oracle: H160, feed_id: [u8; 32], max_age: u64)
const maxAge = Buffer.alloc(8);
maxAge.writeBigUInt64LE(3600n);
const ctor = u8aToHex(new Uint8Array([...hexToU8a("0x9bae9d5e"), ...hexToU8a(oracle), ...hexToU8a(IDR), ...maxAge]));
const remitDep = await send(
  api.tx.revive.instantiateWithCode(0, GAS, DEPOSIT, u8aToHex(readFileSync(REMIT_PVM)), ctor, null),
  "deploy KursRemit",
);
const remit = instantiated(remitDep.events);
console.log("KursRemit (ink! v6)", remit);

// 4. ink! -> Solidity read. Result<(u128, i128, u64, u64), LangError>: 0x00 ++ 16 ++ 16 ++ 8 ++ 8 bytes LE
const raw = Buffer.from((await dryCall(remit, "0x46d8a35e")).slice(2), "hex");
if (raw[0] !== 0) throw new Error(`ink! LangError ${raw.toString("hex")}`);
const le = (b: Buffer) => b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
const inkRound = le(raw.subarray(1, 17));
const inkAnswer = le(raw.subarray(17, 33));
console.log("ink! latest() ->", { roundId: inkRound, answer: inkAnswer });
if (inkRound !== latest[0] || inkAnswer !== latest[1]) throw new Error("ink! read does not match the oracle");

// quote_and_log(100_00 USD cents) -> IDR cents, as a real transaction with an event
const amount = Buffer.alloc(16);
amount.writeBigUInt64LE(10_000n);
const q = await send(
  api.tx.revive.call(remit, 0, GAS, DEPOSIT, u8aToHex(new Uint8Array([...hexToU8a("0x37a2fa0a"), ...amount]))),
  "quote_and_log",
);
const emitted = q.events.find(({ event }) => api.events.revive.ContractEmitted.is(event));
console.log("quote_and_log tx", q.hash, "ContractEmitted:", emitted ? "yes" : "no");
console.log(`\nOK: ink! read round ${inkRound} = ${Number(inkAnswer) / 1e8} IDR per USD from the Solidity oracle`);
process.exit(0);
