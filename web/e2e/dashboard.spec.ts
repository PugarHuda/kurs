import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const FEED_COUNT = 16;
// API tests call the deployed functions directly: the Vite preview proxy answers OPTIONS
// itself and is a second hop that can fail on its own
const API = process.env.KURS_BASE_URL ?? "https://kurs-ten-zeta.vercel.app";
const rows = (page: Page) => page.locator("#board-body tr[data-pair]");

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  (page as any).__errors = errors;
  await page.goto("/?net=sepolia&feed=USD%2FIDR");
  await expect(rows(page)).toHaveCount(FEED_COUNT);
});

test("rate board shows every feed with a real on-chain number", async ({ page }) => {
  await expect(page.locator("#board-meta")).toContainText(/Ethereum Sepolia, block [\d,]+, quorum 3 of 5/);
  const leds = await page.locator("#board-body td.led").allInnerTexts();
  expect(leds).toHaveLength(FEED_COUNT);
  for (const v of leds) {
    expect(v, "every feed has a round").not.toContain("--");
    expect(Number(v), `"${v}" is a number`).toBeGreaterThan(0);
  }
  // USD/IDR in a sane Rupiah range
  const idr = Number(await rows(page).filter({ hasText: "USD / IDR" }).locator("td.led").innerText());
  expect(idr).toBeGreaterThan(10_000);
  expect(idr).toBeLessThan(30_000);
});

test("selecting a feed by mouse and by keyboard updates the detail and the URL", async ({ page }) => {
  await rows(page).filter({ hasText: "ETH / USD" }).click();
  await expect(page.locator("#detail h2")).toHaveText("ETH / USD");
  await expect(page).toHaveURL(/feed=ETH%2FUSD/);

  const btc = rows(page).filter({ hasText: "BTC / USD" });
  await btc.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail h2")).toHaveText("BTC / USD");
  await expect(btc).toHaveClass(/sel/);
});

test("the latest round is re-verified in the browser from its transaction", async ({ page }) => {
  const verify = page.locator("#verify");
  await expect(verify).toContainText("Verified in your browser.");
  await expect(verify).toContainText("equals the on-chain answer");
  const inSet = await verify.locator("table.sigs tbody td:last-child").allInnerTexts();
  expect(inSet.length).toBeGreaterThanOrEqual(3); // quorum
  expect(inSet.every((x) => x === "yes")).toBe(true);
  // the transaction link goes to a block explorer
  await expect(page.locator(".facts a").first()).toHaveAttribute("href", /etherscan\.io\/tx\/0x[0-9a-f]{64}/);
});

test("Portaldot pools are read live and compared without NaN", async ({ page }) => {
  const table = page.locator("#pools table");
  await expect(table).toBeVisible();
  const text = await table.innerText();
  expect(text).not.toMatch(/NaN|undefined|Infinity/);
  await expect(table.locator("tbody tr")).toHaveCount(5);
});

test("the Portaldot Oracle pallet operator count is read from chain", async ({ page }) => {
  await expect(page.locator("#operators")).not.toHaveText("…");
  await expect(page.locator("#operators")).toHaveText(/operators?/);
});

test("pull form answers with a verified bundle or a clear reason", async ({ page }) => {
  await page.selectOption("#pull-pair", "USD/IDR");
  await page.getByRole("button", { name: "Get signed bundle" }).click();
  const out = page.locator("#pull-out");
  await expect(out).not.toContainText("Asking the bundle API");
  const text = await out.innerText();
  const verified = text.includes("Every signature checks out");
  const explained = /not served by this host|Bundle API: /.test(text); // a stated reason, never a crash
  expect(verified || explained, `pull output: ${text}`).toBe(true);
});

