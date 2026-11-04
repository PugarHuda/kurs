// Native (SS58) addresses and Portaldot balances of the keys in .env.
// An EVM key's native account on pallet-revive is its H160 followed by 12 bytes of 0xEE.
//   npx tsx scripts/wallets.ts
import { cryptoWaitReady, encodeAddress } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/keyring";
import { createPublicClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
await cryptoWaitReady();
const pub = createPublicClient({ transport: http("https://test-evm-rpc-v3.portaldot.dev") });
const evmNative = (h160: string) => encodeAddress(new Uint8Array([...Buffer.from(h160.slice(2), "hex"), ...Array(12).fill(0xee)]), 42);

const rows: [string, string, string][] = [];
for (const k of ["DEPLOYER_PK", "REPORTER_1_PK", "REPORTER_2_PK", "REPORTER_3_PK", "REPORTER_4_PK", "REPORTER_5_PK", "SAFE_SIGNER_1_PK", "SAFE_SIGNER_2_PK", "SAFE_SIGNER_3_PK"]) {
  const a = privateKeyToAccount(process.env[k] as Hex);
  rows.push([k, evmNative(a.address), formatEther(await pub.getBalance({ address: a.address }))]);
}
const kr = new Keyring({ type: "sr25519", ss58Format: 42 });
for (const k of ["SIGNER_A_MNEMONIC", "SIGNER_B_MNEMONIC", "SIGNER_C_MNEMONIC"]) rows.push([k, kr.addFromUri(process.env[k]!).address, "-"]);
for (const r of rows) console.log(r.join("\t"));
