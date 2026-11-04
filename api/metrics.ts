// GET /api/metrics: Prometheus text exposition of the relay's state, for Grafana or any
// scraper. Built from /api/health's own reads plus the relayer's gas balance per network.
export { preflight as OPTIONS } from "../lib/http.js";
import { createPublicClient, http, formatEther, keccak256, toBytes, type Address } from "viem";
import { GET as health } from "./health.js";
import { kursOracleAbi, kursTwapAbi } from "../reporter/src/abi.js";
import { FEEDS } from "../reporter/src/feeds.js";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import sepolia from "../deployments/sepolia.json" with { type: "json" };

const RELAYER = "0x1d63E7A1cC358Cb40Aa6073b7c44Fd3c916b2540" as Address; // DEPLOYER_PK, pays relay gas
const RPC: Record<string, string> = {
  portaldot: "https://test-evm-rpc-v3.portaldot.dev",
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
};

type Feed = { pair: string; roundId?: string; answer?: string; ageSeconds?: number | null; status: string };
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export async function GET() {
  const h = await (await health()).json();
  const balances = await Promise.all(
    Object.entries(RPC).map(async ([chain, rpc]) => {
      try {
        const c = createPublicClient({ transport: http(rpc, { retryCount: 2 }) });
        return [chain, formatEther(await c.getBalance({ address: RELAYER }))] as const;
      } catch {
        return [chain, null] as const;
      }
    }),
  );
  // KursTwap 1 h averages on Sepolia (a window its history does not cover yet is left out)
  const sc = createPublicClient({ transport: http(RPC.sepolia, { retryCount: 2 }) });
  const twaps = (
    await Promise.all(
      Object.entries((sepolia as { twap?: Record<string, string> }).twap ?? {}).map(async ([pair, address]) => {
        try {
          const v = await sc.readContract({ address: address as Address, abi: kursTwapAbi, functionName: "consult", args: [3600] });
          return [pair, Number(v) / 1e8] as const; // every Kurs feed has 8 decimals
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((x): x is readonly [string, number] => !!x);
  // on-chain setFeed config vs reporter/src/feeds.ts: 1 = the owner must sync it (scripts/sync-feeds.ts)
  const KEYS = ["decimals", "maxSpreadBps", "heartbeat", "minAnswer", "maxAnswer", "description"] as const;
  const drift = (
    await Promise.all(
      [["portaldot", portaldot.oracle], ["sepolia", sepolia.oracle]].map(async ([chain, oracle]) => {
        const c = createPublicClient({ transport: http(RPC[chain], { batch: true, retryCount: 2 }) });
        return Promise.all(
          FEEDS.map(async (f) => {
            try {
              const cfg = (await c.readContract({ address: oracle as Address, abi: kursOracleAbi, functionName: "feed", args: [keccak256(toBytes(f.pair))] })) as Record<string, unknown>;
              return [`chain="${chain}",pair="${esc(f.pair)}"`, KEYS.some((k) => cfg[k] !== f[k]) ? 1 : 0] as [string, number];
            } catch {
              return undefined;
            }
          }),
        );
      }),
    )
  ).flat().filter((x): x is [string, number] => !!x);
  const out: string[] = [];
  const metric = (name: string, help: string, type: string, rows: [string, string | number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of rows) out.push(`${name}{${labels}} ${v}`);
  };
  const rows = (pick: (f: Feed) => string | number | undefined | null) =>
    h.networks.flatMap((n: { chain: string; feeds: Feed[] }) =>
      n.feeds.flatMap((f) => {
        const v = pick(f);
        return v === undefined || v === null ? [] : [[`chain="${esc(n.chain)}",pair="${esc(f.pair)}"`, v] as [string, string | number]];
      }),
    );
  metric("kurs_feed_age_seconds", "Seconds since the latest round was written on chain", "gauge", rows((f) => f.ageSeconds));
  metric("kurs_feed_answer", "Latest round answer (signed median), in units of the quote asset", "gauge", rows((f) => f.answer));
  metric("kurs_feed_round_id", "Latest round id", "gauge", rows((f) => f.roundId));
  metric("kurs_feed_up", "1 when the feed is within 2x its heartbeat", "gauge", rows((f) => (f.status === "ok" ? 1 : 0)));
  metric("kurs_twap_1h", "KursTwap time-weighted average over the last hour", "gauge", twaps.map(([p, v]) => [`chain="sepolia",pair="${esc(p)}"`, v]));
  // latest answer vs the 1 h average, in basis points: a sudden jump shows here first
  const spot = (p: string) => h.networks.find((n: { chain: string }) => n.chain === "sepolia")?.feeds.find((f: Feed) => f.pair === p)?.answer;
  metric("kurs_twap_deviation_bps", "Latest round vs its 1 h TWAP, in basis points", "gauge",
    twaps.flatMap(([p, v]) => (spot(p) ? [[`chain="sepolia",pair="${esc(p)}"`, Math.round(((Number(spot(p)) - v) / v) * 10_000)]] : [])) as [string, number][]);
  metric("kurs_feed_config_drift", "1 when the on-chain feed config differs from reporter/src/feeds.ts", "gauge", drift);
  metric("kurs_relayer_balance", "Relayer gas balance (tPOT on portaldot, ETH on sepolia)", "gauge",
    balances.filter(([, b]) => b !== null).map(([c, b]) => [`chain="${c}",address="${RELAYER}"`, b!]));
  metric("kurs_healthy", "1 when every feed is fresh and readable", "gauge", [["", h.ok ? 1 : 0]]);
  return new Response(out.join("\n").replace(/\{\} /g, " ") + "\n", {
    headers: { "content-type": "text/plain; version=0.0.4", "access-control-allow-origin": "*", "cache-control": "no-store" },
  });
}
