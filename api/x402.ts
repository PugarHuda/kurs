// GET /api/x402?pair=USD/IDR: the signed bundle of /api/bundle behind an x402 paywall
// (HTTP 402, x402 v1 "exact" scheme), so an agent can pay per fresh signed price with
// no account or API key. /api/bundle itself stays free.
//
// Without X-PAYMENT: 402 + PaymentRequirements (0.001 USDC on Base Sepolia to the relayer).
// With X-PAYMENT: the public x402.org facilitator verifies the EIP-3009 authorization,
// the bundle is built, then the payment is settled and X-PAYMENT-RESPONSE returned.
// ponytail: settles before returning; a failed settle returns 402 and no bundle.
import { GET as bundle } from "./bundle.js";
import { FEEDS } from "../reporter/src/feeds.js";

const FACILITATOR = process.env.X402_FACILITATOR ?? "https://x402.org/facilitator";
const PAY_TO = "0x1d63E7A1cC358Cb40Aa6073b7c44Fd3c916b2540";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const requirements = (resource: string, pair: string) => ({
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "1000", // 0.001 USDC (6 decimals)
  resource,
  description: `Kurs signed bundle for ${pair}: 5 reporter EIP-712 signatures, verifiable on chain`,
  mimeType: "application/json",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  asset: USDC_BASE_SEPOLIA,
  extra: { name: "USDC", version: "2" },
});

const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "X-PAYMENT-RESPONSE",
      "cache-control": "no-store",
      ...extra,
    },
  });

async function facilitator(path: "verify" | "settle", paymentPayload: unknown, paymentRequirements: unknown) {
  const r = await fetch(`${FACILITATOR}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements }),
  });
  if (!r.ok) throw new Error(`facilitator ${path}: HTTP ${r.status}`);
  return r.json();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pair = url.searchParams.get("pair") ?? "";
  if (!FEEDS.some((f) => f.pair === pair)) return reply(400, { error: `unknown pair "${pair}"`, pairs: FEEDS.map((f) => f.pair) });
  const req = requirements(url.toString(), pair);
  const header = request.headers.get("x-payment");
  if (!header) return reply(402, { x402Version: 1, error: "X-PAYMENT header is required", accepts: [req] });

  let payment: unknown;
  try {
    payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return reply(402, { x402Version: 1, error: "X-PAYMENT is not base64 JSON", accepts: [req] });
  }
  try {
    const v = await facilitator("verify", payment, req);
    if (!v.isValid) return reply(402, { x402Version: 1, error: v.invalidReason ?? "payment invalid", accepts: [req] });
    const b = await bundle(new Request(`${url.origin}/api/bundle?pair=${encodeURIComponent(pair)}`));
    if (b.status !== 200) return new Response(b.body, { status: b.status, headers: b.headers }); // not charged
    const s = await facilitator("settle", payment, req);
    if (!s.success) return reply(402, { x402Version: 1, error: s.errorReason ?? "settlement failed", accepts: [req] });
    return new Response(await b.text(), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "X-PAYMENT-RESPONSE",
        "cache-control": "no-store",
        "x-payment-response": Buffer.from(JSON.stringify(s)).toString("base64"),
      },
    });
  } catch (e) {
    return reply(502, { error: (e as Error).message });
  }
}
