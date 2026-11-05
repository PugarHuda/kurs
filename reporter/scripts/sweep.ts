// Forwards tPOT held by the reporter and Safe-signer keys and the multisig signers to the deployer, which
// pays the relay's gas. Reporters and Safe signers are EVM keys (EVM transfer, gas reserved); signers are
// sr25519 (balances.transferAll keep-alive, so the account and its existential deposit stay).
//   npx tsx scripts/sweep.ts
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import { createWalletClient, createPublicClient, formatEther, formatUnits, http, parseEther, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cryptoWaitReady } from "@polkadot/util-crypto";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const RPC = "https://test-evm-rpc-v3.portaldot.dev";
const deployer = privateKeyToAccount(process.env.DEPLOYER_PK as Hex);
const DEPLOYER_SS58 = "5CjEvXjS5WV7yUmqVQKoT9n1mTZpLQMcVaovDQXan1HAqYTx";
const pub = createPublicClient({ transport: http(RPC) });
const chain = { id: await pub.getChainId(), name: "portaldot", nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const before = await pub.getBalance({ address: deployer.address });

for (const k of ["REPORTER_1_PK", "REPORTER_2_PK", "REPORTER_3_PK", "REPORTER_4_PK", "REPORTER_5_PK", "SAFE_SIGNER_1_PK", "SAFE_SIGNER_2_PK", "SAFE_SIGNER_3_PK"]) {
  if (!process.env[k]) continue; // CI holds only the deployer and reporter keys
  const acct = privateKeyToAccount(process.env[k] as Hex);
  const bal = await pub.getBalance({ address: acct.address });
  if (bal < parseEther("1")) continue;
  const wallet = createWalletClient({ account: acct, chain, transport: http(RPC) });
  const gasPrice = await pub.getGasPrice();
  const gas = await pub.estimateGas({ account: acct, to: deployer.address, value: parseEther("0.5") });
  const value = bal - gas * gasPrice * 3n - parseEther("0.1"); // ponytail: fee margin + dust left behind
  const hash = await wallet.sendTransaction({ to: deployer.address, value, gas: gas * 2n, gasPrice });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`${k}: sent ${formatEther(value)} tx ${hash}`);
}

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
const kr = new Keyring({ type: "sr25519", ss58Format: 42 });
for (const k of ["A", "B", "C"]) {
  if (!process.env[`SIGNER_${k}_MNEMONIC`]) continue; // multisig keys never go to CI
  const pair = kr.addFromUri(process.env[`SIGNER_${k}_MNEMONIC`]!);
  const { data } = (await api.query.system.account(pair.address)) as any;
  // native balances use the chain's own decimals (14 on Portaldot), not the EVM's 18
  const dec = api.registry.chainDecimals[0];
  const free = BigInt(data.free.toString());
  // keep 2 tPOT: signers pay the multisig deposits and fees for owner actions
  if (free < parseUnits("5", dec)) { console.log(`signer ${k}: ${formatUnits(free, dec)} free, skipped`); continue; }
  const amount = free - parseUnits("2", dec);
  await new Promise<void>((res, rej) =>
    api.tx.balances.transferKeepAlive(DEPLOYER_SS58, amount).signAndSend(pair, ({ status, dispatchError, txHash }) => {
      if (dispatchError) rej(new Error(dispatchError.toString()));
      if (status.isInBlock) { console.log(`signer ${k}: sent ${formatUnits(amount, dec)} tx ${txHash.toHex()}`); res(); }
    }).catch(rej),
  );
}
await api.disconnect();
const after = await pub.getBalance({ address: deployer.address });
console.log(`deployer ${formatEther(before)} -> ${formatEther(after)} tPOT`);
