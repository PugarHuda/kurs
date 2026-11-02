import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { kursFactoryAbi, kursFactoryBytecode, kursOracleAbi, kursOracleBytecode } from "./abi.js";
import { FEEDS, feedId, type FeedConfig } from "./feeds.js";
import { CHAINS, selectBundle, type ChainKey, type SignedObservation } from "./kurs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const deploymentPath = (chain: ChainKey) => resolve(ROOT, "deployments", `${chain}.json`);

export interface Deployment {
  chain: ChainKey;
  chainId: number;
  oracle: Address;
  factory: Address;
  aggregators: Record<string, Address>;
  reporters: Address[];
  quorum: number;
  txs: Record<string, Hex>;
  deployedAt: string;
}

export function loadDeployment(chain: ChainKey): Deployment | undefined {
  const p = deploymentPath(chain);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

function saveDeployment(d: Deployment) {
  mkdirSync(dirname(deploymentPath(d.chain)), { recursive: true });
  writeFileSync(deploymentPath(d.chain), JSON.stringify(d, null, 2) + "\n");
}

export function clients(chain: ChainKey, account?: LocalAccount) {
  const c = CHAINS[chain];
  const rpc = chain === "sepolia" ? (process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com") : undefined;
  const transport = http(rpc, { timeout: 60_000 });
  const pollingInterval = chain === "local" ? 200 : 2_000;
  const pub = createPublicClient({ chain: c, transport, pollingInterval });
  const wallet = account ? createWalletClient({ chain: c, transport, account, pollingInterval }) : undefined;
  return { pub, wallet };
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------ deploy

export async function deploy(
  chain: ChainKey,
  deployer: LocalAccount,
  reporters: Address[],
  quorum: number,
  feeds: FeedConfig[] = FEEDS,
) {
  const { pub, wallet } = clients(chain, deployer);
  if (!wallet) throw new Error("no wallet");
  const txs: Record<string, Hex> = {};
  const prev = loadDeployment(chain);

  let oracle = prev?.oracle;
  if (!oracle) {
    log(`deploying KursOracle on ${chain} (${reporters.length} reporters, quorum ${quorum})`);
    const hash = await wallet.deployContract({
      abi: kursOracleAbi,
      bytecode: kursOracleBytecode,
      args: [reporters, quorum],
    });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (!rc.contractAddress) throw new Error(`oracle deploy failed ${hash}`);
    oracle = rc.contractAddress;
    txs.deployOracle = hash;
    log("KursOracle", oracle, hash);
  }

  let factory = prev?.factory;
  if (!factory) {
    const hash = await wallet.deployContract({ abi: kursFactoryAbi, bytecode: kursFactoryBytecode, args: [oracle] });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (!rc.contractAddress) throw new Error(`factory deploy failed ${hash}`);
    factory = rc.contractAddress;
    txs.deployFactory = hash;
    log("KursAggregatorFactory", factory, hash);
  }

  const d: Deployment = {
    chain,
    chainId: CHAINS[chain].id,
    oracle,
    factory,
    aggregators: prev?.aggregators ?? {},
    reporters,
    quorum,
    txs: { ...prev?.txs, ...txs },
    deployedAt: prev?.deployedAt ?? new Date().toISOString(),
  };
  saveDeployment(d);
  await configure(chain, deployer, feeds);
  return loadDeployment(chain)!;
}

/** Makes on-chain feed config match FEEDS and gives each feed an AggregatorV3 clone. */
export async function configure(chain: ChainKey, owner: LocalAccount, feeds: FeedConfig[] = FEEDS) {
  const d = loadDeployment(chain);
  if (!d) throw new Error(`no deployment for ${chain}`);
  const { pub, wallet } = clients(chain, owner);
  if (!wallet) throw new Error("no wallet");

  for (const f of feeds) {
    const id = feedId(f.pair);
    const cur = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "feed", args: [id] });
    const same =
      cur.exists &&
      cur.description === f.description &&
      cur.decimals === f.decimals &&
      cur.heartbeat === f.heartbeat &&
      cur.maxSpreadBps === f.maxSpreadBps &&
      cur.minAnswer === f.minAnswer &&
      cur.maxAnswer === f.maxAnswer;
    if (!same) {
      const hash = await wallet.writeContract({
        address: d.oracle,
        abi: kursOracleAbi,
        functionName: "setFeed",
        args: [id, f.description, f.decimals, f.heartbeat, f.maxSpreadBps, f.minAnswer, f.maxAnswer],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      d.txs[`setFeed ${f.pair}`] = hash;
      log("setFeed", f.pair, hash);
    }
    if (!d.aggregators[f.pair]) {
      const hash = await wallet.writeContract({
        address: d.factory,
        abi: kursFactoryAbi,
        functionName: "deploy",
        args: [id],
      });
      await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      d.aggregators[f.pair] = await pub.readContract({
        address: d.factory,
        abi: kursFactoryAbi,
        functionName: "aggregatorOf",
        args: [id],
      });
      d.txs[`aggregator ${f.pair}`] = hash;
      log("aggregator", f.pair, d.aggregators[f.pair]);
    }
    saveDeployment(d);
  }
}

// ------------------------------------------------------------------ transmit

export interface TransmitResult {
  chain: ChainKey;
  pair: string;
  roundId: bigint;
  answer?: bigint;
  hash?: Hex;
  skipped?: string;
  error?: string;
}

/**
 * Decides per feed whether a round is due (deviation or heartbeat) and submits
 * the signed bundle. Anyone can run this: the contract trusts signatures, not the sender.
 */
export async function transmit(
  chain: ChainKey,
  transmitter: LocalAccount,
  observations: SignedObservation[],
  feeds: FeedConfig[] = FEEDS,
): Promise<TransmitResult[]> {
  const d = loadDeployment(chain);
  if (!d) throw new Error(`no deployment for ${chain}`);
  const { pub, wallet } = clients(chain, transmitter);
  if (!wallet) throw new Error("no wallet");
  const [quorum, reporters] = await Promise.all([
    pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "quorum" }),
    pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "reporters" }),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const results: TransmitResult[] = [];

  for (const f of feeds) {
    const id = feedId(f.pair);
    const obs = await selectBundle(
      observations.filter((o) => o.feedId === id),
      reporters,
    );
    const roundId = obs[0]?.roundId ?? 0n;
    const base = { chain, pair: f.pair, roundId };
    if (obs.length < quorum) {
      results.push({ ...base, skipped: `only ${obs.length}/${quorum} reporters` });
      continue;
    }
    const sorted = obs.map((o) => o.answer).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const mid = sorted.length >> 1;
    const answer = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;

    const [latestId, last, , updatedAt] = await pub.readContract({
      address: d.oracle,
      abi: kursOracleAbi,
      functionName: "latestRound",
      args: [id],
    });
    if (roundId <= latestId) {
      results.push({ ...base, answer, skipped: "round already on chain" });
      continue;
    }
    const age = now - Number(updatedAt);
    const moveBps = last === 0n ? Infinity : Number(((answer - last) * 10_000n) / (last < 0n ? -last : last));
    const due = latestId === 0n || age >= f.heartbeat || Math.abs(moveBps) >= f.deviationBps;
    if (!due && process.env.KURS_FORCE !== "1") {
      results.push({ ...base, answer, skipped: `fresh (${age}s old, moved ${moveBps}bps)` });
      continue;
    }
    try {
      const hash = await wallet.writeContract({
        address: d.oracle,
        abi: kursOracleAbi,
        functionName: "transmit",
        args: [
          id,
          roundId,
          obs.map((o) => ({ answer: o.answer, observedAt: o.observedAt, v: o.v, r: o.r, s: o.s })),
        ],
      });
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== "success") throw new Error(`reverted ${hash}`);
      results.push({ ...base, answer, hash });
    } catch (e) {
      results.push({ ...base, answer, error: (e as Error).message.split("\n")[0].slice(0, 200) });
    }
  }
  return results;
}
