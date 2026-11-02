// GET /api/bundle?pair=USD/IDR
// Live signed bundle for one feed: every configured reporter reads the sources,
// signs its observation, and the response carries the ERC-7412 payload a client
// passes to KursOracle.fulfillOracleQuery. The same bundle verifies on every chain.
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { FEEDS, feedId } from "../reporter/src/feeds.js";
import { largestAgreeingWindow, observeAndSign, pullPayload, readFeed, toJson } from "../reporter/src/kurs.js";

const reporterKeys = () =>
  [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((i) => process.env[`REPORTER_${i}_PK`])
    .filter((k): k is string => !!k && /^0x[0-9a-fA-F]{64}$/.test(k))
    .map((k) => privateKeyToAccount(k as Hex));

// One read per pair per 10 s across warm invocations keeps free source APIs happy.
const cache = new Map<string, { at: number; body: string }>();
const TTL_MS = 10_000;

const json = (status: number, body: unknown, maxAge = 0) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });

export async function GET(request: Request) {
  const pair = new URL(request.url).searchParams.get("pair") ?? "";
  const feed = FEEDS.find((f) => f.pair === pair);
  if (!feed) return json(400, { error: `unknown pair "${pair}"`, pairs: FEEDS.map((f) => f.pair) });

  const keys = reporterKeys();
  if (keys.length === 0) return json(503, { error: "no reporter keys configured on this deployment" });

  const hit = cache.get(pair);
  if (hit && Date.now() - hit.at < TTL_MS) return json(200, hit.body, 5);

  const reading = await readFeed(feed);
  if (reading.answer === undefined) {
    return json(503, { error: "not enough sources answered", readings: reading.readings });
  }
  const signed = (await Promise.all(keys.map((k) => observeAndSign(k, [reading])))).flat();
  // every reporter here saw the same reading, so the window is the whole set; kept for parity with remote reporters
  const bundle = largestAgreeingWindow(signed, feed.maxSpreadBps);

  const body = JSON.stringify({
    pair,
    feedId: feedId(pair),
    decimals: feed.decimals,
    roundId: bundle[0].roundId.toString(),
    answer: reading.answer.toString(),
    sources: reading.readings,
    reporters: keys.map((k) => k.address),
    observations: bundle.map(toJson),
    // ERC-7412: KursOracle.fulfillOracleQuery(payload)
    payload: pullPayload(bundle),
  });
  cache.set(pair, { at: Date.now(), body });
  return json(200, body, 5);
}
