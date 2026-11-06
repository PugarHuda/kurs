import "./style.css";
import type { Address, Hex } from "viem";
import { createWalletClient, custom, encodeFunctionData, hexToBytes, keccak256, parseAbi, parseEventLogs, toBytes, type EIP1193Provider } from "viem";
import { sepolia as sepoliaChain } from "viem/chains";
import { FEEDS, findFeed } from "../../reporter/src/feeds";
import { FEEDS as ALL_FEEDS } from "../../reporter/src/feeds";
import { verifyBundlePayload, verifyRound, type CheckedObservation } from "./verify";
import { kursConverterAbi, kursOracleAbi, kursTwapAbi } from "../../reporter/src/abi";
import {
  clientFor,
  DEPLOYMENTS,
  NETWORKS,
  oracleOperatorCount,
  ownerOf,
  poolPrice,
  snapshot,
  type Deployment,
  type FeedState,
  type Snapshot,
} from "./data";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Portaldot's Substrate explorer does not resolve EVM hashes or H160 addresses yet;
// rounds link to the block in the official Node Console instead (see txLink).
const PORTALDOT_BLOCK = (n: bigint) =>
  `https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/${n}`;

const EXPLORER: Record<Deployment["chain"], { tx: (h: Hex) => string; addr: (a: Address) => string } | undefined> = {
  portaldot: undefined,
  sepolia: { tx: (h) => `https://sepolia.etherscan.io/tx/${h}`, addr: (a) => `https://sepolia.etherscan.io/address/${a}` },
  local: undefined,
};

const txLink = (d: Deployment, hash: Hex, block: bigint) =>
  d.chain === "portaldot"
    ? `<a href="${PORTALDOT_BLOCK(block)}" target="_blank" rel="noopener">block ${block.toLocaleString("en-US")}</a> <code>${short(hash)}</code>`
    : link(d, "tx", hash);

const link = (d: Deployment, kind: "tx" | "addr", v: string, text = short(v)) => {
  const e = EXPLORER[d.chain];
  return e ? `<a href="${e[kind](v as Hex & Address)}" target="_blank" rel="noopener">${text}</a>` : `<code>${text}</code>`;
};

function fmt(answer: bigint, decimals: number) {
  const n = Number(answer) / 10 ** decimals;
  if (n >= 100) return n.toFixed(2); // no thousands separators: a rate board shows bare digits
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function ago(unix: number) {
  if (!unix) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

const bits = (bitmap: number, n: number) =>
  Array.from({ length: n }, (_, i) => `<i class="lamp${(bitmap >> i) & 1 ? " on" : ""}"></i>`).join("");

// ------------------------------------------------------------------ state

const params = new URLSearchParams(location.search);
const deployments = DEPLOYMENTS.sort((a, b) => ["portaldot", "sepolia", "local"].indexOf(a.chain) - ["portaldot", "sepolia", "local"].indexOf(b.chain));
let current: Deployment | undefined = deployments.find((d) => d.chain === params.get("net")) ?? deployments[0];
// an unknown or oddly spelled feed (?feed=eur-usd) resolves like the API does, else BTC/USD
let selected = findFeed(params.get("feed"))?.pair ?? "BTC/USD";
if ((params.has("feed") && params.get("feed") !== selected) || (params.has("net") && params.get("net") !== current?.chain)) history.replaceState(null, "", `?net=${current?.chain ?? "portaldot"}&feed=${encodeURIComponent(selected)}`);
let last: Snapshot | undefined;
const others = new Map<string, Snapshot>();

// ------------------------------------------------------------------ board

function boardRow(s: Snapshot, f: FeedState) {
  const prev = f.history.length > 1 ? f.history[f.history.length - 2].answer : undefined;
  const has = f.roundId > 0n;
  let move = "";
  if (has && prev !== undefined && prev !== 0n) {
    const bps = Number(((f.answer - prev) * 100_000n) / prev) / 10; // tenths of a bps -> bps
    const pct = (bps / 100).toFixed(2);
    move = bps > 0 ? `<span class="up">▲${pct}</span>` : bps < 0 ? `<span class="down">▼${pct.replace("-", "")}</span>` : `<span class="flat">${pct}</span>`;
  }
  const latestBitmap = f.history.at(-1)?.signerBitmap ?? 0;
  const stale = has && Date.now() / 1000 - f.updatedAt > f.feed.heartbeat * 1.5;
  return `
    <tr class="${f.feed.pair === selected ? "sel" : ""}${stale ? " stale" : ""}" data-pair="${esc(f.feed.pair)}" tabindex="0">
      <th scope="row"><span class="pair">${esc(f.feed.pair.replace("/", " / "))}</span><span class="desc">${esc(sourceLine(f))}</span></th>
      <td class="led${f.configured ? "" : " off"}">${has ? fmt(f.answer, f.feed.decimals) : f.configured ? "--.--" : "not on this network"}</td>
      <td class="move">${move}</td>
      <td class="signers" title="${countBits(latestBitmap)} of ${s.reporters.length} reporters signed the latest round">${bits(latestBitmap, s.reporters.length)}</td>
      <td class="age">${has ? ago(f.updatedAt) : f.configured ? "waiting" : "Sepolia"}</td>
    </tr>`;
}

const countBits = (b: number) => b.toString(2).split("").filter((x) => x === "1").length;

function sourceLine(f: FeedState) {
  const n = Object.keys(f.feed.sources).length;
  if (f.feed.sources["portaldot-assetconversion"]) return "Portaldot AssetConversion pool";
  return `${n} source${n > 1 ? "s" : ""}`;
}

/** Board section of a feed, read from where its price comes from. */
function groupOf(f: FeedState["feed"]) {
  if (f.sources["portaldot-assetconversion"]) return "Portaldot native";
  if (f.sources.nasdaq) return "Equities";
  if (f.sources["gold-api"]) return "Metals";
  if (f.sources.frankfurter) return "FX";
  return "Crypto";
}

function renderBoard(s: Snapshot) {
  const groups = ["Crypto", "FX", "Metals", "Equities", "Portaldot native"];
  // the board is rebuilt on every refresh: put keyboard focus back on the same row
  const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLTableRowElement>("#board-body tr[data-pair]")?.dataset.pair;
  $("#board-body").innerHTML = groups
    .map((g) => {
      const fs = s.feeds.filter((f) => groupOf(f.feed) === g);
      return fs.length ? `<tr class="group"><th colspan="5" scope="colgroup">${g}</th></tr>${fs.map((f) => boardRow(s, f)).join("")}` : "";
    })
    .join("");
  $("#board-meta").textContent = `${NETWORKS[s.deployment.chain].label}, block ${s.block.toLocaleString("en-US")}, quorum ${s.quorum} of ${s.reporters.length}`;
  for (const tr of document.querySelectorAll<HTMLTableRowElement>("#board-body tr[data-pair]")) {
    const pick = () => {
      selected = tr.dataset.pair!;
      history.replaceState(null, "", `?net=${s.deployment.chain}&feed=${encodeURIComponent(selected)}`);
      renderBoard(s);
      renderDetail(s);
    };
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick(), document.querySelector<HTMLElement>(`#board-body tr[data-pair="${CSS.escape(selected)}"]`)?.focus()));
  }
  if (focused) document.querySelector<HTMLElement>(`#board-body tr[data-pair="${CSS.escape(focused)}"]`)?.focus();
}

