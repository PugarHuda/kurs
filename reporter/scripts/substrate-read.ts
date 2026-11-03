// Reads every Kurs feed on Portaldot twice: through the Substrate runtime API
// (ReviveApi_call over the node WebSocket) and through the EVM RPC, and checks they agree.
//   npx tsx scripts/substrate-read.ts
import { formatUnits } from "viem";
import { FEEDS } from "../src/feeds.js";
import { clients, loadDeployment } from "../src/chain.js";
import { kursOracleAbi } from "../src/abi.js";
import { connect, readViaSubstrate } from "../src/substrate.js";
import { keccak256, toBytes } from "viem";

const d = loadDeployment("portaldot")!;
const pairs = FEEDS.map((f) => f.pair);
const api = await connect();
const sub = await readViaSubstrate(api, d.oracle, pairs);
await api.disconnect();

const { pub } = clients("portaldot");
let mismatches = 0;
console.log(`Substrate read at block #${sub.block} (${sub.blockHash.slice(0, 10)}…) via ReviveApi_call`);
for (const r of sub.reads) {
  const [id, ans] = await pub.readContract({ address: d.oracle, abi: kursOracleAbi, functionName: "latestRound", args: [keccak256(toBytes(r.pair))] });
  // a round can land between the two reads; then the EVM side is newer
  const same = id === r.roundId && ans === r.answer;
  if (!same && id < r.roundId) mismatches++;
  const dec = FEEDS.find((f) => f.pair === r.pair)!.decimals;
  console.log(`${r.pair.padEnd(10)} round ${r.roundId}  ${formatUnits(r.answer, dec).padStart(16)}  EVM RPC: ${same ? "identical" : `round ${id} (newer)`}`);
}
process.exit(mismatches ? 1 : 0);