test("no horizontal scrolling and no console errors", async ({ page }) => {
  await expect(page.locator("#verify")).toContainText("Verified", { timeout: 60_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const errors: string[] = (page as any).__errors;
  expect(errors.filter((e) => !/favicon|ERR_BLOCKED_BY_CLIENT/.test(e))).toEqual([]);
});

test("no serious accessibility violations", async ({ page }) => {
  await expect(page.locator("#verify")).toContainText("Verified", { timeout: 60_000 });
  const res = await new AxeBuilder({ page }).analyze();
  const serious = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.length} node(s) ${v.nodes[0]?.target}`)).toEqual([]);
});

test("Portaldot V3: live rounds, verified in the browser, linked to the Node Console", async ({ page }) => {
  await page.goto("/?net=portaldot&feed=ETH%2FUSD");
  await expect(page.locator("#board-meta")).toContainText(/Portaldot V3 testnet, block [\d,]+, quorum 3 of 5/);
  const leds = await page.locator("#board-body td.led").allInnerTexts();
  expect(leds.filter((v) => Number(v) > 0).length).toBeGreaterThanOrEqual(9);
  await expect(page.locator("#verify")).toContainText("Verified in your browser.");
  await expect(page.locator(".facts a").first()).toHaveAttribute("href", /node-console\.portaldot\.dev\/.*#\/explorer\/query\/\d+/);
  await expect(page.locator("#parity table tbody tr")).toHaveCount(2);
});

test("governance panel reads the owner: native multisig on Portaldot, a Safe on Sepolia", async ({ page }) => {
  await page.goto("/?net=portaldot");
  await expect(page.locator("#gov")).toContainText("native Portaldot 2-of-3 multisig", { timeout: 45_000 });
  await page.getByRole("button", { name: "Ethereum Sepolia" }).click();
  await expect(page.locator("#gov")).toContainText("2-of-3 Safe", { timeout: 45_000 });
});

test("parity still lists both networks after switching to Sepolia", async ({ page }) => {
  await page.goto("/?net=portaldot&feed=USD%2FIDR");
  await expect(page.locator("#parity table")).toContainText("Ethereum Sepolia", { timeout: 60_000 });
  await page.getByRole("button", { name: "Ethereum Sepolia" }).click();
  await expect(page.locator("#board-body tr[data-pair]").first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("#parity table")).toContainText("Portaldot V3", { timeout: 45_000 });
  await expect(page.locator("#parity")).not.toContainText("one network so far");
});

test("stale rows stay readable (contrast) and the board does not shift the page", async ({ page }) => {
  await page.goto("/?net=portaldot");
  await page.locator("#board-body tr[data-pair]").nth(10).waitFor({ timeout: 60_000 });
  // force the stale look on every row, as when the relay is down
  await page.evaluate(() => document.querySelectorAll("#board-body tr[data-pair]").forEach((tr) => tr.classList.add("stale")));
  const results = await new AxeBuilder({ page }).include("#board-body").withRules(["color-contrast"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});

test("layout shift while the board loads stays under 0.1", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/?net=portaldot");
  await page.locator("#board-body tr[data-pair]").nth(10).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls).toBeLessThan(0.1);
});

test("/api/substrate reads every feed through ReviveApi_call and agrees with the board", async ({ request }) => {
  const r = await request.get(API + "/api/substrate", { timeout: 60_000 });
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.via).toContain("ReviveApi_call");
  expect(body.block).toBeGreaterThan(0);
  // every feed is read, or listed as not configured yet on Portaldot (a new feed waits out the owner's timelock)
  expect(body.feeds.length + (body.notConfigured?.length ?? 0)).toBe(FEED_COUNT);
  for (const f of body.feeds) expect(Number(f.answer)).toBeGreaterThan(0);
});

test("/api/mcp is an MCP server whose tools return on-chain prices", async ({ request }) => {
  const rpc = async (method: string, params: object = {}) => {
    const r = await request.post(API + "/api/mcp", {
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      data: { jsonrpc: "2.0", id: 1, method, params },
      timeout: 90_000,
    });
    expect(r.status(), method).toBe(200);
    return (await r.json()).result;
  };
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  expect(init.serverInfo.name).toBe("kurs");
  const { tools } = await rpc("tools/list");
  expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(["convert", "get_history", "get_price", "get_signed_bundle", "get_twap", "list_feeds", "verify_bundle"]);
  const price = JSON.parse((await rpc("tools/call", { name: "get_price", arguments: { pair: "USD/IDR", network: "sepolia" } })).content[0].text);
  expect(price.price).toBeGreaterThan(10_000);
  const conv = JSON.parse((await rpc("tools/call", { name: "convert", arguments: { amount: 100, from: "USD", to: "IDR", network: "sepolia" } })).content[0].text);
  expect(conv.result).toBeCloseTo(100 * price.price, 0);
  expect(conv.feedsUsed[0]).toMatchObject({ pair: "USD/IDR", stale: false });
  // case-insensitive symbols and a direct non-USD feed: Portaldot's own tPOT/pUSD
  const pot = JSON.parse((await rpc("tools/call", { name: "convert", arguments: { amount: 10, from: "tpot", to: "PUSD" } })).content[0].text);
  expect(pot).toMatchObject({ from: "tPOT", to: "pUSD" });
  expect(pot.result).toBeGreaterThan(0);
  // maxAgeSeconds refuses a conversion on an old price instead of answering with it
  const old = await rpc("tools/call", { name: "convert", arguments: { amount: 1, from: "USD", to: "IDR", maxAgeSeconds: 1 } });
  expect(old.isError).toBe(true);
  expect(old.content[0].text).toMatch(/refused: USD\/IDR is \d+s old/);
  // verify_bundle: a fresh bundle checks out against the on-chain reporter set; a tampered signature does not count
  const bundle = JSON.parse((await rpc("tools/call", { name: "get_signed_bundle", arguments: { pair: "USD/IDR" } })).content[0].text);
  const ok = JSON.parse((await rpc("tools/call", { name: "verify_bundle", arguments: { payload: bundle.payload, network: "sepolia" } })).content[0].text);
  expect(ok).toMatchObject({ valid: true, pair: "USD/IDR", quorum: 3, distinctReporters: 5 });
  const tampered = bundle.payload.slice(0, -2) + (bundle.payload.endsWith("00") ? "01" : "00");
  const bad = JSON.parse((await rpc("tools/call", { name: "verify_bundle", arguments: { payload: tampered, network: "sepolia" } })).content[0].text);
  expect(bad.distinctReporters).toBe(4);
  // get_twap reads the KursTwap contract
  const twap = JSON.parse((await rpc("tools/call", { name: "get_twap", arguments: { pair: "USD/IDR", windowSeconds: 300 } })).content[0].text);
  expect(twap.twap).toBeGreaterThan(10_000);
});

test("pair names are case-insensitive and network aliases are honoured; unknown ones are a 400", async ({ request }) => {
  const b = await request.get(API + "/api/bundle?pair=usd-idr", { timeout: 60_000 });
  expect(b.status()).toBe(200);
  expect((await b.json()).pair).toBe("USD/IDR");
  const h = await request.get(API + "/api/history?network=sepolia&pair=btc_usd&limit=1", { timeout: 90_000 });
  expect(h.status()).toBe(200);
  expect(await h.json()).toMatchObject({ net: "sepolia", pair: "BTC/USD" });
  expect((await request.get(API + "/api/history?chain=evil&pair=BTC/USD")).status()).toBe(400);
  expect((await request.get(API + "/api/bundle?pair=BTC/EUR")).status()).toBe(400);
});

test("the dashboard is in English (no Indonesian UI copy)", async ({ page }) => {
  await page.goto("/?net=portaldot");
  await expect(page.locator("#board-title")).toHaveText(/Today's rates/);
  await expect(page.locator("body")).not.toContainText(/hari ini|terakhir|sumber/i);
});

test("full round history comes from RoundUpdated logs via /api/history", async ({ page, request }) => {
  const r = await request.get(API + "/api/history?net=sepolia&pair=USD/IDR&limit=3", { timeout: 90_000 });
  expect(r.ok()).toBeTruthy();
  const b = await r.json();
  expect(b.total).toBeGreaterThan(0);
  expect(b.rounds[0].tx).toMatch(/^0x[0-9a-f]{64}$/);
  // newest first, strictly decreasing round ids
  const ids = b.rounds.map((x: { roundId: string }) => BigInt(x.roundId));
  for (let i = 1; i < ids.length; i++) expect(ids[i] < ids[i - 1]).toBeTruthy();
  await page.goto("/?net=portaldot&feed=USD%2FIDR");
  await expect(page.locator("#full-history")).toContainText(/All \d+ rounds since block/, { timeout: 90_000 });
});

// Contract test: every live endpoint answers with what /openapi.json documents
// (required fields, enums, nested objects and arrays, followed through $ref).
type Schema = { $ref?: string; type?: string | string[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; oneOf?: Schema[] };
function check(spec: { components: { schemas: Record<string, Schema> } }, s: Schema, v: unknown, at: string, errs: string[]) {
  if (s.$ref) return check(spec, spec.components.schemas[s.$ref.split("/").pop()!], v, at, errs);
  if (s.oneOf) return; // only used for nullable addresses
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
  if (s.type === "object" && v && typeof v === "object") {
    for (const k of s.required ?? []) if (!(k in (v as object))) errs.push(`${at}.${k} missing`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in (v as object)) check(spec, sub, (v as Record<string, unknown>)[k], `${at}.${k}`, errs);
  }
  if (s.type === "array" && Array.isArray(v) && s.items) v.slice(0, 20).forEach((x, i) => check(spec, s.items!, x, `${at}[${i}]`, errs));
}

test("every API response matches openapi.json", async ({ request }) => {
  const spec = await (await request.get(API + "/openapi.json")).json();
  const calls: [string, string, string][] = [
    ["/api/feeds", "FeedList", "200"],
    ["/api/bundle?pair=USD/IDR", "Bundle", "200"],
    ["/api/health", "Health", "any"],
    ["/api/substrate", "SubstrateRead", "200"],
    ["/api/history?net=sepolia&pair=USD/IDR&limit=3", "History", "200"],
    ["/api/quote?amount=100&from=USD&to=IDR&network=sepolia", "Quote", "200"],
  ];
  const errs: string[] = [];
  for (const [url, schema, want] of calls) {
    const r = await request.get(API + url, { timeout: 90_000 });
    if (want === "200" && r.status() !== 200) errs.push(`${url}: HTTP ${r.status()}`);
    check(spec, { $ref: `#/components/schemas/${schema}` }, await r.json(), url, errs);
  }
  expect(errs).toEqual([]);
});

