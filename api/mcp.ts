// POST /api/mcp: a Model Context Protocol server (Streamable HTTP, stateless) so AI
// agents can use Kurs prices: list feeds, read the latest signed round on chain,
// convert amounts through USD, fetch round history, and get a signed bundle to pull on
// chain. Every number comes from the contracts or the same handlers as /api/*.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createPublicClient, http, keccak256, parseAbi, toBytes, type Address } from "viem";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import sepolia from "../deployments/sepolia.json" with { type: "json" };
import { FEEDS } from "../reporter/src/feeds.js";
import { GET as historyGET } from "./history.js";
import { GET as bundleGET } from "./bundle.js";

const NETS = {
  portaldot: { d: portaldot, rpc: "https://test-evm-rpc-v3.portaldot.dev" },
  sepolia: { d: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com" },
} as const;
const abi = parseAbi(["function latestRound(bytes32) view returns (uint80, int192, uint64, uint64)"]);
const pairs = FEEDS.map((f) => f.pair) as [string, ...string[]];
const Net = z.enum(["portaldot", "sepolia"]).default("portaldot").describe("network to read");
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });

async function latest(net: keyof typeof NETS, pair: string) {
  const n = NETS[net];
  const f = FEEDS.find((x) => x.pair === pair)!;
  const c = createPublicClient({ transport: http(n.rpc, { retryCount: 2 }) });
  const [roundId, answer, observedAt, updatedAt] = await c.readContract({ address: n.d.oracle as Address, abi, functionName: "latestRound", args: [keccak256(toBytes(pair))] });
  if (roundId === 0n) throw new Error(`${pair} has no round on ${net} yet`);
  return {
    network: net,
    pair,
    price: Number(answer) / 10 ** f.decimals,
    roundId: roundId.toString(),
    observedAt: new Date(Number(observedAt) * 1000).toISOString(),
    updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
    ageSeconds: Math.floor(Date.now() / 1000) - Number(updatedAt),
    oracle: n.d.oracle,
  };
}

/** USD value of one unit of `asset`, from X/USD or USD/X feeds. */
async function usdPer(net: keyof typeof NETS, asset: string) {
  if (asset === "USD") return { usd: 1, used: [] as string[] };
  if (pairs.includes(`${asset}/USD`)) return { usd: (await latest(net, `${asset}/USD`)).price, used: [`${asset}/USD`] };
  if (pairs.includes(`USD/${asset}`)) return { usd: 1 / (await latest(net, `USD/${asset}`)).price, used: [`USD/${asset}`] };
  throw new Error(`no USD feed for ${asset}`);
}

function server() {
  const s = new McpServer({ name: "kurs", version: "1.0.0" });

  s.registerTool(
    "list_feeds",
    { title: "List Kurs feeds", description: "Every Kurs price feed: pair, feedId (keccak256 of the pair), decimals, heartbeat, sources, and its Chainlink AggregatorV3 address per network.", inputSchema: {} },
    async () =>
      text(
        FEEDS.map((f) => ({
          pair: f.pair,
          description: f.description,
          feedId: keccak256(toBytes(f.pair)),
          decimals: f.decimals,
          heartbeatSeconds: f.heartbeat,
          sources: Object.keys(f.sources),
          aggregatorV3: { portaldot: (portaldot.aggregators as Record<string, string>)[f.pair] ?? null, sepolia: (sepolia.aggregators as Record<string, string>)[f.pair] ?? null },
        })),
      ),
  );

  s.registerTool(
    "get_price",
    { title: "Latest signed price", description: "Latest round of a feed read from the KursOracle contract: the median of the reporters' signed observations.", inputSchema: { pair: z.enum(pairs), network: Net } },
    async ({ pair, network }) => {
      try {
        return text(await latest(network, pair));
      } catch (e) {
        return fail((e as Error).message.split("\n")[0]);
      }
    },
  );

  s.registerTool(
    "convert",
    {
      title: "Convert an amount",
      description: "Convert between assets using on-chain Kurs prices, pivoting through USD (e.g. 100 USD to IDR, 1 BTC to IDR, 10 NVDA to ETH). Assets: USD and every base or quote of a USD feed.",
      inputSchema: { amount: z.number().positive(), from: z.string().toUpperCase(), to: z.string().toUpperCase(), network: Net },
    },
    async ({ amount, from, to, network }) => {
      try {
        const [a, b] = await Promise.all([usdPer(network, from), usdPer(network, to)]);
        return text({ amount, from, to, result: (amount * a.usd) / b.usd, network, feedsUsed: [...a.used, ...b.used] });
      } catch (e) {
        return fail((e as Error).message.split("\n")[0]);
      }
    },
  );

  s.registerTool(
    "get_history",
    { title: "Round history", description: "Past rounds of a feed rebuilt from RoundUpdated logs (newest first): price, signer count, block, transaction.", inputSchema: { pair: z.enum(pairs), network: Net, limit: z.number().int().min(1).max(200).default(20) } },
    async ({ pair, network, limit }) => {
      const r = await historyGET(new Request(`https://kurs.local/api/history?net=${network}&pair=${encodeURIComponent(pair)}&limit=${limit}`));
      const body = await r.json();
      return r.ok ? text(body) : fail(body.error ?? `history: HTTP ${r.status}`);
    },
  );

  s.registerTool(
    "get_signed_bundle",
    {
      title: "Signed bundle to pull on chain",
      description: "A fresh observation bundle signed by the Kurs reporters. Its payload goes to KursOracle.fulfillOracleQuery (ERC-7412) or KursPyth.updatePriceFeeds on any chain running Kurs.",
      inputSchema: { pair: z.enum(pairs) },
    },
    async ({ pair }) => {
      const r = await bundleGET(new Request(`https://kurs.local/api/bundle?pair=${encodeURIComponent(pair)}`));
      const body = await r.json();
      return r.ok ? text({ pair: body.pair, roundId: body.roundId, answer: body.answer, decimals: body.decimals, reporters: body.reporters, payload: body.payload }) : fail(body.error ?? `bundle: HTTP ${r.status}`);
    },
  );
  return s;
}

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id", "access-control-expose-headers": "mcp-session-id" };

export async function POST(req: Request) {
  // stateless: a fresh server and transport per request, nothing kept between calls
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server().connect(transport);
  const res = await transport.handleRequest(req);
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

export function GET() {
  // no server-initiated stream in stateless mode
  return new Response(JSON.stringify({ error: "POST JSON-RPC to this endpoint (MCP Streamable HTTP)" }), { status: 405, headers: { allow: "POST, OPTIONS", "content-type": "application/json", ...cors } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "POST, GET, OPTIONS" } });
}
