// Deploys the Kurs adapters that are live on Sepolia but not yet on Portaldot, in priority order,
// as soon as the deployer holds enough tPOT (Revive storage deposit, ~0.078 tPOT per byte of code)
// on top of RESERVE for the relay. Each step is an existing, resumable deploy script; its read-back
// goes to docs/<name>-portaldot.txt. Anyone can fund it: send tPOT to the deployer (README).
//   npx tsx scripts/autodeploy.ts           # deploys what the balance covers, then stops
//   npx tsx scripts/autodeploy.ts --plan    # prints the plan and the shortfall, sends nothing
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

try { process.loadEnvFile?.(new URL("../../.env", import.meta.url)); } catch {} // CI passes the keys as env
const RESERVE = parseEther(process.env.AUTODEPLOY_RESERVE ?? "100"); // ~8 days of relay gas
// estimates from code size x 0.078 tPOT/byte (KursDIA: estimated 167, paid 167); `done` = key written last
const STEPS = [
  { script: "deploy-global.ts", out: "global", done: "quoteOracle", cost: 560, what: "Chainlink Feed Registry + ERC-7726/Euler KursQuoteOracle (any cross rate)" },
  { script: "deploy-compat.ts", out: "compat", done: "aaveOracle", cost: 870, what: "Band, API3, Chronicle and Aave v3 views" },
  { script: "deploy-adapters.ts", out: "adapters", done: "morphoOracleBtcIdr", cost: 375, what: "Pyth (pull + getPrice) and Morpho Blue oracle" },
];
const path = new URL("../../deployments/portaldot.json", import.meta.url);
const pub = createPublicClient({ transport: http("https://test-evm-rpc-v3.portaldot.dev") });
const me = privateKeyToAccount(process.env.DEPLOYER_PK as Hex).address;

const todo = STEPS.filter((s) => !JSON.parse(readFileSync(path, "utf8"))[s.done]);
const need = todo.reduce((a, s) => a + s.cost, 0);
console.log(`Portaldot: ${todo.length} steps left, ~${need} tPOT + ${formatEther(RESERVE)} relay reserve`);
for (const s of todo) {
  const bal = await pub.getBalance({ address: me });
  const cost = parseEther(String(s.cost));
  if (process.argv.includes("--plan") || bal < cost + RESERVE) {
    console.log(`next: ${s.what} (~${s.cost} tPOT); deployer has ${formatEther(bal)}${bal < cost + RESERVE ? `, short ${formatEther(cost + RESERVE - bal)}` : ""}`);
    break;
  }
  console.log(`deploying: ${s.what}`);
  const out = execFileSync("npx", ["tsx", `scripts/${s.script}`, "portaldot"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" });
  writeFileSync(new URL(`../../docs/${s.out}-portaldot.txt`, import.meta.url), out);
  console.log(out);
}