test("/api/metrics is valid Prometheus text with a sample per feed and chain", async ({ request }) => {
  const r = await request.get(API + "/api/metrics", { timeout: 90_000 });
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("text/plain");
  const lines = (await r.text()).trim().split("\n");
  // every line is a comment or `name{labels} number`
  for (const l of lines) expect(l).toMatch(/^(# (HELP|TYPE) kurs_\w+ .+|kurs_\w+(\{[^}]*\})? -?[0-9.e+-]+)$/);
  for (const chain of ["portaldot", "sepolia"])
    expect(lines.some((l) => l.startsWith(`kurs_feed_age_seconds{chain="${chain}",pair="USD/IDR"}`))).toBe(true);
  expect(lines).toContainEqual(expect.stringMatching(/^kurs_healthy [01]$/));
  // the 1 h TWAP and its deviation from the latest round, and governance drift per feed
  expect(lines).toContainEqual(expect.stringMatching(/^kurs_twap_1h\{chain="sepolia",pair="USD\/IDR"\} 1\d{4}(\.\d+)?$/));
  expect(lines).toContainEqual(expect.stringMatching(/^kurs_twap_deviation_bps\{chain="sepolia",pair="BTC\/USD"\} -?\d+$/));
  for (const chain of ["portaldot", "sepolia"]) expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^kurs_feed_config_drift\\{chain="${chain}",pair="USD/IDR"\\} 0$`)));
});

test("/api/x402 answers 402 with x402 v1 requirements, and rejects a forged payment", async ({ request }) => {
  const r = await request.get(API + "/api/x402?pair=USD/IDR");
  expect(r.status()).toBe(402);
  const body = await r.json();
  expect(body.x402Version).toBe(1);
  expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "base-sepolia", maxAmountRequired: "1000" });
  const forged = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: { signature: "0x" + "11".repeat(65), authorization: { from: body.accepts[0].payTo, to: body.accepts[0].payTo, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32) } } })).toString("base64");
  const r2 = await request.get(API + "/api/x402?pair=USD/IDR", { headers: { "X-PAYMENT": forged }, timeout: 60_000 });
  expect(r2.status()).toBe(402); // the facilitator refuses it: no bundle without a real payment
});

test("/api/quote converts with on-chain prices, shows each round's age, and refuses what it cannot answer honestly", async ({ request }) => {
  const q = async (qs: string) => {
    const r = await request.get(`${API}/api/quote?${qs}`, { timeout: 60_000 });
    return { status: r.status(), body: await r.json() };
  };
  const usd = await q("amount=100&from=usd&to=idr&network=sepolia");
  expect(usd.status).toBe(200);
  expect(usd.body).toMatchObject({ from: "USD", to: "IDR", network: "sepolia" });
  expect(usd.body.result).toBeCloseTo(100 * usd.body.feedsUsed[0].price, 3);
  const btc = await q("amount=1&from=BTC&to=IDR&network=sepolia");
  expect(btc.body.feedsUsed.map((f: { pair: string }) => f.pair)).toEqual(["BTC/USD", "USD/IDR"]);
  expect((await q("amount=10&from=tPOT&to=pUSD")).body.feedsUsed[0].pair).toBe("tPOT/pUSD");
  expect((await q("amount=1&from=USD&to=IDR&maxAge=1")).status).toBe(409);
  expect((await q("amount=1e308&from=BTC&to=IDR")).status).toBe(400);
  expect((await q("amount=-1&from=USD&to=IDR")).status).toBe(400);
  expect((await q("amount=1&from=tPOT&to=IDR")).status).toBe(404); // no pUSD/USD feed: no made-up path
  expect((await q("amount=1&from=USD&to=IDR&network=evil")).status).toBe(400);
});

test("browsers can preflight the API: OPTIONS answers CORS, including X-PAYMENT for x402", async ({ request }) => {
  for (const path of ["/api/x402?pair=USD/IDR", "/api/bundle?pair=USD/IDR", "/api/quote", "/api/history", "/api/feeds"]) {
    const r = await request.fetch(API + path, { method: "OPTIONS", headers: { origin: "https://dapp.example", "access-control-request-method": "GET", "access-control-request-headers": "x-payment" } });
    expect(r.status(), path).toBe(204);
    expect(r.headers()["access-control-allow-origin"]).toBe("*");
    expect(r.headers()["access-control-allow-headers"]).toContain("x-payment");
  }
});

test("Sepolia detail shows the KursTwap time-weighted average next to the latest round", async ({ page }) => {
  await page.goto("/?net=sepolia&feed=BTC%2FUSD");
  await expect(page.locator("#twap")).toContainText(/Time-weighted average: [\d,.]+ over (1 h|10 min)/, { timeout: 60_000 });
  await expect(page.locator("#twap a")).toHaveAttribute("href", /0x2f4385f565568b8f835ed8419f02b99bd0754f15/i);
});

test("the converter computes from the board's on-chain rounds and refuses a path Kurs has no feeds for", async ({ page }) => {
  await page.goto("/?net=sepolia&feed=USD%2FIDR");
  const idr = Number(await rows(page).filter({ hasText: "USD / IDR" }).locator("td.led").innerText());
  await page.fill("#convert-amount", "250");
  await page.selectOption("#convert-from", "USD");
  await page.selectOption("#convert-to", "IDR");
  const out = page.locator("#convert-out");
  await expect(out).toContainText(/250 USD = [\d,.]+ IDR/);
  const shown = Number((await out.locator("strong").innerText()).split("=")[1].replace(/[^\d.]/g, ""));
  expect(shown).toBeCloseTo(250 * idr, -1);
  await expect(out).toContainText(/USD\/IDR round \d+/);
  await page.selectOption("#convert-from", "BTC"); // two feeds through USD
  await expect(out).toContainText(/BTC\/USD round \d+ .* and USD\/IDR round \d+/);
  await page.selectOption("#convert-from", "tPOT"); // tPOT is quoted in pUSD only
  await expect(out).toContainText("No Kurs path from tPOT to IDR");
  await page.fill("#convert-amount", "-5");
  await expect(out).toContainText("Enter an amount above zero");
});

// Accuracy: the on-chain medians against references Kurs does not take its BTC/ETH median
// from directly (Chainlink's own Sepolia feeds, an independent oracle network) and an FX
// source no reporter reads (FloatRates).
test("on-chain prices agree with independent references", async ({ request }) => {
  const { createPublicClient, http, parseAbi, keccak256, toBytes } = await import("viem");
  const { sepolia } = await import("viem/chains");
  const c = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
  const kurs = async (pair: string) => {
    const [, answer] = await c.readContract({ address: "0xd3f6bf8e595e815de11598f23170b37341a2cbc3", abi: parseAbi(["function latestRound(bytes32) view returns (uint80, int192, uint64, uint64)"]), functionName: "latestRound", args: [keccak256(toBytes(pair))] });
    return Number(answer) / 1e8;
  };
  const agg = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
  for (const [pair, feed] of [["BTC/USD", "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43"], ["ETH/USD", "0x694AA1769357215DE4FAC081bf1f309aDC325306"]] as const) {
    const [, a, , updatedAt] = await c.readContract({ address: feed, abi: agg, functionName: "latestRoundData" });
    if (Date.now() / 1000 - Number(updatedAt) > 6 * 3600) continue; // a stalled Chainlink testnet feed is no reference
    const [k, ref] = [await kurs(pair), Number(a) / 1e8];
    expect(Math.abs(k - ref) / ref, `${pair}: Kurs ${k} vs Chainlink ${ref}`).toBeLessThan(0.02);
  }
  const fx = await (await request.get("https://www.floatrates.com/daily/usd.json", { timeout: 30_000 })).json();
  const [k, ref] = [await kurs("USD/IDR"), Number(fx.idr.rate)];
  expect(Math.abs(k - ref) / ref, `USD/IDR: Kurs ${k} vs FloatRates ${ref}`).toBeLessThan(0.01);
});