// ------------------------------------------------------------------ detail

function spark(f: FeedState) {
  const pts = f.history.slice(-48);
  if (pts.length < 2) return `<p class="muted">The chart appears after the second round.</p>`;
  const ys = pts.map((p) => Number(p.answer));
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const w = 560;
  const h = 120;
  const x = (i: number) => (i / (pts.length - 1)) * w;
  const y = (v: number) => (hi === lo ? h / 2 : h - 8 - ((v - lo) / (hi - lo)) * (h - 16));
  const d = ys.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const dec = f.feed.decimals;
  return `
    <figure class="spark">
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(f.feed.pair)} over the last ${pts.length} rounds">
        <path d="${d}" />
        <circle cx="${x(pts.length - 1)}" cy="${y(ys.at(-1)!)}" r="3.5" />
      </svg>
      <figcaption>Last ${pts.length} rounds on chain. Low ${fmt(BigInt(lo), dec)}, high ${fmt(BigInt(hi), dec)}. <span id="full-history"></span></figcaption>
    </figure>`;
}

// full history from RoundUpdated logs (/api/history), cached per feed for a minute
const historyCache = new Map<string, { at: number; html: string }>();
async function renderFullHistory(chain: string, pair: string) {
  const key = `${chain}|${pair}`;
  let hit = historyCache.get(key);
  if (!hit || Date.now() - hit.at > 60_000) {
    try {
      const r = await fetch(`/api/history?net=${chain}&pair=${encodeURIComponent(pair)}&limit=1`);
      if (!r.ok) return;
      const b = (await r.json()) as { total: number; fromBlock: number };
      const url = `/api/history?net=${chain}&pair=${encodeURIComponent(pair)}`;
      hit = { at: Date.now(), html: `<a href="${esc(url)}">All ${b.total} rounds since block ${b.fromBlock.toLocaleString("en-US")}</a>, rebuilt from RoundUpdated logs.` };
      historyCache.set(key, hit);
    } catch {
      return; // the static preview has no /api
    }
  }
  const el = document.querySelector("#full-history");
  if (el && current?.chain === chain && selected === pair) el.innerHTML = hit.html;
}

