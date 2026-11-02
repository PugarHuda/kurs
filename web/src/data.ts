// Everything the page shows is read in the browser from public RPCs. No backend.
import { createPublicClient, defineChain, http, parseAbiItem, type Address, type Hex } from "viem";
import { foundry, sepolia } from "viem/chains";
import { kursOracleAbi } from "../../reporter/src/abi";
import { FEEDS, feedId, type FeedConfig } from "../../reporter/src/feeds";

export interface Deployment {
  chain: "portaldot" | "sepolia" | "local";
  chainId: number;
  oracle: Address;
  factory: Address;
  aggregators: Record<string, Address>;
  reporters: Address[];
  quorum: number;
  txs: Record<string, Hex>;
}

const files = import.meta.glob<Deployment>("../../deployments/*.json", { eager: true, import: "default" });
export const DEPLOYMENTS: Deployment[] = Object.values(files).filter((d) => import.meta.env.DEV || d.chain !== "local");

export const portaldot = defineChain({
  id: 420420777,
  name: "Portaldot V3 testnet",
  nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
  rpcUrls: { default: { http: ["https://test-evm-rpc-v3.portaldot.dev"] } },
});

export const NETWORKS = {
  portaldot: { chain: portaldot, label: "Portaldot V3 testnet", rpc: "https://test-evm-rpc-v3.portaldot.dev", logRange: 20_000n },
  sepolia: { chain: sepolia, label: "Ethereum Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com", logRange: 5_000n },
  local: { chain: foundry, label: "Local anvil", rpc: "http://127.0.0.1:8545", logRange: 100_000n },
} as const;

export const SUBSTRATE_RPC = "https://test-node-v3.portaldot.dev";

export const clientFor = (d: Deployment) =>
  createPublicClient({ chain: NETWORKS[d.chain].chain, transport: http(NETWORKS[d.chain].rpc) });

export interface RoundEvent {
  pair: string;
  roundId: bigint;
  answer: bigint;
  observedAt: number;
  signerBitmap: number;
  transmitter: Address;
  txHash: Hex;
  blockNumber: bigint;
}

export interface FeedState {
  feed: FeedConfig;
  roundId: bigint;
  answer: bigint;
  observedAt: number;
  updatedAt: number;
  history: RoundEvent[]; // oldest first
}

export interface Snapshot {
  deployment: Deployment;
  block: bigint;
  reporters: Address[];
  quorum: number;
  feeds: FeedState[];
}

const roundUpdated = parseAbiItem(
  "event RoundUpdated(bytes32 indexed feedId, uint80 indexed roundId, int192 answer, uint64 observedAt, uint32 signerBitmap, address transmitter)",
);

const pairById = new Map(FEEDS.map((f) => [feedId(f.pair), f.pair]));

export async function snapshot(d: Deployment): Promise<Snapshot> {
  const c = clientFor(d);
  const block = await c.getBlockNumber();
  const [reporters, quorum] = await Promise.all([
    c.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "reporters" }),
    c.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "quorum" }),
  ]);

  const range = NETWORKS[d.chain].logRange;
  const logs = await c
    .getLogs({ address: d.oracle, event: roundUpdated, fromBlock: block > range ? block - range : 0n, toBlock: block })
    .catch(() => []);
  const events: RoundEvent[] = logs.map((l) => ({
    pair: pairById.get(l.args.feedId!) ?? "?",
    roundId: l.args.roundId!,
    answer: l.args.answer!,
    observedAt: Number(l.args.observedAt!),
    signerBitmap: l.args.signerBitmap!,
    transmitter: l.args.transmitter!,
    txHash: l.transactionHash!,
    blockNumber: l.blockNumber!,
  }));

  const feeds = await Promise.all(
    FEEDS.map(async (feed): Promise<FeedState> => {
      const [roundId, answer, observedAt, updatedAt] = await c
        .readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "latestRound", args: [feedId(feed.pair)] })
        .catch(() => [0n, 0n, 0n, 0n] as const);
      return {
        feed,
        roundId,
        answer,
        observedAt: Number(observedAt),
        updatedAt: Number(updatedAt),
        history: events.filter((e) => e.pair === feed.pair),
      };
    }),
  );
  return { deployment: d, block, reporters: [...reporters], quorum, feeds };
}

// ------------------------------------------------------------ Portaldot native

async function substrate(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(SUBSTRATE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((x) => x.json());
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

const hexLE = (n: bigint, bytes: number) => {
  let s = "";
  for (let i = 0; i < bytes; i++) s += ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0");
  return s;
};
const readLE = (hex: string) => {
  let n = 0n;
  for (let i = hex.length - 2; i >= 0; i -= 2) n = (n << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  return n;
};
const asset = (id: number | "native") => (id === "native" ? "00" : "01" + hexLE(BigInt(id), 4));

/** Spot price of 1 `base` in `quote` from pallet-asset-conversion. */
export async function poolPrice(base: number | "native", quote: number | "native", bd: number, qd: number) {
  const call = "0x" + asset(base) + asset(quote) + hexLE(10n ** BigInt(bd), 16) + "00";
  const hex: string = await substrate("state_call", ["AssetConversionApi_quote_price_exact_tokens_for_tokens", call]);
  if (!hex.startsWith("0x01")) return undefined;
  return Number(readLE(hex.slice(4, 36))) / 10 ** qd;
}

/** TechnicalMembership.Members, which is the operator set of the native Oracle pallet. */
export async function oracleOperatorCount(): Promise<number> {
  const v: string | null = await substrate("state_getStorage", [
    "0x3a2d6c9353500637d8f8e3e0fa0bb1c5ba7fb8745735dc3be2a2c61a72c39e78",
  ]);
  if (!v || v === "0x00") return 0;
  // SCALE compact length prefix, single-byte mode is enough for a members list
  return parseInt(v.slice(2, 4), 16) >> 2;
}
