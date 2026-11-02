import { describe, expect, it } from "vitest";
import { encodeAbiParameters, hashTypedData, keccak256, recoverAddress, toBytes, concat } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DOMAIN, TYPES, median, roundOf, scale, selectBundle, sign, trimOutliers, ROUND_SECONDS } from "../src/kurs.js";
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

describe("selectBundle", () => {
  const reps = [1, 2, 3, 4].map((i) => privateKeyToAccount(`0x${(i + 10).toString(16).padStart(64, "0")}`));
  const outsider = privateKeyToAccount(`0x${"77".repeat(32)}`);
  const now = 1_793_633_700;
  const round = roundOf(now);
  const at = BigInt(now - 5);
  const rules = { allowed: reps.map((r) => r.address), maxObservationAge: 3600, maxSpreadBps: 100, now };

  it("keeps one valid observation per reporter on the current round", async () => {
    const good = await Promise.all(reps.slice(0, 3).map((r) => sign(r, "ETH/USD", round, 100_000n, at)));
    const dup = await sign(reps[0], "ETH/USD", round, 100_010n, at);
    const out = await sign(outsider, "ETH/USD", round, 100_000n, at);
    const forged = { ...good[2], answer: 999n };
    const picked = await selectBundle([...good.slice(0, 2), dup, out, forged], rules);
    expect(picked.map((o) => o.reporter)).toEqual([reps[0].address, reps[1].address]);
  });

  it("one reporter spamming the previous round cannot outvote the current round", async () => {
    const spam = await Promise.all([1n, 2n, 3n].map((k) => sign(reps[3], "ETH/USD", round - 1n, 100_000n + k, at)));
    const honest = await Promise.all(reps.slice(0, 2).map((r) => sign(r, "ETH/USD", round, 100_000n, at)));
    const picked = await selectBundle([...spam, ...honest], rules);
    expect(picked.every((o) => o.roundId === round)).toBe(true);
    expect(picked).toHaveLength(2);
  });

  it("drops stale, far-round and high-s observations", async () => {
    const stale = await sign(reps[0], "ETH/USD", round, 100_000n, BigInt(now - 7200));
    const farRound = await sign(reps[1], "ETH/USD", round - 5n, 100_000n, at);
    const ok = await sign(reps[2], "ETH/USD", round, 100_000n, at);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = {
      ...ok,
      s: `0x${(n - BigInt(ok.s)).toString(16).padStart(64, "0")}` as `0x${string}`,
      v: ok.v === 27 ? 28 : 27,
    };
    expect(await selectBundle([stale, farRound, highS, ok], rules)).toEqual([ok]);
  });

  it("trims the outlier so the bundle fits maxSpreadBps", async () => {
    const prices = [100_000n, 100_050n, 99_980n, 130_000n];
    const obs = await Promise.all(reps.map((r, i) => sign(r, "ETH/USD", round, prices[i], at)));
    const picked = await selectBundle(obs, rules);
    expect(picked.map((o) => o.answer)).not.toContain(130_000n);
    expect(picked).toHaveLength(3);
  });
});
