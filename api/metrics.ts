// GET /api/metrics: Prometheus text exposition of the relay's state, for Grafana or any
// scraper. Built from /api/health's own reads plus the relayer's gas balance per network.
import { createPublicClient, http, formatEther, type Address } from "viem";
import { GET as health } from "./health.js";

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
  metric("kurs_relayer_balance", "Relayer gas balance (tPOT on portaldot, ETH on sepolia)", "gauge",
    balances.filter(([, b]) => b !== null).map(([c, b]) => [`chain="${c}",address="${RELAYER}"`, b!]));
  metric("kurs_healthy", "1 when every feed is fresh and readable", "gauge", [["", h.ok ? 1 : 0]]);
  return new Response(out.join("\n").replace(/\{\} /g, " ") + "\n", {
    headers: { "content-type": "text/plain; version=0.0.4", "access-control-allow-origin": "*", "cache-control": "no-store" },
  });
}
