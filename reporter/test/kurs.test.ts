import { describe, expect, it } from "vitest";
import { encodeAbiParameters, hashTypedData, keccak256, recoverAddress, toBytes, concat } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DOMAIN, TYPES, median, roundOf, scale, sign, trimOutliers, ROUND_SECONDS } from "../src/kurs.js";
import { FEEDS, feedId } from "../src/feeds.js";

const acct = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

describe("EIP-712 digest matches KursOracle.observationDigest", () => {
  it("rebuilds the contract's formula by hand", () => {
    const id = feedId("ETH/USD");
    const msg = { feedId: id, roundId: 29_000_000n, answer: 228_306_491_428n, observedAt: 1_793_633_700n };
    const domainSep = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [keccak256(toBytes("EIP712Domain(string name,string version)")), keccak256(toBytes("Kurs")), keccak256(toBytes("1"))],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint80" }, { type: "int192" }, { type: "uint64" }],
        [
          keccak256(toBytes("Observation(bytes32 feedId,uint80 roundId,int192 answer,uint64 observedAt)")),
          msg.feedId,
          msg.roundId,
          msg.answer,
          msg.observedAt,
        ],
      ),
    );
    const manual = keccak256(concat(["0x1901", domainSep, structHash]));
    expect(hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Observation", message: msg })).toBe(manual);
  });

  it("split v/r/s recovers the reporter", async () => {
    const o = await sign(acct, "BTC/USD", 7n, 7_772_510_490_240n, 1_793_633_700n);
    const digest = hashTypedData({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Observation",
      message: { feedId: o.feedId, roundId: o.roundId, answer: o.answer, observedAt: o.observedAt },
    });
    const sig = concat([o.r, o.s, `0x${o.v.toString(16)}`]);
    expect(await recoverAddress({ hash: digest, signature: sig })).toBe(acct.address);
    expect([27, 28]).toContain(o.v);
  });
});

describe("aggregation helpers", () => {
  it("median handles odd and even", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("trimOutliers drops a broken source", () => {
    expect(trimOutliers([100, 101, 99, 250])).toEqual([100, 101, 99]);
    expect(trimOutliers([100, 300])).toEqual([100, 300]); // too few to judge
  });

  it("scale is exact for 8 decimals", () => {
    expect(scale(77725.1049024, 8)).toBe(7_772_510_490_240n);
    expect(scale(0.714927, 8)).toBe(71_492_700n);
    expect(scale(18144.413865, 8)).toBe(1_814_441_386_500n);
  });

  it("rounds are time buckets every reporter agrees on", () => {
    const t = 1_793_633_700;
    expect(roundOf(t)).toBe(roundOf(t + ROUND_SECONDS - 1 - (t % ROUND_SECONDS)));
    expect(roundOf(t + ROUND_SECONDS)).toBe(roundOf(t) + 1n);
  });
});

describe("feed config", () => {
  it("every feed fits the contract's checks", () => {
    const ids = new Set<string>();
    for (const f of FEEDS) {
      expect(f.minAnswer < f.maxAnswer, f.pair).toBe(true);
      expect(f.maxSpreadBps > 0 && f.maxSpreadBps <= 65_535, f.pair).toBe(true);
      expect(Object.keys(f.sources).length >= f.minSources, f.pair).toBe(true);
      ids.add(feedId(f.pair));
    }
    expect(ids.size).toBe(FEEDS.length);
  });
});
