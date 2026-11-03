import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const FEED_COUNT = 11;
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
  const r = await request.get("/api/substrate", { timeout: 60_000 });
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.via).toContain("ReviveApi_call");
  expect(body.block).toBeGreaterThan(0);
  expect(body.feeds).toHaveLength(11);
  for (const f of body.feeds) expect(Number(f.answer)).toBeGreaterThan(0);
});

test("the dashboard is in English (no Indonesian UI copy)", async ({ page }) => {
  await page.goto("/?net=portaldot");
  await expect(page.locator("#board-title")).toHaveText(/Today's rates/);
  await expect(page.locator("body")).not.toContainText(/hari ini|terakhir|sumber/i);
});

test("full round history comes from RoundUpdated logs via /api/history", async ({ page, request }) => {
  const r = await request.get("/api/history?net=sepolia&pair=USD/IDR&limit=3", { timeout: 90_000 });
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
  const spec = await (await request.get("/openapi.json")).json();
  const calls: [string, string, string][] = [
    ["/api/feeds", "FeedList", "200"],
    ["/api/bundle?pair=USD/IDR", "Bundle", "200"],
    ["/api/health", "Health", "any"],
    ["/api/substrate", "SubstrateRead", "200"],
    ["/api/history?net=sepolia&pair=USD/IDR&limit=3", "History", "200"],
  ];
  const errs: string[] = [];
  for (const [url, schema, want] of calls) {
    const r = await request.get(url, { timeout: 90_000 });
    if (want === "200" && r.status() !== 200) errs.push(`${url}: HTTP ${r.status()}`);
    check(spec, { $ref: `#/components/schemas/${schema}` }, await r.json(), url, errs);
  }
  expect(errs).toEqual([]);
});
