// Live checks against the deployed contracts and API (needs network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http, decodeAbiParameters } from "viem";
import { networks, getPrice, fetchBundle, feedId, PAIRS, kursOracleAbi } from "../dist/index.js";

const sepolia = createPublicClient({ chain: networks.sepolia.chain, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
const portaldot = createPublicClient({ chain: networks.portaldot.chain, transport: http() });

test("feed ids and pairs", () => {
  assert.equal(PAIRS.length, 11);
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
