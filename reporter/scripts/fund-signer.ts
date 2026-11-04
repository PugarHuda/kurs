// Tops up multisig signer A (sr25519) from the deployer's EVM key: A maps its account in
// pallet-revive (revive.mapAccount), so its H160 resolves to A itself, then the deployer
// sends tPOT to that H160 with an ordinary EVM transfer. Needed when A must reserve the
// pallet-multisig deposit (depositBase + 2 x depositFactor, returned on execution).
//   npx tsx scripts/fund-signer.ts [amount tPOT, default 10]
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clients } from "../src/chain.js";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const amount = process.argv[2] ?? "10";
const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
const A = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromMnemonic(process.env.SIGNER_A_MNEMONIC!);
const h160 = (await api.call.reviveApi.address(A.address)).toHex() as Address;
const mapped = !(await api.query.revive.originalAccount(h160)).isEmpty;
if (!mapped) {
  await new Promise<void>((res, rej) =>
    api.tx.revive.mapAccount().signAndSend(A, ({ status, dispatchError }) => {
      if (dispatchError) rej(new Error(dispatchError.toString()));
      if (status.isInBlock) res();
    }).catch(rej),
  );
  console.log(`A mapped: ${A.address} <-> ${h160}`);
}
const { pub, wallet } = clients("portaldot", privateKeyToAccount(process.env.DEPLOYER_PK as Hex));
const hash = await wallet!.sendTransaction({ to: h160, value: parseEther(amount), chain: wallet!.chain });
await pub.waitForTransactionReceipt({ hash });
const free = (await api.query.system.account(A.address)).data.free.toBigInt();
console.log(`sent ${amount} tPOT to A (${h160}) tx ${hash}; A free ${Number(free) / 1e14}`);
await api.disconnect();
