#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { FEEDS } from "./feeds.js";
import { encodeFunctionData, parseEventLogs } from "viem";
import { kursConverterAbi } from "./abi.js";
import { configure, deploy, pokeTwaps, relayExact, SLOT_ALIGNED, transmit, type TransmitResult } from "./chain.js";
import { converterOf, sendWithFreshPrice } from "./pull.js";
import {
  CHAINS,
  fromJson,
  observeAndSign,
  readAll,
  sign,
  toJson,
  type ChainKey,
  type FeedReading,
  type SignedObservation,
} from "./kurs.js";

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
async function collect(): Promise<{ obs: SignedObservation[]; readings: FeedReading[] }> {
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
          const body = (await r.json()) as unknown;
          if (!Array.isArray(body)) return [];
          return body.slice(0, 64).flatMap((item) => {
            try {
              return [fromJson(item as ReturnType<typeof toJson>)];
            } catch {
              return []; // malformed item from an untrusted reporter
            }
          });
        } catch (e) {
          console.warn("reporter unreachable", u, (e as Error).message);
          return [];
        }
      }),
    )
  ).flat();
  return { obs: [...local, ...remote], readings };
}

const print = (r: TransmitResult) => {
  const what = r.hash ? `tx ${r.hash}` : r.error ? `ERROR ${r.error}` : `skip: ${r.skipped}`;
  console.log(`${r.chain.padEnd(9)} ${r.pair.padEnd(10)} round ${r.roundId} ${r.answer ?? ""} ${what}`);
};

async function tick() {
  const { obs, readings } = await collect();
  const keys = localReporters();
  // Slot-aligned chains may need the same reading signed at another round id. The
  // signature keeps the time the sources answered (never "now"), and a reading older
  // than RESIGN_MAX_AGE is not re-signed, so a slow tick cannot make old data look fresh.
  const RESIGN_MAX_AGE = 120;
  const resign = async (pair: string, roundId: bigint) => {
    const r = readings.find((x) => x.feed.pair === pair);
    if (!r?.answer || r.observedAt === undefined) return [];
    if (Math.floor(Date.now() / 1000) - r.observedAt > RESIGN_MAX_AGE) return [];
    return Promise.all(keys.map((k) => sign(k, pair, roundId, r.answer!, BigInt(r.observedAt!))));
  };
  const chains = chainsFromEnv().sort((a, b) => Number(!!SLOT_ALIGNED[b]) - Number(!!SLOT_ALIGNED[a]));
  const mirrored: SignedObservation[][] = [];
  for (const chain of chains) {
    // one chain's outage (RPC down, out of gas) must not stall the others
    try {
      // mirror first: if this chain took its own newer round first, the identical
      // bundle from the slot-aligned chain would be rejected as stale
      if (!SLOT_ALIGNED[chain] && mirrored.length) (await relayExact(chain, deployer(), mirrored)).forEach(print);
      const res = await transmit(chain, deployer(), obs, FEEDS, { resign });
      res.forEach(print);
      if (SLOT_ALIGNED[chain]) mirrored.push(...res.flatMap((r) => (r.bundle ? [r.bundle] : [])));
      (await pokeTwaps(chain, deployer())).forEach((l) => console.log(l));
    } catch (e) {
      console.error(`${chain}: tick failed, other chains continue:`, (e as Error).message.split("\n")[0]);
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
  case "pull-convert": {
    // ERC-7412 demo: convert USD cents to IDR cents at a price no older than the converter's maxAge,
    // pulling a signed bundle into the same transaction when the stored price is stale.
    const amount = BigInt(args[0] ?? "10000");
    const chain = (args[1] ?? "sepolia") as ChainKey;
    const data = encodeFunctionData({ abi: kursConverterAbi, functionName: "convert", args: [amount] });
    const res = await sendWithFreshPrice(chain, deployer(), converterOf(chain), data, localReporters());
    const [ev] = parseEventLogs({ abi: kursConverterAbi, logs: res.receipt.logs, eventName: "Converted" });
    console.log(
      JSON.stringify(
        {
          chain,
          pulled: res.pulled
            ? { pair: res.pulled.pair, roundId: res.pulled.roundId.toString(), from: res.pulled.source }
            : "price was fresh, no pull needed",
          batchedInOneTx: res.batched,
          txs: res.hashes,
          converted: ev
            ? { amount: ev.args.amount.toString(), converted: ev.args.converted.toString(), roundId: ev.args.roundId.toString(), price: ev.args.price.toString() }
            : null,
        },
        null,
        2,
      ),
    );
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
  serve                run a single reporter over HTTP (REPORTER_PK, PORT)
  pull-convert [amount] [chain]
                       ERC-7412 pull: KursConverter.convert(amount) with a signed bundle pulled
                       into the same transaction when the price is stale (KURS_BUNDLE_URL or local keys)`);
}
