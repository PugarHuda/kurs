// GET /api/health: age of the latest round of every feed on every network.
// 200 when every feed with data is within 2x its heartbeat (Portaldot: the 64-minute
// slot-aligned cadence), 503 otherwise, so any uptime monitor can watch the relay.
export { preflight as OPTIONS } from "../lib/http.js";
import { transportFor } from "../lib/rpc.js";
import { createPublicClient, http, keccak256, toBytes, parseAbi, type Address, type Hex } from "viem";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import sepolia from "../deployments/sepolia.json" with { type: "json" };
import { FEEDS } from "../reporter/src/feeds.js";

const abi = parseAbi(["function latestRound(bytes32) view returns (uint80, int192, uint64, uint64)"]);
const feedIdsAbi = parseAbi(["function feedIds() view returns (bytes32[])"]);
const RELAYER = "0x1d63E7A1cC358Cb40Aa6073b7c44Fd3c916b2540" as Address; // DEPLOYER_PK, pays relay gas
const PORTALDOT_BURN_PER_HOUR = 0.5; // measured: ~0.105 tPOT per slot-aligned round across 13 feeds
const NETS = [
  { d: portaldot, rpc: "https://test-evm-rpc-v3.portaldot.dev", minHeartbeat: 64 * 60 },
  { d: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com", minHeartbeat: 0 },
];

export async function GET() {
  const now = Math.floor(Date.now() / 1000);
  const networks = await Promise.all(
    NETS.map(async ({ d, rpc, minHeartbeat }) => {
      const c = createPublicClient({ transport: transportFor(rpc, { batch: true, retryCount: 2 }) });
      // feeds the owner has not configured on this chain yet (setFeed) are listed, not failures
      const configured = new Set(
        (await c.readContract({ address: d.oracle as Address, abi: feedIdsAbi, functionName: "feedIds" }).catch(() => [] as readonly Hex[])).map((x) => x.toLowerCase()),
      );
      const feeds = await Promise.all(
        FEEDS.map(async (f) => {
          if (configured.size && !configured.has(keccak256(toBytes(f.pair)).toLowerCase())) return { pair: f.pair, status: "not configured" };
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
      // the transmitter only pays gas; on Portaldot its tPOT is the feeds' remaining runway
      const gas = await c.getBalance({ address: RELAYER }).then((b) => Number(b) / 1e18).catch(() => null);
      const relay = { transmitter: RELAYER, balance: gas, ...(d.chain === "portaldot" && gas !== null ? { runwayHours: Math.floor(gas / PORTALDOT_BURN_PER_HOUR) } : {}) };
      return { chain: d.chain, oracle: d.oracle, relay, feeds };
    }),
  );
  const bad = networks.flatMap((n) => n.feeds.filter((f) => f.status === "stale" || f.status === "unreadable"));
  return new Response(JSON.stringify({ ok: bad.length === 0, checkedAt: new Date(now * 1000).toISOString(), networks }), {
    status: bad.length === 0 ? 200 : 503,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" },
  });
}
