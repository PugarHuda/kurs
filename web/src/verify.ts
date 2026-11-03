// Re-checks a round in the browser, without trusting this page or any server:
// fetch the transaction, decode the signed observations from its calldata,
// recover every signer with EIP-712 and recompute the median.
import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbi,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { kursOracleAbi } from "../../reporter/src/abi";
import { DOMAIN, TYPES } from "../../reporter/src/eip712";

const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])",
]);

interface Obs {
  answer: bigint;
  observedAt: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

export interface CheckedObservation {
  signer: Address;
  answer: bigint;
  observedAt: number;
  isReporter: boolean;
}

export interface Verification {
  path: string; // how the round reached the chain
  feedId: Hex;
  roundId: bigint;
  observations: CheckedObservation[];
  median: bigint;
}

const payloadParams = [
  { type: "bytes32" },
  { type: "uint80" },
  {
    type: "tuple[]",
    components: [
      { name: "answer", type: "int192" },
      { name: "observedAt", type: "uint64" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
  },
] as const;

const pythAbi = parseAbi(["function updatePriceFeeds(bytes[] updateData) payable"]);

type Found = { path: string; feedId: Hex; roundId: bigint; obs: readonly Obs[] };

/** Every (feedId, roundId, observations) in a transaction that lands Kurs rounds: transmit,
 * fulfillOracleQuery, a Multicall3 batch of those, or KursPyth.updatePriceFeeds. */
function extractAll(oracle: Address, to: Address | null, input: Hex): Found[] {
  if (to && to.toLowerCase() === oracle.toLowerCase()) {
    const call = decodeFunctionData({ abi: kursOracleAbi, data: input });
    if (call.functionName === "transmit") {
      const [feedId, roundId, obs] = call.args as [Hex, bigint, readonly Obs[]];
      return [{ path: "push: transmit", feedId, roundId, obs }];
    }
    if (call.functionName === "fulfillOracleQuery") {
      const [feedId, roundId, obs] = decodeAbiParameters(payloadParams, (call.args as [Hex])[0]);
      return [{ path: "pull: ERC-7412 fulfillOracleQuery", feedId, roundId, obs }];
    }
    throw new Error(`unexpected oracle call ${call.functionName}`);
  }
  if (input.slice(0, 10) === "0xef9e5e28") {
    // KursPyth.updatePriceFeeds(bytes[]): each element is a fulfillOracleQuery payload
    const { args } = decodeFunctionData({ abi: pythAbi, data: input });
    return args[0].map((u) => {
      const [feedId, roundId, obs] = decodeAbiParameters(payloadParams, u);
      return { path: "pull: Pyth updatePriceFeeds via KursPyth", feedId, roundId, obs };
    });
  }
  const mc = decodeFunctionData({ abi: multicallAbi, data: input });
  return (mc.args[0] as readonly { target: Address; callData: Hex }[])
    .filter((c) => c.target.toLowerCase() === oracle.toLowerCase())
    .flatMap((c) => extractAll(oracle, oracle, c.callData).map((g) => ({ ...g, path: `${g.path} inside Multicall3` })));
}

/** The round `want` from the transaction (a batch can carry several feeds), else the first. */
function extract(oracle: Address, to: Address | null, input: Hex, want?: { feedId: Hex; roundId: bigint }): Found {
  const all = extractAll(oracle, to, input);
  const hit = want ? all.find((f) => f.feedId.toLowerCase() === want.feedId.toLowerCase() && f.roundId === want.roundId) : all[0];
  if (!hit) throw new Error(want ? "this transaction does not carry that round" : "no Kurs round in this transaction");
  return hit;
}

export function median(xs: bigint[]): bigint {
  const a = [...xs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2n;
}

export async function recoverAll(feedId: Hex, roundId: bigint, obs: readonly Obs[], reporters: readonly Address[]) {
  const set = new Set(reporters.map((r) => r.toLowerCase()));
  return Promise.all(
    obs.map(async (o): Promise<CheckedObservation> => {
      const signer = await recoverTypedDataAddress({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Observation",
        message: { feedId, roundId, answer: o.answer, observedAt: o.observedAt },
        signature: `${o.r}${o.s.slice(2)}${o.v.toString(16).padStart(2, "0")}` as Hex,
      });
      return { signer, answer: o.answer, observedAt: Number(o.observedAt), isReporter: set.has(signer.toLowerCase()) };
    }),
  );
}

export async function verifyRound(
  client: PublicClient,
  oracle: Address,
  txHash: Hex,
  reporters: readonly Address[],
  want?: { feedId: Hex; roundId: bigint },
): Promise<Verification> {
  const tx = await client.getTransaction({ hash: txHash });
  const { path, feedId, roundId, obs } = extract(oracle, tx.to ?? null, tx.input, want);
  const observations = await recoverAll(feedId, roundId, obs, reporters);
  return { path, feedId, roundId, observations, median: median(observations.map((o) => o.answer)) };
}

/** Decode and check a bundle from the bundle API, before anything touches a chain. */
export async function verifyBundlePayload(payload: Hex, reporters: readonly Address[]) {
  const [feedId, roundId, obs] = decodeAbiParameters(payloadParams, payload);
  const observations = await recoverAll(feedId, roundId, obs, reporters);
  return { feedId, roundId, observations, median: median(observations.map((o) => o.answer)) };
}
