#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { FEEDS } from "./feeds.js";
import { configure, deploy, transmit } from "./chain.js";
import { CHAINS, fromJson, observeAndSign, readAll, toJson, type ChainKey, type SignedObservation } from "./kurs.js";

const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k: string) => process.env[k];
const localReporters = () =>
  [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((i) => env(`REPORTER_${i}_PK`))
    .filter((k): k is string => !!k)
    .map((k) => privateKeyToAccount(k as Hex));
const deployer = () => {
  const k = env("DEPLOYER_PK");
  if (!k) throw new Error("DEPLOYER_PK not set");
  return privateKeyToAccount(k as Hex);
};
const chainsFromEnv = (): ChainKey[] =>
  (env("KURS_CHAINS") ?? "portaldot").split(",").map((c) => {
    if (!(c in CHAINS)) throw new Error(`unknown chain ${c}`);
    return c as ChainKey;
  });

/** Signed observations from local keys plus any remote reporters (KURS_REPORTER_URLS). */
async function collect(): Promise<SignedObservation[]> {
  const readings = await readAll();
  const local = (await Promise.all(localReporters().map((a) => observeAndSign(a, readings)))).flat();
  const urls = (env("KURS_REPORTER_URLS") ?? "").split(",").filter(Boolean);
  for (const u of urls) {
    const { protocol, hostname } = new URL(u);
    if (protocol !== "https:" && hostname !== "localhost" && hostname !== "127.0.0.1") {
      throw new Error(`reporter URL must be https: ${u}`);
    }
  }
  const remote = (
    await Promise.all(
      urls.map(async (u) => {
        try {
          const r = await fetch(`${u.replace(/\/$/, "")}/observations`, { signal: AbortSignal.timeout(15_000) });
          return ((await r.json()) as ReturnType<typeof toJson>[]).map(fromJson);
        } catch (e) {
          console.warn("reporter unreachable", u, (e as Error).message);
          return [];
        }
      }),
    )
  ).flat();
  return [...local, ...remote];
}

async function tick() {
  const obs = await collect();
  for (const chain of chainsFromEnv()) {
    const res = await transmit(chain, deployer(), obs);
    for (const r of res) {
      const what = r.hash ? `tx ${r.hash}` : r.error ? `ERROR ${r.error}` : `skip: ${r.skipped}`;
      console.log(`${chain.padEnd(9)} ${r.pair.padEnd(10)} round ${r.roundId} ${r.answer ?? ""} ${what}`);
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "observe": {
    // Dry run: what every source says right now, and what a reporter would sign.
    for (const r of await readAll()) {
      const parts = r.readings.map((x) => `${x.source}=${x.price ?? "✗"}`);
      const ans = r.answer === undefined ? "ABSTAIN" : (Number(r.answer) / 10 ** r.feed.decimals).toString();
      console.log(`${r.feed.pair.padEnd(10)} ${ans.padStart(16)}  ${parts.join("  ")}`);
    }
    break;
  }
  case "deploy": {
    const chain = (args[0] ?? "portaldot") as ChainKey;
    const reps = localReporters().map((a) => a.address);
    const quorum = Number(env("KURS_QUORUM") ?? Math.floor(reps.length / 2) + 1);
    const d = await deploy(chain, deployer(), reps, quorum);
    console.log(JSON.stringify(d, null, 2));
    break;
  }
  case "configure":
    await configure((args[0] ?? "portaldot") as ChainKey, deployer());
    break;
  case "once":
    await tick();
    break;
  case "run": {
    const every = Number(env("KURS_INTERVAL_SECONDS") ?? 60) * 1000;
    for (;;) {
      const t = Date.now();
      await tick().catch((e) => console.error("tick failed:", e));
      await new Promise((r) => setTimeout(r, Math.max(1000, every - (Date.now() - t))));
    }
  }
  case "serve": {
    // A standalone reporter: one key, signs on request. Run anywhere; point a transmitter at it.
    const k = env("REPORTER_PK") ?? env("REPORTER_1_PK");
    if (!k) throw new Error("REPORTER_PK not set");
    const acct = privateKeyToAccount(k as Hex);
    const port = Number(env("PORT") ?? 8787);
    createServer(async (req, res) => {
      if (req.url?.startsWith("/observations")) {
        const signed = await observeAndSign(acct, await readAll());
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(signed.map(toJson)));
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ reporter: acct.address, feeds: FEEDS.map((f) => f.pair) }),
        );
      }
    }).listen(port, () => console.log(`reporter ${acct.address} on :${port}`));
    break;
  }
  default:
    console.log(`kurs <command>
  observe              read every source, print what would be signed (no keys, no chain)
  deploy [chain]       deploy KursOracle + factory, configure feeds, write deployments/<chain>.json
  configure [chain]    sync on-chain feed config with src/feeds.ts
  once                 one round: collect signatures, transmit due feeds to KURS_CHAINS
  run                  loop "once" every KURS_INTERVAL_SECONDS (default 60)
  serve                run a single reporter over HTTP (REPORTER_PK, PORT)`);
}
