// GET /api/quote?amount=100&from=USD&to=IDR[&network=portaldot|sepolia][&maxAge=600]
// The MCP convert tool over plain HTTP: a direct feed, its inverse, or a pivot through USD,
// read from KursOracle on chain, with every round used and its age. maxAge (seconds)
// refuses the conversion (409) instead of answering with an older price.
import { NETS, QuoteError, convert, type Net } from "../lib/quote.js";
export { preflight as OPTIONS } from "../lib/http.js";

const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" };

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const network = (q.get("network") ?? q.get("net") ?? q.get("chain") ?? "portaldot").toLowerCase() as Net;
  if (!Object.hasOwn(NETS, network)) return new Response(JSON.stringify({ error: `unknown network "${network}"`, networks: Object.keys(NETS) }), { status: 400, headers });
  const amount = Number(q.get("amount") ?? 1);
  const maxAge = q.get("maxAge");
  if (maxAge !== null && !/^\d+$/.test(maxAge)) return new Response(JSON.stringify({ error: "maxAge must be whole seconds" }), { status: 400, headers });
  const from = q.get("from"), to = q.get("to");
  if (!from || !to) return new Response(JSON.stringify({ error: "from and to are required, e.g. ?amount=100&from=USD&to=IDR" }), { status: 400, headers });
  try {
    return new Response(JSON.stringify(await convert(amount, from, to, network, maxAge === null ? undefined : Number(maxAge))), { headers });
  } catch (e) {
    const status = e instanceof QuoteError ? e.status : 502;
    return new Response(JSON.stringify({ error: (e as Error).message.split("\n")[0] }), { status, headers });
  }
}
