// Records the Kurs demo video from the live dashboard, real explorer pages and real
// command output. Scene timing follows the measured voice-over durations; the start
// time of every scene is written to scenes.json so the mixer can place each VO clip.
// usage (from web/): node scripts/record-demo.mjs
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VIDEO = resolve(ROOT, "docs/video");
const DECK = pathToFileURL(resolve(ROOT, "docs/deck/index.html")).href;
const SITE = process.env.KURS_SITE ?? "https://kurs-ten-zeta.vercel.app";
const PULL_TX = "0x9e2aa23575734bba9b24b2ea6d25e9fc414a9b18cf2c3f64e323c3e9b17c405f";
const dur = JSON.parse(readFileSync(resolve(VIDEO, "durations.json"), "utf8"));
const PAD = 0.9; // seconds of air after each line

const W = 1600, H = 900;
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: resolve(VIDEO, "raw"), size: { width: W, height: H } },
});
const page = await context.newPage();
const t0 = Date.now();
const scenes = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Show a scene, start its narration, and keep it on screen for the line's length.
 *  `during` runs while the narration plays (e.g. moving to a second view). */
async function scene(key, show, during) {
  await show();
  const start = Date.now();
  scenes[key] = (start - t0) / 1000; // narration starts once the scene is on screen
  const holdMs = (dur[key] + PAD) * 1000;
  await Promise.all([sleep(holdMs), during ? during() : null]);
  const extra = holdMs - (Date.now() - start);
  if (extra > 0) await sleep(extra);
}

async function slide(n) {
  if (!page.url().startsWith(DECK)) await page.goto(DECK, { waitUntil: "load" });
  await page.evaluate((i) => {
    const s = document.querySelectorAll(".slide")[i - 1];
    window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY);
  }, n);
  await sleep(400);
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
async function terminal(title, command, output) {
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;background:#e8efe6;font-family:Archivo,Arial,sans-serif;display:grid;place-items:center;height:100vh}
    .t{width:1360px;background:#13233a;border-radius:14px;box-shadow:inset 0 0 0 8px #1b2f4c;padding:34px 44px;color:#dbe5f1}
    h1{margin:0 0 18px;font-size:30px;color:#fff;font-weight:800}
    .cmd{font-family:Consolas,monospace;font-size:22px;color:#ffb000;margin-bottom:16px}
    pre{font-family:Consolas,monospace;font-size:21px;line-height:1.45;margin:0;white-space:pre-wrap}
  </style></head><body><div class="t"><h1>${esc(title)}</h1><div class="cmd">$ ${esc(command)}</div><pre>${esc(output)}</pre></div></body></html>`);
  await sleep(300);
}

// 1-2: who we are, the problem (deck)
await scene("s1", () => slide(1));
await scene("s2", () => slide(2));

// 3: live rate board on Sepolia
await scene("s3", async () => {
  await page.goto(`${SITE}/?net=sepolia&feed=USD%2FIDR`, { waitUntil: "load" });
  await page.locator("#board-body tr[data-pair]").nth(10).waitFor({ timeout: 60_000 });
  await page.locator("#board-body tr[data-pair]").first().locator("td.led").waitFor();
});

// 4: in-browser verification of the latest round
await scene("s4", async () => {
  await page.locator("#board-body tr[data-pair]", { hasText: "ETH / USD" }).click();
  await page.locator("#verify").getByText("Verified in your browser.").waitFor({ timeout: 60_000 });
  await page.locator("#verify").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -120));
});

// 5: Portaldot pools vs Kurs
await scene("s5", async () => {
  await page.locator("#pools table").waitFor({ timeout: 60_000 });
  await page.locator("#pools").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
});

// 6: ERC-7412 pull, real command output, then the transaction on Etherscan
await scene(
  "s6",
  async () => {
    const out = readFileSync(resolve(VIDEO, "pull-convert-output.txt"), "utf8");
    await terminal("ERC-7412 pull on Sepolia", "npx tsx src/cli.ts pull-convert 10000 sepolia", out);
  },
  async () => {
    await sleep(8000);
    await page.goto(`https://eth-sepolia.blockscout.com/tx/${PULL_TX}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  },
);

// 7: ink! v6 reads the Solidity oracle (real run output)
await scene("s7", async () => {
  const out = readFileSync(resolve(ROOT, "docs/ink-e2e-local.txt"), "utf8").trim();
  await terminal("Cross-VM on pallet-revive: ink! v6 reads the Solidity oracle", "npm run ink-e2e", out);
});

// 8: built for Revive, tests, multi-chain
await scene("s8", () => slide(7));

// 9: close
await scene("s9", async () => {
  await page.goto("https://github.com/PugarHuda/kurs", { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(600);
});

await page.close();
await context.close();
await browser.close();
const raw = readdirSync(resolve(VIDEO, "raw")).find((f) => f.endsWith(".webm"));
renameSync(resolve(VIDEO, "raw", raw), resolve(VIDEO, "raw.webm"));
writeFileSync(resolve(VIDEO, "scenes.json"), JSON.stringify(scenes, null, 1));
console.log("recorded", scenes);
