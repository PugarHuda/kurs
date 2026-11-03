import "./style.css";
import type { Address, Hex } from "viem";
import { FEEDS } from "../../reporter/src/feeds";
import { FEEDS as ALL_FEEDS } from "../../reporter/src/feeds";
import { verifyBundlePayload, verifyRound, type CheckedObservation } from "./verify";
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
let selected = params.get("feed") ?? "USD/IDR";
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
      <td class="led">${has ? fmt(f.answer, f.feed.decimals) : "--.--"}</td>
      <td class="move">${move}</td>
      <td class="signers" title="${countBits(latestBitmap)} of ${s.reporters.length} reporters signed the latest round">${bits(latestBitmap, s.reporters.length)}</td>
      <td class="age">${has ? ago(f.updatedAt) : "waiting"}</td>
    </tr>`;
}

const countBits = (b: number) => b.toString(2).split("").filter((x) => x === "1").length;

function sourceLine(f: FeedState) {
  const n = Object.keys(f.feed.sources).length;
  if (f.feed.sources["portaldot-assetconversion"]) return "Portaldot AssetConversion pool";
  return `${n} source${n > 1 ? "s" : ""}`;
}

function renderBoard(s: Snapshot) {
  $("#board-body").innerHTML = s.feeds.map((f) => boardRow(s, f)).join("");
  $("#board-meta").textContent = `${NETWORKS[s.deployment.chain].label}, block ${s.block.toLocaleString("en-US")}, quorum ${s.quorum} of ${s.reporters.length}`;
  for (const tr of document.querySelectorAll<HTMLTableRowElement>("#board-body tr")) {
    const pick = () => {
      selected = tr.dataset.pair!;
      history.replaceState(null, "", `?net=${s.deployment.chain}&feed=${encodeURIComponent(selected)}`);
      renderBoard(s);
      renderDetail(s);
    };
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick()));
  }
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
      return `<li class="${signed ? "signed" : ""}"><i class="lamp${signed ? " on" : ""}"></i>${link(d, "addr", r)}<span>${signed ? "signed" : "no signature"}</span></li>`;
    })
    .join("");

  $("#detail").innerHTML = `
    <h2>${esc(f.feed.description)}</h2>
    <p class="lede">${f.roundId > 0n ? `Round ${f.roundId} settled at <strong>${fmt(f.answer, f.feed.decimals)}</strong>.` : "No round on this network yet."}</p>
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
    const v = await verifyRound(clientFor(s.deployment), s.deployment.oracle, ev.txHash, s.reporters);
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
          <textarea readonly rows="3">${esc(body.payload)}</textarea></label>`;
    } catch (err) {
      out.innerHTML = `<p class="bad-text">${esc((err as Error).message)}</p>`;
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
    .filter((r) => r.st);
  if (rows.length < 2) {
    $("#parity").innerHTML = `<p class="muted">Kurs is deployed on one network so far. Run <code>kurs once</code> with <code>KURS_CHAINS=portaldot,sepolia</code> to relay the same signed rounds to Sepolia.</p>`;
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

async function renderPools(s: Snapshot) {
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
    el.innerHTML = `<p class="muted">Could not read Portaldot pools: ${esc((e as Error).message)}.</p>`;
  }
}

// ------------------------------------------------------------------ boot

async function renderGovernance(d: Deployment) {
  const el = document.querySelector<HTMLElement>("#gov");
  if (!el) return;
  try {
    const owner = await ownerOf(d);
    const g = d.governance;
    if (g && owner.toLowerCase() === g.h160.toLowerCase()) {
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
}

async function refresh() {
  if (!current) return;
  try {
    last = await snapshot(current);
    others.set(current.chain, last); // kept for parity after the user switches network
    renderBoard(last);
    renderDetail(last);
    void renderGovernance(current);
    $("#status").textContent = "";
  } catch (e) {
    $("#status").textContent = `Could not reach ${NETWORKS[current.chain].label}: ${(e as Error).message.split("\n")[0]}. Retrying.`;
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
