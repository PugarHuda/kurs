// Everything the page shows is read in the browser from public RPCs. No backend.
import { createPublicClient, defineChain, http, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
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
  /** KursConverter: ERC-7412 pull consumer for USD/IDR */
  converter?: Address;
  /** KursTwap per pair (time-weighted average over the oracle's rounds) */
  twap?: Record<string, Address>;
  governance?: {
    type: string;
    threshold: number;
    signatories: string[];
    account: string;
    h160: Address;
    /** pallet-proxy timelock: a pure proxy owned by the multisig with a delay */
    timelock?: { pure?: string; pureH160?: Address; delayBlocks: number };
  };
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

// One client per network, with JSON-RPC batching: a page load sends a handful of
// HTTP requests instead of one per call, which keeps public RPCs from rate-limiting
// the browser (their error responses carry no CORS header and surface as CORS errors).
const clients = new Map<string, PublicClient>();
export const clientFor = (d: Deployment) => {
  let c = clients.get(d.chain);
  if (!c) {
    c = createPublicClient({
      chain: NETWORKS[d.chain].chain,
      transport: http(NETWORKS[d.chain].rpc, { batch: { batchSize: 25, wait: 20 }, retryCount: 3, retryDelay: 400 }),
    }) as PublicClient;
    clients.set(d.chain, c);
  }
  return c;
};

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
  // logs and state are independent: read them in parallel (getLogs is the slow one)
  const logsP = c
    .getLogs({ address: d.oracle, event: roundUpdated, fromBlock: block > range ? block - range : 0n, toBlock: block })
    .catch(() => []);
  const latestP = Promise.all(
    FEEDS.map((feed) =>
      c
        .readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "latestRound", args: [feedId(feed.pair)] })
        .catch(() => [0n, 0n, 0n, 0n] as const),
    ),
  );
  const [logs, latest] = await Promise.all([logsP, latestP]);
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
  const feeds = FEEDS.map((feed, i): FeedState => {
    const [roundId, answer, observedAt, updatedAt] = latest[i];
    return {
      feed,
      roundId,
      answer,
      observedAt: Number(observedAt),
      updatedAt: Number(updatedAt),
      history: events.filter((e) => e.pair === feed.pair),
    };
  });
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

/** The oracle's current owner, read from the contract. */
export async function ownerOf(d: Deployment): Promise<Address> {
  return clientFor(d).readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "owner" });
}