function renderDetail(s: Snapshot) {
  const f = s.feeds.find((x) => x.feed.pair === selected) ?? s.feeds[0];
  const d = s.deployment;
  const ev = f.history.at(-1);
  queueMicrotask(() => void renderFullHistory(d.chain, f.feed.pair)); // after the detail HTML is in place
  const sources = Object.keys(f.feed.sources)
    .map((k) => `<li>${esc(k)}</li>`)
    .join("");
  const reporters = s.reporters
    .map((r, i) => {
      const signed = ev ? (ev.signerBitmap >> i) & 1 : 0;
      return `<li class="${signed ? "signed" : ""}"><i class="lamp${signed ? " on" : ""}"></i>${link(d, "addr", r)}<span>${!ev ? "no round here yet" : signed ? "signed" : "no signature"}</span></li>`;
    })
    .join("");

  $("#detail").innerHTML = `
    <h2>${esc(f.feed.description)}</h2>
    <p class="lede">${f.roundId > 0n ? `Round ${f.roundId} settled at <strong>${fmt(f.answer, f.feed.decimals)}</strong>.` : f.configured === false ? "Not on this network: its owner has not configured this feed here." : "No round on this network yet."}</p>
    ${d.twap?.[f.feed.pair] ? `<p id="twap" class="twap" aria-live="polite">Reading the time-weighted average…</p>` : ""}
    ${d.kursRemit && f.feed.pair === "USD/IDR" ? `<p id="inkread" class="twap" aria-live="polite">Asking the ink! contract for this round…</p>` : ""}
    ${spark(f)}
    <ol class="steps">
      <li>
        <h3>Sources read off chain</h3>
        <p>Each reporter takes the median of these, drops any source more than 5% from the rest, and abstains below ${f.feed.minSources}.</p>
        <ul class="chips">${sources}</ul>
      </li>
      <li>
        <h3>Reporters sign their own number</h3>
        <p>EIP-712, no chain id in the domain, so the same signature is valid on every chain running Kurs.</p>
        <ul class="reporters">${reporters}</ul>
        <div id="verify" class="verify" aria-live="polite">${ev ? "Checking every signature of this round in your browser…" : ""}</div>
      </li>
      <li>
        <h3>KursOracle takes the median</h3>
        <p>It needs ${s.quorum} distinct reporters, rejects stale or future timestamps, and reverts when they disagree by more than ${(f.feed.maxSpreadBps / 100).toFixed(2)}%.</p>
        ${
          ev
            ? `<dl class="facts">
                <dt>Transaction</dt><dd>${txLink(d, ev.txHash, ev.blockNumber)}</dd>
                <dt>Sent by</dt><dd>${link(d, "addr", ev.transmitter)} <span class="muted">(anyone can send; the signatures carry the trust)</span></dd>
                <dt>Observed</dt><dd>${new Date(ev.observedAt * 1000).toUTCString()}</dd>
                <dt>Feed address</dt><dd>${d.aggregators[f.feed.pair] ? link(d, "addr", d.aggregators[f.feed.pair]) : "not deployed"} <span class="muted">(Chainlink AggregatorV3)</span></dd>
              </dl>`
            : ""
        }
      </li>
    </ol>`;
  renderParity(f);
  if (ev) void runVerify(s, f, ev);
  if (d.twap?.[f.feed.pair]) void renderTwap(d, f);
  if (d.kursRemit && f.feed.pair === "USD/IDR") void renderInk(d, f);
}

/** KursRemit (ink! v6, PolkaVM) reads the Solidity oracle; show its answer next to the oracle's own round. */
async function renderInk(d: Deployment, f: FeedState) {
  const el = () => (selected === f.feed.pair && current?.chain === d.chain ? document.querySelector<HTMLElement>("#inkread") : null);
  try {
    // latest() -> Result<(u128 round, i128 answer, u64, u64), LangError>: 0x00 then little-endian words
    const { data } = await clientFor(d).call({ to: d.kursRemit!, data: "0x46d8a35e" });
    const b = hexToBytes(data ?? "0x");
    if (b[0] !== 0) throw new Error(`ink! returned an error (${data})`);
    const le = (from: number, n: number) => b.slice(from, from + n).reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
    const [round, answer] = [le(1, 16), le(17, 16)];
    const same = round === f.roundId && answer === f.answer;
    if (el())
      el()!.innerHTML = `ink! v6 contract ${link(d, "addr", d.kursRemit!)} (KursRemit, PolkaVM) read this oracle cross-VM: round ${round} = <strong>${fmt(answer, f.feed.decimals)}</strong>, ${same ? "identical to the round above" : "an older round than the board's (it reads on demand)"}.`;
  } catch (e) {
    if (el()) el()!.textContent = `Could not read KursRemit: ${(e as Error).message.split("\n")[0]}`;
  }
}

