// GET /api/feeds: every feed, its id, sources and on-chain addresses per network.
export { preflight as OPTIONS } from "../lib/http.js";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import sepolia from "../deployments/sepolia.json" with { type: "json" };
import { FEEDS, feedId } from "../reporter/src/feeds.js";

const deployments = [portaldot, sepolia];

export function GET() {
  const body = {
    feeds: FEEDS.map((f) => ({
      pair: f.pair,
      feedId: feedId(f.pair),
      description: f.description,
      decimals: f.decimals,
      heartbeat: f.heartbeat,
      deviationBps: f.deviationBps,
      maxSpreadBps: f.maxSpreadBps,
      sources: Object.keys(f.sources),
      aggregators: Object.fromEntries(deployments.map((d) => [d.chain, (d.aggregators as Record<string, string>)[f.pair] ?? null])),
    })),
    networks: deployments.map((d) => ({ chain: d.chain, chainId: d.chainId, oracle: d.oracle, reporters: d.reporters, quorum: d.quorum })),
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=60" },
  });
}
