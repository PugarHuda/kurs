// Buys one signed bundle from /api/x402 the way an x402 agent does: read the 402
// requirements, sign an EIP-3009 transferWithAuthorization for USDC, retry with X-PAYMENT.
//   PAYER_PK=0x... npx tsx scripts/pay-x402.ts USD/IDR
// The payer needs >= 0.001 USDC on Base Sepolia (https://faucet.circle.com), no ETH: the
// facilitator pays the gas.
import { toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

process.loadEnvFile?.(new URL("../../.env", import.meta.url));
const API = process.env.KURS_API ?? "https://kurs-ten-zeta.vercel.app";
const pair = process.argv[2] ?? "USD/IDR";
const url = `${API}/api/x402?pair=${encodeURIComponent(pair)}`;
const payer = privateKeyToAccount((process.env.PAYER_PK ?? process.env.REPORTER_1_PK) as Hex);

const first = await fetch(url);
if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
const req = (await first.json()).accepts[0];
console.log("402:", req.maxAmountRequired, "units of", req.asset, "on", req.network, "to", req.payTo);

const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: payer.address,
  to: req.payTo as Address,
  value: req.maxAmountRequired,
  validAfter: String(now - 60),
  validBefore: String(now + req.maxTimeoutSeconds),
  nonce: toHex(randomBytes(32)),
};
const signature = await payer.signTypedData({
  domain: { name: req.extra.name, version: req.extra.version, chainId: 84532, verifyingContract: req.asset },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
});
const xPayment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: req.network, payload: { signature, authorization } })).toString("base64");

const paid = await fetch(url, { headers: { "X-PAYMENT": xPayment } });
const body = await paid.json();
console.log(paid.status, paid.status === 200 ? `bundle round ${body.roundId ?? ""} payload ${String(body.payload).slice(0, 66)}…` : body);
const receipt = paid.headers.get("x-payment-response");
if (receipt) console.log("settled:", JSON.parse(Buffer.from(receipt, "base64").toString()));