/** 1 h and 10 min averages from KursTwap, next to the latest round; the longest window its history covers. */
async function renderTwap(d: Deployment, f: FeedState) {
  const address = d.twap![f.feed.pair];
  const c = clientFor(d);
  const el = () => (selected === f.feed.pair && current?.chain === d.chain ? document.querySelector<HTMLElement>("#twap") : null);
  try {
    const oldest = Number(await c.readContract({ address, abi: kursTwapAbi, functionName: "oldest" }));
    const span = Math.floor(Date.now() / 1000) - oldest - 30; // margin for block time vs this clock
    const windows = [3600, 600].filter((w) => w <= span);
    if (!windows.length) return void (el() && (el()!.textContent = "The time-weighted average needs a few more minutes of history."));
    const avgs = await Promise.all(windows.map((w) => c.readContract({ address, abi: kursTwapAbi, functionName: "consult", args: [w] })));
    const parts = windows.map((w, i) => `<strong>${fmt(avgs[i], f.feed.decimals)}</strong> over ${w >= 3600 ? `${w / 3600} h` : `${w / 60} min`}`);
    if (el())
      el()!.innerHTML = `Time-weighted average: ${parts.join(", ")}, from ${link(d, "addr", address)} (KursTwap; one round moves it far less than it moves the latest price).`;
  } catch (e) {
    if (el()) el()!.textContent = `Could not read the time-weighted average: ${(e as Error).message.split("\n")[0]}`;
  }
}

function obsTable(obs: CheckedObservation[], decimals: number, d?: Deployment) {
  return `<table class="plain sigs">
    <thead><tr><th scope="col">Recovered signer</th><th scope="col">Signed answer</th><th scope="col">Observed (UTC)</th><th scope="col">In reporter set</th></tr></thead>
    <tbody>${obs
      .map(
        (o) => `<tr>
          <td>${d ? link(d, "addr", o.signer) : `<code>${short(o.signer)}</code>`}</td>
          <td>${fmt(o.answer, decimals)}</td>
          <td>${new Date(o.observedAt * 1000).toISOString().slice(11, 19)}</td>
          <td class="${o.isReporter ? "" : "bad"}">${o.isReporter ? "yes" : "no"}</td>
        </tr>`,
      )
      .join("")}</tbody></table>`;
}

let verifySeq = 0;
async function runVerify(s: Snapshot, f: FeedState, ev: FeedState["history"][number]) {
  const seq = ++verifySeq;
  const el = () => document.querySelector<HTMLElement>("#verify");
  try {
    const v = await verifyRound(clientFor(s.deployment), s.deployment.oracle, ev.txHash, s.reporters, { feedId: keccak256(toBytes(f.feed.pair)), roundId: ev.roundId });
    if (seq !== verifySeq || !el()) return;
    const allIn = v.observations.every((o) => o.isReporter);
    const same = v.median === ev.answer && v.roundId === ev.roundId;
    el()!.innerHTML = `
      <p><strong>${same && allIn ? "Verified in your browser." : "Verification failed."}</strong>
      Decoded ${v.observations.length} signed observations from the transaction (${esc(v.path)}),
      recovered each signer with EIP-712, and recomputed the median:
      <strong>${fmt(v.median, f.feed.decimals)}</strong> ${same ? "equals" : "does not equal"} the on-chain answer.</p>
      ${obsTable(v.observations, f.feed.decimals, s.deployment)}`;
  } catch (e) {
    if (seq === verifySeq && el()) el()!.innerHTML = `<p class="muted">Could not verify this round: ${esc((e as Error).message.split("\n")[0])}.</p>`;
  }
}

// ------------------------------------------------------------------ pull (ERC-7412)

function renderPull() {
  const sel = document.querySelector<HTMLSelectElement>("#pull-pair");
  if (!sel || sel.options.length) return;
  sel.innerHTML = ALL_FEEDS.map((f) => `<option${f.pair === "USD/IDR" ? " selected" : ""}>${esc(f.pair)}</option>`).join("");
  document.querySelector<HTMLFormElement>("#pull-form")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.querySelector<HTMLElement>("#pull-out")!;
    const pair = sel.value;
    const feed = ALL_FEEDS.find((x) => x.pair === pair)!;
    out.innerHTML = `<p class="muted">Asking the bundle API for a signed ${esc(pair)} round…</p>`;
    try {
      const r = await fetch(`/api/bundle?pair=${encodeURIComponent(pair)}`);
      const isJson = (r.headers.get("content-type") ?? "").includes("application/json");
      if (!isJson) {
        throw new Error(
          "The bundle API is not served by this host (it runs as a serverless function on the Vercel deployment). Use the CLI: kurs pull-convert.",
        );
      }
      const body = await r.json();
      if (!r.ok) throw new Error(`Bundle API: ${body.error ?? `answered ${r.status}`}`);
      if (typeof body.payload !== "string" || !body.payload.startsWith("0x")) throw new Error("Bundle API returned no payload.");
      const reporters = last?.reporters ?? body.reporters;
      const v = await verifyBundlePayload(body.payload, reporters);
      const ok = v.observations.every((o) => o.isReporter);
      out.innerHTML = `
        <p><strong>${ok ? "Every signature checks out against the on-chain reporter set." : "Some signers are not in the reporter set."}</strong>
        Round ${v.roundId}, median ${fmt(v.median, feed.decimals)}. Pass this payload to <code>KursOracle.fulfillOracleQuery</code> on any chain running Kurs.</p>
        ${obsTable(v.observations, feed.decimals)}
        <label class="payload">ERC-7412 payload (${(body.payload.length - 2) / 2} bytes)
          <textarea readonly rows="3">${esc(body.payload)}</textarea></label>
        ${pair === "USD/IDR" ? walletPullHtml() : ""}`;
      if (pair === "USD/IDR") bindWalletPull(body.payload as Hex);
    } catch (err) {
      out.innerHTML = `<p class="bad-text">${esc((err as Error).message)}</p>`;
    }
  });
}

