// POST /api/mcp: a Model Context Protocol server (Streamable HTTP, stateless) so AI
// agents can use Kurs prices: list feeds, read the latest signed round on chain,
// convert amounts through USD, fetch round history, and get a signed bundle to pull on
// chain. Every number comes from the contracts or the same handlers as /api/*.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createPublicClient, decodeAbiParameters, http, keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from "viem";
import { kursOracleAbi, kursTwapAbi } from "../reporter/src/abi.js";
import { DOMAIN, TYPES } from "../reporter/src/eip712.js";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import sepolia from "../deployments/sepolia.json" with { type: "json" };
import { NETS, convert, latest, pairs } from "../lib/quote.js";
import { FEEDS } from "../reporter/src/feeds.js";
import { GET as historyGET } from "./history.js";
import { GET as bundleGET } from "./bundle.js";

const Net = z.enum(["portaldot", "sepolia"]).default("portaldot").describe("network to read");
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });

const payloadParams = [
  { type: "bytes32" },
  { type: "uint80" },
  { type: "tuple[]", components: [{ name: "answer", type: "int192" }, { name: "observedAt", type: "uint64" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
] as const;

/** Decodes a fulfillOracleQuery payload and recovers each observation's EIP-712 signer. */
async function recoverPayload(payload: Hex) {
  const [feedId, roundId, obs] = decodeAbiParameters(payloadParams, payload);
  const observations = await Promise.all(
    obs.map(async (o) => ({
      signer: await recoverTypedDataAddress({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Observation",
        message: { feedId, roundId, answer: o.answer, observedAt: o.observedAt },
        signature: `${o.r}${o.s.slice(2)}${o.v.toString(16).padStart(2, "0")}` as Hex,
      }),
      answer: o.answer,
      observedAt: Number(o.observedAt),
    })),
  );
  return { feedId, roundId, observations };
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
      description:
        "Convert between assets using on-chain Kurs prices: a direct feed, its inverse, or a pivot through USD (e.g. 100 USD to IDR, 1 BTC to IDR, 10 NVDA to ETH, 50 tPOT to pUSD). Symbols are case-insensitive. Every round used is returned with its age; set maxAgeSeconds to refuse a conversion that would use an older price.",
      inputSchema: {
        amount: z.number().positive(),
        from: z.string().min(1),
        to: z.string().min(1),
        network: Net,
        maxAgeSeconds: z.number().int().positive().optional().describe("refuse if any price used is older than this"),
      },
    },
    async ({ amount, from, to, network, maxAgeSeconds }) => {
      try {
        return text(await convert(amount, from, to, network, maxAgeSeconds));
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
  s.registerTool(
    "verify_bundle",
    {
      title: "Verify a signed bundle",
      description:
        "Check a Kurs bundle payload (from get_signed_bundle, /api/bundle or anyone else) without trusting its source: recover every EIP-712 signer and compare with the reporter set and quorum read from the oracle on chain.",
      inputSchema: { payload: z.string().regex(/^0x[0-9a-fA-F]+$/), network: Net },
    },
    async ({ payload, network }) => {
      let v;
      try {
        v = await recoverPayload(payload as Hex);
      } catch (e) {
        return fail(`not a Kurs bundle payload: ${(e as Error).message.split("\n")[0]}`);
      }
      try {
        const n = NETS[network];
        const c = createPublicClient({ transport: http(n.rpc, { retryCount: 2 }) });
        const [reporters, quorum] = await Promise.all([
          c.readContract({ address: n.d.oracle as Address, abi: kursOracleAbi, functionName: "reporters" }),
          c.readContract({ address: n.d.oracle as Address, abi: kursOracleAbi, functionName: "quorum" }),
        ]);
        const set = new Set(reporters.map((r) => r.toLowerCase()));
        const good = new Set(v.observations.map((o) => o.signer.toLowerCase()).filter((a) => set.has(a)));
        const f = FEEDS.find((x) => keccak256(toBytes(x.pair)) === v.feedId);
        // the median the contract would store: distinct current reporters only
        const seen = new Set<string>();
        const answers = v.observations
          .filter((o) => set.has(o.signer.toLowerCase()) && !seen.has(o.signer.toLowerCase()) && seen.add(o.signer.toLowerCase()))
          .map((o) => o.answer)
          .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
        const m = answers.length >> 1;
        const median = answers.length === 0 ? undefined : answers.length % 2 ? answers[m] : (answers[m - 1] + answers[m]) / 2n;
        return text({
          valid: good.size >= quorum,
          network,
          pair: f?.pair ?? null,
          roundId: v.roundId.toString(),
          quorum,
          distinctReporters: good.size,
          median: median === undefined ? null : f ? Number(median) / 10 ** f.decimals : median.toString(),
          observations: v.observations.map((o) => ({
            signer: o.signer,
            isReporter: set.has(o.signer.toLowerCase()),
            answer: o.answer.toString(),
            observedAt: new Date(o.observedAt * 1000).toISOString(),
          })),
        });
      } catch (e) {
        return fail((e as Error).message.split("\n")[0]);
      }
    },
  );

  s.registerTool(
    "get_twap",
    {
      title: "Time-weighted average price",
      description:
        "Time-weighted average of a feed over the last windowSeconds, from its KursTwap contract on Sepolia (BTC/USD, USD/IDR). One round moves it far less than it moves the latest price.",
      inputSchema: { pair: z.enum(["BTC/USD", "USD/IDR"]), windowSeconds: z.number().int().min(60).max(172_800) },
    },
    async ({ pair, windowSeconds }) => {
      const address = (sepolia as { twap?: Record<string, string> }).twap?.[pair] as Address | undefined;
      if (!address) return fail(`no KursTwap for ${pair}`);
      try {
        const c = createPublicClient({ transport: http(NETS.sepolia.rpc, { retryCount: 2 }) });
        const [avg, oldest, spot] = await Promise.all([
          c.readContract({ address, abi: kursTwapAbi, functionName: "consult", args: [windowSeconds] }),
          c.readContract({ address, abi: kursTwapAbi, functionName: "oldest" }),
          latest("sepolia", pair),
        ]);
        const d = FEEDS.find((x) => x.pair === pair)!.decimals;
        return text({
          network: "sepolia",
          pair,
          windowSeconds,
          twap: Number(avg) / 10 ** d,
          latest: spot.price,
          historyFrom: new Date(Number(oldest) * 1000).toISOString(),
          twapContract: address,
        });
      } catch (e) {
        return fail(`${(e as Error).message.split("\n")[0]} (the TWAP history may not reach back windowSeconds yet)`);
      }
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
