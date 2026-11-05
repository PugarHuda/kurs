// Keeps the relay funded after the hackathon: when the deployer (the relay's gas payer) falls below
// TOPUP_BELOW tPOT, claims the POT Starter Hub faucet (10 tPOT per wallet per 24 h) for the deployer
// and the 5 reporter keys, then waits for the claims to land. scripts/sweep.ts forwards them after.
//   npx tsx scripts/topup.ts            # exits 0 with "funded" when nothing is needed
import { createPublicClient, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAddress, cryptoWaitReady } from "@polkadot/util-crypto";

try { process.loadEnvFile?.(new URL("../../.env", import.meta.url)); } catch {} // CI passes the keys as env
const FAUCET = "https://pot-starter-hub.vercel.app/api/faucet";
const below = parseEther(process.env.TOPUP_BELOW ?? "100");
const pub = createPublicClient({ transport: http("https://test-evm-rpc-v3.portaldot.dev") });
await cryptoWaitReady();
// an EVM key's native account on pallet-revive is its H160 followed by 12 bytes of 0xEE
const native = (h160: string) => encodeAddress(new Uint8Array([...Buffer.from(h160.slice(2), "hex"), ...Array(12).fill(0xee)]), 42);

const deployer = privateKeyToAccount(process.env.DEPLOYER_PK as Hex).address;
const bal = await pub.getBalance({ address: deployer });
if (bal >= below) { console.log(`funded: deployer has ${formatEther(bal)} tPOT (threshold ${formatEther(below)})`); process.exit(0); }

const keys = ["DEPLOYER_PK", "REPORTER_1_PK", "REPORTER_2_PK", "REPORTER_3_PK", "REPORTER_4_PK", "REPORTER_5_PK"].filter((k) => process.env[k]);
const evm = keys.map((k) => privateKeyToAccount(process.env[k] as Hex).address);
const start = await Promise.all(evm.map((a) => pub.getBalance({ address: a })));
let claimed = 0;
for (const [i, a] of evm.entries()) {
  const ss58 = native(a);
  const el = await fetch(`${FAUCET}/eligibility/${ss58}`, { signal: AbortSignal.timeout(20_000) })
    .then((r) => r.json())
    .catch((e: Error) => ({ eligible: false, reason: `faucet unreachable (${e.name})` }));
  if (!el.eligible) { console.log(`${keys[i]}: ${el.reason}`); continue; }
  // ponytail: one claim at a time, the faucet backend settles each on chain (~10-60 s)
  const r = await fetch(`${FAUCET}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletAddress: ss58 }), signal: AbortSignal.timeout(180_000) }).catch((e) => e as Error);
  console.log(`${keys[i]}: ${r instanceof Error ? `request ended (${r.name}), the faucet may still settle it` : `${r.status} ${(await r.text()).slice(0, 100)}`}`);
  claimed++;
}
// wait up to 10 min for the claims to arrive so the sweep that follows forwards them
for (let t = 0; claimed && t < 20; t++) {
  const now = await Promise.all(evm.map((a) => pub.getBalance({ address: a })));
  const got = now.filter((b, i) => b > start[i]).length;
  if (got >= claimed) break;
  await new Promise((r) => setTimeout(r, 30_000));
}
console.log(`deployer ${formatEther(bal)} tPOT, ${claimed} claims sent`);
process.exit(0);