// The same pull from the visitor's own wallet: one Sepolia transaction,
// Multicall3.aggregate3([KursOracle.fulfillOracleQuery(bundle), KursConverter.convert($100.00)]).
// KursConverter only accepts a USD/IDR price younger than 300 s, so this works because the
// bundle lands in the same transaction. The result is read back from its Converted event.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])",
]);
const injected = () => (window as unknown as { ethereum?: EIP1193Provider }).ethereum;

function walletPullHtml() {
  const sep = deployments.find((d) => d.chain === "sepolia");
  if (!sep?.converter) return "";
  return injected()
    ? `<p><button type="button" id="wallet-pull">Convert $100 with this bundle from your wallet (Sepolia)</button></p><div id="wallet-out" aria-live="polite"></div>`
    : `<p class="muted" id="wallet-out">With a browser wallet (MetaMask, Rabby…) on Sepolia you can send this bundle and a $100 conversion in one transaction from here. Without one: <code>kurs pull-convert</code>.</p>`;
}

function bindWalletPull(payload: Hex) {
  const btn = document.querySelector<HTMLButtonElement>("#wallet-pull");
  const sep = deployments.find((d) => d.chain === "sepolia")!;
  const provider = injected();
  if (!btn || !provider || !sep.converter) return;
  btn.addEventListener("click", async () => {
    const out = document.querySelector<HTMLElement>("#wallet-out")!;
    btn.disabled = true;
    try {
      out.innerHTML = `<p class="muted">Waiting for your wallet…</p>`;
      const wallet = createWalletClient({ chain: sepoliaChain, transport: custom(provider) });
      const [account] = await wallet.requestAddresses();
      if ((await wallet.getChainId()) !== sepoliaChain.id) await wallet.switchChain({ id: sepoliaChain.id });
      const hash = await wallet.writeContract({
        account,
        address: MULTICALL3,
        abi: multicallAbi,
        functionName: "aggregate3",
        args: [[
          { target: sep.oracle, allowFailure: false, callData: encodeFunctionData({ abi: kursOracleAbi, functionName: "fulfillOracleQuery", args: [payload] }) },
          { target: sep.converter!, allowFailure: false, callData: encodeFunctionData({ abi: kursConverterAbi, functionName: "convert", args: [10_000n] }) },
        ]],
      });
      out.innerHTML = `<p class="muted">Sent ${link(sep, "tx", hash)}; waiting for a block…</p>`;
      const rc = await clientFor(sep).waitForTransactionReceipt({ hash, timeout: 180_000 });
      const ev = parseEventLogs({ abi: kursConverterAbi, logs: rc.logs, eventName: "Converted" })[0];
      if (rc.status !== "success" || !ev) throw new Error(`transaction ${hash} did not convert`);
      out.innerHTML = `<p><strong>$100.00 = Rp ${(Number(ev.args.converted) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}</strong>
        at round ${ev.args.roundId} (${fmt(ev.args.price, 8)}), in one transaction: ${link(sep, "tx", hash)}.
        The bundle you just verified was written on chain and used by the converter in the same call.</p>`;
    } catch (e) {
      out.innerHTML = `<p class="bad-text">${esc((e as Error).message.split("\n")[0])}</p>`;
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ parity

function renderParity(f: FeedState) {
  const rows = deployments
    .map((d) => {
      const s = d.chain === current?.chain ? last : others.get(d.chain);
      const st = s?.feeds.find((x) => x.feed.pair === f.feed.pair);
      return { d, st };
    })
    // a network that does not serve the feed has nothing to compare
    .filter((r) => r.st && r.st.configured !== false && r.st.roundId > 0n);
  if (rows.length < 2) {
    $("#parity").innerHTML = `<p class="muted">${rows.length ? `Only ${esc(NETWORKS[rows[0].d.chain].label)} has a round of this feed so far` : "No network has a round of this feed yet"}, so there is nothing to compare. Feeds served on both networks show the same signed round on each.</p>`;
    return;
  }
  const ref = rows[0].st!;
  $("#parity").innerHTML = `
    <table class="plain">
      <thead><tr><th scope="col">Network</th><th scope="col">Round</th><th scope="col">Answer</th><th scope="col">Same as ${esc(NETWORKS[rows[0].d.chain].label)}</th></tr></thead>
      <tbody>${rows
        .map(({ d, st }) => {
          const same = st!.roundId === ref.roundId && st!.answer === ref.answer;
          return `<tr><td>${esc(NETWORKS[d.chain].label)}</td><td>${st!.roundId}</td><td>${fmt(st!.answer, f.feed.decimals)}</td><td>${same ? "Yes, identical round" : st!.roundId < ref.roundId ? "Behind, relay pending" : "Different round"}</td></tr>`;
        })
        .join("")}</tbody>
    </table>`;
}

// ------------------------------------------------------------------ pools

const STOCKS = [
  { sym: "TSLA", id: 8801003 },
  { sym: "NVDA", id: 8801001 },
  { sym: "AAPL", id: 8801002 },
  { sym: "AMZN", id: 8801004 },
  { sym: "META", id: 8801005 },
];
const DUCAT = 8801000;

function offBy(implied?: number, kurs?: number) {
  if (!implied || !kurs) return "";
  const r = implied / kurs;
  if (r < 0.5) return `${Math.round(1 / r).toLocaleString("en-US")}× too low`;
  if (r > 2) return `${Math.round(r).toLocaleString("en-US")}× too high`;
  return `${((r - 1) * 100).toFixed(1)}%`;
}

async function renderPools(s: Snapshot, attempt = 1): Promise<void> {
  const el = $("#pools");
  try {
    // route: 1 stock -> DUCAT -> tPOT -> pUSD, all through pallet-asset-conversion
    const [ducatPerTpot, tpotUsd] = await Promise.all([poolPrice("native", DUCAT, 14, 10), poolPrice("native", 7777, 14, 6)]);
    if (!ducatPerTpot || !tpotUsd) throw new Error("route pools missing");
    const rows = await Promise.all(
      STOCKS.map(async (x) => {
        const ducatPerStock = await poolPrice(x.id, DUCAT, 10, 10);
        const implied = ducatPerStock === undefined ? undefined : (ducatPerStock / ducatPerTpot) * tpotUsd;
        const k = s.feeds.find((f) => f.feed.pair === `${x.sym}/USD`);
        const kurs = k && k.roundId > 0n ? Number(k.answer) / 1e8 : undefined;
        const dev = implied && kurs ? (implied - kurs) / kurs : undefined;
        return { ...x, implied, kurs, dev };
      }),
    );
    el.innerHTML = `
      <table class="plain">
        <thead><tr><th scope="col">Pool on Portaldot</th><th scope="col">Implied USD price</th><th scope="col">Kurs</th><th scope="col">Off by</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
              <td>${r.sym} / DUCAT</td>
              <td>${r.implied === undefined ? "no pool" : "$" + r.implied.toPrecision(4)}</td>
              <td>${r.kurs === undefined ? "no round yet" : "$" + r.kurs.toFixed(2)}</td>
              <td class="${r.dev !== undefined && Math.abs(r.dev) > 0.05 ? "bad" : ""}">${offBy(r.implied, r.kurs)}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>
      <p class="muted">Implied price routes each stock through its DUCAT pool, the tPOT/DUCAT pool and the tPOT/pUSD pool, all read live from pallet-asset-conversion. A lending market that priced these tokens from their own pools would accept them at the wrong value; one that reads Kurs would not.</p>`;
  } catch (e) {
    // the public node is sometimes slow: try twice more before showing the error
    if (attempt < 3) return void setTimeout(() => void renderPools(last ?? s, attempt + 1), 4000);
    el.innerHTML = `<p class="muted">Could not read Portaldot pools: ${esc((e as Error).message)}.</p>`;
  }
}

// ------------------------------------------------------------------ boot

async function renderGovernance(d: Deployment) {
  const el = document.querySelector<HTMLElement>("#gov");
  if (!el) return;
  try {
    const owner = await ownerOf(d);
    if (current?.chain !== d.chain) return; // a late read must not overwrite the other network's panel
    const g = d.governance;
    const tl = g?.timelock;
    if (g && tl?.pureH160 && owner.toLowerCase() === tl.pureH160.toLowerCase()) {
      const minutes = Math.round((tl.delayBlocks * 6) / 60); // Portaldot V3 blocks are ~6 s (measured: 6,030 s per 1,000 blocks)
      el.innerHTML = `<p>On ${esc(NETWORKS[d.chain].label)} the oracle's <code>owner()</code> is a pure proxy held by the <strong>native Portaldot ${g.threshold}-of-${g.signatories.length} multisig behind a ${tl.delayBlocks}-block (about ${minutes} min) timelock</strong>, built from pallet-proxy. Any change to feeds, reporters or ownership must be announced by ${g.threshold} Substrate signers and can only run ${tl.delayBlocks} blocks later; until then the multisig can veto it.</p>
        <p class="muted">Pure proxy <code>${esc(short(tl.pure ?? ""))}</code> (Revive <code>${esc(short(tl.pureH160))}</code>), controlled by multisig <code>${esc(short(g.account))}</code>.</p>`;
    } else if (g && owner.toLowerCase() === g.h160.toLowerCase()) {
      const native = g.type.startsWith("pallet-multisig");
      el.innerHTML = native
        ? `<p>On ${esc(NETWORKS[d.chain].label)} the oracle's <code>owner()</code> is a <strong>native Portaldot ${g.threshold}-of-${g.signatories.length} multisig</strong> (pallet-multisig), not a single key. Changing feeds, reporters or ownership takes ${g.threshold} Substrate signatures, executed into the EVM contract through <code>revive.call</code>.</p>
        <p class="muted">Multisig <code>${esc(short(g.account))}</code>, Revive address <code>${esc(short(g.h160))}</code>.</p>`
        : `<p>On ${esc(NETWORKS[d.chain].label)} the oracle's <code>owner()</code> is a <strong>${g.threshold}-of-${g.signatories.length} Safe</strong>, not a single key. Changing feeds, reporters or ownership takes ${g.threshold} owner signatures on a Safe transaction.</p>
        <p class="muted">Safe ${link(d, "addr", g.account)}.</p>`;
    } else {
      el.innerHTML = `<p>On ${esc(NETWORKS[d.chain].label)} the oracle's <code>owner()</code> is <code>${esc(short(owner))}</code>, a single deployer key.</p>`;
    }
  } catch (e) {
    el.innerHTML = `<p class="muted">Could not read the owner: ${esc((e as Error).message.split("\n")[0])}.</p>`;
  }
  if (d.chain === "portaldot") void renderGas(d, el);
}

const RELAYER = "0x1d63E7A1cC358Cb40Aa6073b7c44Fd3c916b2540" as Address; // pays relay gas, holds no rights
const BURN_PER_HOUR = 0.5; // measured on Portaldot: ~0.105 tPOT per slot-aligned round, 13 feeds
/** The relay's gas on Portaldot, read live: how long the feeds stay fresh without a refill. */
async function renderGas(d: Deployment, el: HTMLElement) {
  try {
    const bal = Number(await clientFor(d).getBalance({ address: RELAYER })) / 1e18;
    if (current?.chain !== d.chain) return; // switched away meanwhile
    document.querySelector("#gas")?.remove(); // one line, even when refreshes overlap
    const hours = Math.floor(bal / BURN_PER_HOUR);
    el.insertAdjacentHTML(
      "beforeend",
      `<p id="gas">Relay gas: the transmitter holds <strong>${bal.toFixed(1)} tPOT</strong>, about <strong>${hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`}</strong> of rounds at ~${BURN_PER_HOUR} tPOT/h. It only pays gas; a faucet top-up runs every hour below 100 tPOT, and anyone can send tPOT to <code>${esc(short(RELAYER))}</code> (<a href="https://github.com/PugarHuda/kurs#if-a-portaldot-feed-looks-stale-it-is-out-of-gas-and-anyone-can-fix-it" target="_blank" rel="noopener">how</a>).</p>`,
    );
  } catch {
    /* informational only; the owner panel above already reports read failures */
  }
}

// ------------------------------------------------------------------ convert
// Same paths as /api/quote and the MCP convert tool, computed here from the rounds this
// page already read on chain: direct feed, inverse, or two feeds through USD.

const ASSETS = [...new Set(ALL_FEEDS.flatMap((f) => f.pair.split("/")))];

function convertPath(s: Snapshot, from: string, to: string): { rate: number; used: FeedState[] } | undefined {
  const get = (p: string) => s.feeds.find((f) => f.feed.pair === p && f.roundId > 0n);
  const px = (f: FeedState) => Number(f.answer) / 10 ** f.feed.decimals;
  const hop = (a: string, b: string) => {
    if (a === b) return { rate: 1, used: [] as FeedState[] };
    const d = get(`${a}/${b}`);
    if (d) return { rate: px(d), used: [d] };
    const i = get(`${b}/${a}`);
    if (i) return { rate: 1 / px(i), used: [i] };
    return undefined;
  };
  const direct = hop(from, to);
  if (direct) return direct;
  const a = hop(from, "USD");
  const b = hop("USD", to);
  return a && b ? { rate: a.rate * b.rate, used: [...a.used, ...b.used] } : undefined;
}

function renderConvert() {
  const form = document.querySelector<HTMLFormElement>("#convert-form");
  const from = document.querySelector<HTMLSelectElement>("#convert-from");
  const to = document.querySelector<HTMLSelectElement>("#convert-to");
  const amount = document.querySelector<HTMLInputElement>("#convert-amount");
  if (!form || !from || !to || !amount) return;
  if (!from.options.length) {
    const opts = (sel: string) => ASSETS.map((a) => `<option${a === sel ? " selected" : ""}>${esc(a)}</option>`).join("");
    from.innerHTML = opts("USD");
    to.innerHTML = opts("EUR");
    form.addEventListener("input", renderConvert);
    form.addEventListener("submit", (e) => e.preventDefault());
  }
  const out = document.querySelector<HTMLElement>("#convert-out")!;
  if (!last) return;
  const n = Number(amount.value);
  if (!(n > 0) || !Number.isFinite(n)) return void (out.innerHTML = `<p class="muted">Enter an amount above zero.</p>`);
  const p = convertPath(last, from.value, to.value);
  if (!p) return void (out.innerHTML = `<p class="bad-text">No Kurs path from ${esc(from.value)} to ${esc(to.value)} on ${esc(NETWORKS[last.deployment.chain].label)}: Kurs does not invent a cross rate it has no feeds for.</p>`);
  const result = n * p.rate;
  if (!Number.isFinite(result) || n < 1e-12 || n > 1e15) return void (out.innerHTML = `<p class="muted">Enter an amount between 0.000000000001 and 1e15.</p>`);
  const now = Date.now() / 1000;
  const shown = (x: number) => x.toLocaleString("en-US", { maximumSignificantDigits: x >= 1 ? 12 : 6 });
  out.innerHTML = `<p class="convert-result"><strong>${shown(n)} ${esc(from.value)} = ${shown(result)} ${esc(to.value)}</strong></p>
    <p class="muted">${p.used.length ? `Using ${p.used.map((f) => `${esc(f.feed.pair)} round ${f.roundId} (${fmt(f.answer, f.feed.decimals)}, ${Math.max(0, Math.round((now - f.observedAt) / 60))} min old)`).join(" and ")}.` : "Same asset."}</p>`;
}

async function refresh() {
  if (!current) return;
  const d = current;
  try {
    const s = await snapshot(d);
    if (d !== current) return; // the user switched network meanwhile: drop the late reply
    last = s;
    others.set(d.chain, last); // kept for parity after the user switches network
    renderBoard(last);
    renderDetail(last);
    renderConvert();
    void renderGovernance(current);
    $("#status").textContent = "";
  } catch (e) {
    if (d !== current) return;
    $("#status").textContent = `Could not reach ${NETWORKS[d.chain].label}: ${(e as Error).message.split("\n")[0].replace(/\.$/, "")}. Retrying.`;
  }
}

async function refreshOthers() {
  for (const d of deployments) {
    if (d.chain === current?.chain) continue;
    await snapshot(d)
      .then((s) => others.set(d.chain, s))
      .catch(() => {});
  }
  if (last) renderParity(last.feeds.find((f) => f.feed.pair === selected) ?? last.feeds[0]);
}

function renderNetworks() {
  $("#networks").innerHTML = deployments
    .map(
      (d) =>
        `<button type="button" aria-pressed="${d.chain === current?.chain}" data-net="${d.chain}">${esc(NETWORKS[d.chain].label)}</button>`,
    )
    .join("");
  for (const b of document.querySelectorAll<HTMLButtonElement>("#networks button")) {
    b.addEventListener("click", () => {
      current = deployments.find((d) => d.chain === b.dataset.net);
      history.replaceState(null, "", `?net=${current!.chain}&feed=${encodeURIComponent(selected)}`);
      renderNetworks();
      document.querySelector<HTMLButtonElement>(`#networks button[data-net="${current!.chain}"]`)?.focus(); // keep keyboard focus
      void refresh();
    });
  }
}

async function boot() {
  $("#feed-count").textContent = String(FEEDS.length);
  oracleOperatorCount()
    .then((n) => ($("#operators").textContent = n === 0 ? "no operators" : `${n} operator${n > 1 ? "s" : ""}`))
    .catch(() => ($("#operators").textContent = "unknown operators"));

  if (!current) {
    $("#board-body").innerHTML = `<tr><td colspan="5" class="empty">Kurs is not deployed on any network yet. Run <code>npm run deploy</code> in reporter/.</td></tr>`;
    return;
  }
  renderNetworks();
  renderPull();
  await refresh();
  void renderPools(last!);
  void refreshOthers();
  setInterval(refresh, 15_000);
  setInterval(refreshOthers, 60_000);
}

void boot();
