// GET /api/substrate: every Kurs feed on Portaldot read through the Substrate runtime
// API ReviveApi_call (node WebSocket only, no EVM RPC). Same numbers a polkadot.js or
// PAPI client, a wallet or an off-chain worker gets.
import { formatUnits, type Address } from "viem";
import portaldot from "../deployments/portaldot.json" with { type: "json" };
import { FEEDS } from "../reporter/src/feeds.js";
import { PORTALDOT_WS, connect, readViaSubstrate } from "../reporter/src/substrate.js";

export async function GET() {
  const api = await connect();
  try {
    const r = await readViaSubstrate(api, portaldot.oracle as Address, FEEDS.map((f) => f.pair));
    const body = {
      network: "Portaldot V3 testnet",
      via: "state_call ReviveApi_call (Substrate runtime API)",
      node: PORTALDOT_WS,
      oracle: portaldot.oracle,
      block: r.block,
      blockHash: r.blockHash,
      feeds: r.reads.map((x) => ({
        pair: x.pair,
        roundId: x.roundId.toString(),
        answer: formatUnits(x.answer, FEEDS.find((f) => f.pair === x.pair)!.decimals),
        updatedAt: new Date(Number(x.updatedAt) * 1000).toISOString(),
      })),
    };
    return Response.json(body, { headers: { "cache-control": "s-maxage=30, stale-while-revalidate=60", "access-control-allow-origin": "*" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  } finally {
    await api.disconnect();
  }
}
