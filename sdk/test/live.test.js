// Live checks against the deployed contracts and API (needs network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http, decodeAbiParameters } from "viem";
import { networks, getPrice, fetchBundle, feedId, PAIRS, kursOracleAbi, verifyBundle, StalePriceError, getTwap } from "../dist/index.js";

const sepolia = createPublicClient({ chain: networks.sepolia.chain, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
const portaldot = createPublicClient({ chain: networks.portaldot.chain, transport: http() });

test("feed ids and pairs", () => {
  assert.equal(PAIRS.length, 16);
  // keccak256("USD/IDR"), the id the contracts and /api/feeds use
  assert.match(feedId("USD/IDR"), /^0x[0-9a-f]{64}$/);
});

for (const [name, client] of [["sepolia", sepolia], ["portaldot", portaldot]]) {
  test(`getPrice USD/IDR on ${name} infers the network from the client`, async () => {
    const p = await getPrice(client, "USD/IDR");
    assert.equal(p.decimals, 8);
    assert.ok(p.price > 10_000 && p.price < 30_000, `USD/IDR ${p.price}`);
    assert.ok(p.roundId > 0n);
  });
}

test("fetchBundle returns a payload the oracle verifies (eth_call fulfillOracleQuery)", async () => {
  const b = await fetchBundle("BTC/USD");
  const [id] = decodeAbiParameters([{ type: "bytes32" }], b.payload.slice(0, 66));
  assert.equal(id, feedId("BTC/USD"));
  await sepolia.simulateContract({ address: networks.sepolia.oracle, abi: kursOracleAbi, functionName: "fulfillOracleQuery", args: [b.payload] });
});

test("verifyBundle recovers every signer and matches the on-chain reporter set and quorum", async () => {
  const b = await fetchBundle("USD/IDR");
  for (const client of [sepolia, portaldot]) {
    const v = await verifyBundle(client, b);
    assert.equal(v.ok, true);
    assert.equal(v.pair, "USD/IDR");
    assert.ok(v.observations.length >= v.quorum);
    assert.ok(v.observations.every((o) => o.isReporter));
    assert.equal(v.median, b.answer);
  }
  // one flipped bit in a signature recovers a different address: not a reporter
  const bad = b.payload.slice(0, -2) + (b.payload.endsWith("00") ? "01" : "00");
  const v = await verifyBundle(sepolia, bad);
  assert.ok(v.observations.some((o) => !o.isReporter));
});

test("getPrice({ maxAge }) throws StalePriceError on an old round", async () => {
  await assert.rejects(getPrice(sepolia, "TSLA/USD", { maxAge: 1 }), StalePriceError);
  const p = await getPrice(sepolia, "USD/IDR", { maxAge: 6 * 3600 });
  assert.ok(p.price > 10_000);
});

test("getTwap reads the KursTwap time-weighted average on Sepolia", async () => {
  const t = await getTwap(sepolia, "USD/IDR", 60);
  assert.ok(t.price > 10_000 && t.price < 30_000, `twap ${t.price}`);
  await assert.rejects(getTwap(sepolia, "USD/IDR", 30 * 24 * 3600)); // beyond its history
});

test("the packaged addresses match deployments/*.json (run scripts/gen-abi.mjs after a deploy)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const net of ["portaldot", "sepolia"]) {
    const d = JSON.parse(readFileSync(new URL(`../../deployments/${net}.json`, import.meta.url), "utf8"));
    for (const [k, v] of Object.entries(networks[net])) if (k !== "chain") assert.deepEqual(v, d[k], `${net}.${k}`);
    for (const k of ["oracle", "quoteOracle", "siloOracle", "twap", "dia", "pyth"]) if (d[k]) assert.deepEqual(networks[net][k], d[k], `${net}.${k} missing from the SDK`);
  }
});
