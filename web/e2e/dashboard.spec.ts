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
