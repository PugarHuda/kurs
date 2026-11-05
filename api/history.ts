// GET /api/history?net=portaldot|sepolia&pair=USD/IDR[&limit=500]
// Every round a feed has ever had, rebuilt from RoundUpdated logs since the oracle's
// deployment block: history past the contract's 64-round ring buffer, without a
// separate indexer service. Logs are scanned in chunks the public RPCs accept,
// incrementally: each warm instance keeps what it scanned per (net, pair) and only
// reads new blocks, at most MAX_CHUNKS per request, so a request cannot fan out
// into an unbounded number of RPC calls.
export { preflight as OPTIONS } from "../lib/http.js";
import { transportFor } from "../lib/rpc.js";
import { createPublicClient, http, keccak256, parseAbiItem, toBytes, type Address, type Hex } from "viem";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import sepolia from "../deployments/sepolia.json" with { type: "json" };
import { FEEDS, findFeed } from "../reporter/src/feeds.js";

const NETS = {
  portaldot: { d: portaldot, rpc: "https://test-evm-rpc-v3.portaldot.dev", chunk: 100_000n },
  sepolia: { d: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com", chunk: 45_000n },
} as const;

const CORS = { "access-control-allow-origin": "*" }; // error bodies must be readable cross-origin too
const MAX_CHUNKS = 20n;
type Round = { roundId: string; answer: string; observedAt: string; signers: number; transmitter: string; block: number; tx: string };
// ponytail: per-instance memory; a shared store (KV) if instances multiply
const scanned = new Map<string, { next: bigint; rounds: Round[]; fromBlock: bigint }>();
const inflight = new Map<string, Promise<void>>(); // one scan per key at a time (concurrent requests)

const event = parseAbiItem(
  "event RoundUpdated(bytes32 indexed feedId, uint80 indexed roundId, int192 answer, uint64 observedAt, uint32 signerBitmap, address transmitter)",
);

export async function GET(req: Request) {
  const u = new URL(req.url);
  // "network" and "chain" are what the SDK and MCP call it; an unknown value is a 400, not a silent default
  const q = u.searchParams;
  const net = (q.get("net") ?? q.get("network") ?? q.get("chain") ?? "portaldot").toLowerCase() as keyof typeof NETS;
  const feed = findFeed(u.searchParams.get("pair") ?? "USD/IDR");
  const rawLimit = Number(u.searchParams.get("limit") ?? 500);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 5000) return Response.json({ error: "limit must be an integer 1..5000" }, { status: 400, headers: CORS });
  const limit = rawLimit;
  const n = Object.hasOwn(NETS, net) ? NETS[net] : undefined;
  if (!n || !feed) return Response.json({ error: "unknown net or pair", nets: Object.keys(NETS), pairs: FEEDS.map((f) => f.pair) }, { status: 400, headers: CORS });

  const pair = feed.pair;
  if (!(n.d.aggregators as Record<string, string>)[pair]) return Response.json({ error: `${pair} is not configured on ${net}` }, { status: 404, headers: CORS });
  const c = createPublicClient({ transport: transportFor(n.rpc, { retryCount: 2 }) });
  try {
    const key = `${net}|${pair}`;
    let st = scanned.get(key);
    if (!st) {
      // the oracle's deployment block, recorded in deployments/*.json: looking up the deploy
      // receipt on every cold start failed whenever a load-balanced public node had pruned it
      const from = "deployBlock" in n.d ? BigInt(n.d.deployBlock as number) : (await c.getTransactionReceipt({ hash: n.d.txs.deployOracle as Hex })).blockNumber;
      st = { next: from, rounds: [], fromBlock: from };
      scanned.set(key, st);
    }
    const head = await c.getBlockNumber();
    const feedId = keccak256(toBytes(pair));
    const state = st;
    const scan = async () => {
    for (let i = 0n; state.next <= head && i < MAX_CHUNKS; i++) {
      const to = state.next + n.chunk - 1n > head ? head : state.next + n.chunk - 1n;
      const logs = await c.getLogs({ address: n.d.oracle as Address, event, args: { feedId }, fromBlock: state.next, toBlock: to });
      for (const l of logs)
        state.rounds.push({
          roundId: l.args.roundId!.toString(),
          answer: (Number(l.args.answer) / 10 ** feed.decimals).toString(),
          observedAt: new Date(Number(l.args.observedAt) * 1000).toISOString(),
          signers: l.args.signerBitmap!.toString(2).split("").filter((b) => b === "1").length,
          transmitter: l.args.transmitter!,
          block: Number(l.blockNumber),
          tx: l.transactionHash!,
        });
      state.next = to + 1n;
    }
    };
    while (inflight.has(key)) await inflight.get(key);
    if (st.next <= head) {
      const p = scan().finally(() => inflight.delete(key));
      inflight.set(key, p);
      await p;
    }
    const rounds = [...st.rounds];
    rounds.reverse(); // newest first
    return Response.json(
      {
        net,
        pair,
        oracle: n.d.oracle,
        fromBlock: Number(st.fromBlock),
        toBlock: Number(st.next - 1n),
        partial: st.next <= head, // more blocks remain; the next request continues the scan
        total: rounds.length,
        rounds: rounds.slice(0, limit),
      },
      { headers: { "cache-control": "s-maxage=60, stale-while-revalidate=120", "access-control-allow-origin": "*" } },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message.split("\n")[0] }, { status: 502, headers: CORS });
  }
}
