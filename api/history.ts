// GET /api/history?net=portaldot|sepolia&pair=USD/IDR[&limit=500]
// Every round a feed has ever had, rebuilt from RoundUpdated logs since the oracle's
// deployment block: history past the contract's 64-round ring buffer, without a
// separate indexer service. Logs are scanned in chunks the public RPCs accept.
import { createPublicClient, http, keccak256, parseAbiItem, toBytes, type Address, type Hex } from "viem";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import sepolia from "../deployments/sepolia.json" with { type: "json" };
import { FEEDS } from "../reporter/src/feeds.js";

const NETS = {
  portaldot: { d: portaldot, rpc: "https://test-evm-rpc-v3.portaldot.dev", chunk: 100_000n },
  sepolia: { d: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com", chunk: 45_000n },
} as const;

const event = parseAbiItem(
  "event RoundUpdated(bytes32 indexed feedId, uint80 indexed roundId, int192 answer, uint64 observedAt, uint32 signerBitmap, address transmitter)",
);

export async function GET(req: Request) {
  const u = new URL(req.url);
  const net = (u.searchParams.get("net") ?? "portaldot") as keyof typeof NETS;
  const pair = u.searchParams.get("pair") ?? "USD/IDR";
  const limit = Math.min(Number(u.searchParams.get("limit") ?? 500), 5000);
  const n = NETS[net];
  const feed = FEEDS.find((f) => f.pair === pair);
  if (!n || !feed) return Response.json({ error: "unknown net or pair", nets: Object.keys(NETS), pairs: FEEDS.map((f) => f.pair) }, { status: 400 });

  const c = createPublicClient({ transport: http(n.rpc, { retryCount: 2 }) });
  try {
    const deploy = await c.getTransactionReceipt({ hash: n.d.txs.deployOracle as Hex });
    const head = await c.getBlockNumber();
    const feedId = keccak256(toBytes(pair));
    const rounds = [];
    for (let from = deploy.blockNumber; from <= head; from += n.chunk) {
      const to = from + n.chunk - 1n > head ? head : from + n.chunk - 1n;
      const logs = await c.getLogs({ address: n.d.oracle as Address, event, args: { feedId }, fromBlock: from, toBlock: to });
      for (const l of logs)
        rounds.push({
          roundId: l.args.roundId!.toString(),
          answer: (Number(l.args.answer) / 10 ** feed.decimals).toString(),
          observedAt: new Date(Number(l.args.observedAt) * 1000).toISOString(),
          signers: l.args.signerBitmap!.toString(2).split("").filter((b) => b === "1").length,
          transmitter: l.args.transmitter,
          block: Number(l.blockNumber),
          tx: l.transactionHash,
        });
    }
    rounds.reverse(); // newest first
    return Response.json(
      { net, pair, oracle: n.d.oracle, fromBlock: Number(deploy.blockNumber), toBlock: Number(head), total: rounds.length, rounds: rounds.slice(0, limit) },
      { headers: { "cache-control": "s-maxage=60, stale-while-revalidate=120", "access-control-allow-origin": "*" } },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message.split("\n")[0] }, { status: 502 });
  }
}
