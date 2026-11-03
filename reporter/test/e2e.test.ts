// End-to-end against a local anvil: deploy -> configure -> sign -> transmit -> read.
// Uses the same code paths as the live relayer; only the price readings are fixed.
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { kursAggregatorAbi, kursOracleAbi } from "../src/abi.js";
import { deploy, loadDeployment, transmit, clients } from "../src/chain.js";
import { FEEDS, feedId } from "../src/feeds.js";
import { observeAndSign, type FeedReading } from "../src/kurs.js";

const ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const reporters = [1, 2, 3, 4, 5].map((i) => privateKeyToAccount(`0x${i.toString(16).padStart(64, "0")}`));
let anvil: ChildProcess;

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", "8545", "--silent"], { stdio: "ignore" });
  const { pub } = clients("local");
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("anvil did not start");
}, 20_000);

afterAll(() => anvil?.kill());

it("deploys, transmits a 5-reporter round and serves it through AggregatorV3", async () => {
  const deployer = privateKeyToAccount(ANVIL_PK);
  const { rmSync } = await import("node:fs");
  rmSync(new URL("../../deployments/local.json", import.meta.url), { force: true });

  const feeds = FEEDS.filter((f) => ["ETH/USD", "USD/IDR"].includes(f.pair));
  await deploy("local", deployer, reporters.map((r) => r.address), 3, feeds);
  const d = loadDeployment("local")!;

  // each reporter sees a slightly different price; the contract must land on the median
  const prices = [228_300_000_000n, 228_310_000_000n, 228_290_000_000n, 228_305_000_000n, 228_295_000_000n];
  const obs = (
    await Promise.all(
      reporters.map((acct, i) => {
        const r: FeedReading[] = [{ feed: feeds[0], readings: [], answer: prices[i] }];
        return observeAndSign(acct, r);
      }),
    )
  ).flat();

  const res = await transmit("local", deployer, obs, feeds);
  const eth = res.find((r) => r.pair === "ETH/USD")!;
  expect(eth.error).toBeUndefined();
  expect(eth.hash).toMatch(/^0x/);
  expect(res.find((r) => r.pair === "USD/IDR")!.skipped).toMatch(/0\/3/);

  const { pub } = clients("local");
  const [, answer] = await pub.readContract({
    address: d.aggregators["ETH/USD"],
    abi: kursAggregatorAbi,
    functionName: "latestRoundData",
  });
  expect(answer).toBe(228_300_000_000n); // median of the five

  // same round again is skipped, not reverted
  const again = await transmit("local", deployer, obs, feeds);
  expect(again[0].skipped).toBe("round already on chain");

  const round = await pub.readContract({
    address: d.oracle,
    abi: kursOracleAbi,
    functionName: "getRound",
    args: [feedId("ETH/USD"), eth.roundId],
  });
  expect(round.signerBitmap).toBe(0b11111); // all five reporters counted
  expect(round.roundId).toBe(eth.roundId);
}, 60_000);

it("ERC-7412 pull: stale price -> OracleDataRequired -> fulfil + convert (no Multicall3 on this chain)", async () => {
  const { sendWithFreshPrice } = await import("../src/pull.js");
  const { kursConverterAbi } = await import("../src/abi.js");
  const { encodeFunctionData, parseEventLogs } = await import("viem");
  const deployer = privateKeyToAccount(ANVIL_PK);
  const d = loadDeployment("local")!;
  expect(d.converter).toMatch(/^0x/);

  // convert $100.00; USD/IDR has never been pushed on this oracle, so the converter must pull
  const data = encodeFunctionData({ abi: kursConverterAbi, functionName: "convert", args: [10_000n] });
  const { pub } = clients("local");
  const before = await pub.call({ to: d.converter!, data }).then(() => "ok").catch((e) => String(e));
  expect(before).toMatch(/OracleDataRequired|reverted/);

  // localKeys = the oracle's reporters; prices come from the live sources
  const res = await sendWithFreshPrice("local", deployer, d.converter!, data, reporters);
  expect(res.pulled?.pair).toBe("USD/IDR");
  expect(res.batched).toBe(false); // anvil has no Multicall3 -> two transactions
  expect(res.hashes).toHaveLength(2);
  const [ev] = parseEventLogs({ abi: kursConverterAbi, logs: res.receipt.logs, eventName: "Converted" });
  expect(ev.args.amount).toBe(10_000n);
  expect(ev.args.converted).toBe((10_000n * BigInt(ev.args.price)) / 100_000_000n);

  // now fresh: a second conversion needs no pull
  const again = await sendWithFreshPrice("local", deployer, d.converter!, data, reporters);
  expect(again.pulled).toBeUndefined();
}, 90_000);
