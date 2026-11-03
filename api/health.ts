// GET /api/health: age of the latest round of every feed on every network.
// 200 when every feed with data is within 2x its heartbeat (Portaldot: the 64-minute
// slot-aligned cadence), 503 otherwise, so any uptime monitor can watch the relay.
import { createPublicClient, http, keccak256, toBytes, parseAbi, type Address } from "viem";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import sepolia from "../deployments/sepolia.json" with { type: "json" };
import { FEEDS } from "../reporter/src/feeds.js";

const abi = parseAbi(["function latestRound(bytes32) view returns (uint80, int192, uint64, uint64)"]);
const NETS = [
  { d: portaldot, rpc: "https://test-evm-rpc-v3.portaldot.dev", minHeartbeat: 64 * 60 },
  { d: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com", minHeartbeat: 0 },
];

export async function GET() {
  const now = Math.floor(Date.now() / 1000);
  const networks = await Promise.all(
    NETS.map(async ({ d, rpc, minHeartbeat }) => {
      const c = createPublicClient({ transport: http(rpc, { batch: true, retryCount: 2 }) });
      const feeds = await Promise.all(
        FEEDS.map(async (f) => {
          try {
            const [roundId, answer, , updatedAt] = await c.readContract({
              address: d.oracle as Address,
              abi,
              functionName: "latestRound",
              args: [keccak256(toBytes(f.pair))],
            });
            const age = updatedAt ? now - Number(updatedAt) : null;
            const limit = 2 * Math.max(f.heartbeat, minHeartbeat);
            return {
              pair: f.pair,
              roundId: roundId.toString(),
              answer: (Number(answer) / 10 ** f.decimals).toString(),
              ageSeconds: age,
              status: age === null ? "no data" : age <= limit ? "ok" : "stale",
            };
          } catch (e) {
            return { pair: f.pair, status: "unreadable", error: (e as Error).message.split("\n")[0] };
          }
        }),
      );
      return { chain: d.chain, oracle: d.oracle, feeds };
    }),
  );
  const bad = networks.flatMap((n) => n.feeds.filter((f) => f.status === "stale" || f.status === "unreadable"));
  return new Response(JSON.stringify({ ok: bad.length === 0, checkedAt: new Date(now * 1000).toISOString(), networks }), {
    status: bad.length === 0 ? 200 : 503,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" },
  });
}
