/* Grok Bot Desk · client. Reads DATA_PATH and the AES key from #d=…&k=… on every load (kept in the URL), localStorage as fallback,
   polls the encrypted data files and decrypts them with WebCrypto AES-GCM. Every FOMO link comes from the JSON (written by links.py).
   Liveness: between publishes the browser polls DexScreener directly (CORS *) for the coins already in the decrypted data only,
   marks open positions with those prices and builds 1-minute candles on top of the stored db.prices history.
   If that poll fails it quietly falls back to the published numbers. PAPER only: nothing here can trade. */
(function () {
  "use strict";
  const POLL_S = 15, STALE_MIN = 15, LIVE_S = 12;
  const DS = "https://api.dexscreener.com/tokens/v1/solana/";
  const REDUCED = Charts.REDUCED;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = { dp: null, dk: null, decryptFail: false, view: { name: "home" }, range: "LIVE", d: {}, offline: false, lastOk: null, retryAt: 0, failures: 0, animated: {} };
  const L = { px: {}, img: {}, imgEl: {}, hist: {}, peak: {}, ok: null, at: 0 };   // live DexScreener layer

  /* ---------- boot: credentials from the #d=…&k=… fragment on EVERY load (first), localStorage only as fallback.
     The fragment is deliberately kept in the address bar: iOS "Add to Home Screen" saves the current URL, and the
     Home Screen app has its own storage, separate from Safari. The fragment is never sent to the server. */
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fd = hash.get("d"), fk = hash.get("k");
  if (fd && fk) {
    if (localStorage.getItem("dp") !== fd || localStorage.getItem("dk") !== fk) {
      // different link than last time: drop everything cached under the old path/key
      Object.keys(localStorage).filter(k => k.startsWith("lg:")).forEach(k => localStorage.removeItem(k));
    }
    try { localStorage.setItem("dp", fd); localStorage.setItem("dk", fk); } catch (e) { /* private mode */ }
    S.dp = fd; S.dk = fk;
  } else {
    S.dp = localStorage.getItem("dp");
    S.dk = localStorage.getItem("dk");
  }
  if (!S.dk) S.dp = null;   // without the key there is nothing we can read
  const q = new URLSearchParams(location.search);
  if (q.get("view")) S.view = { name: q.get("view"), mint: q.get("mint") || null };
  if (q.get("range")) S.range = q.get("range");
  const NOLIVE = q.get("live") === "0";

  /* ---------- formatting */
  const usd = (v, d = 2) => v == null ? "–" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const signedUsd = v => v == null ? "–" : (v >= 0 ? "+" : "-") + usd(Math.abs(v));
  const short = v => { if (v == null) return "n/a"; const a = Math.abs(v); return a >= 1e9 ? "$" + (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? "$" + (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? "$" + (a / 1e3).toFixed(1) + "K" : "$" + a.toFixed(0); };
  const px = v => { if (v == null) return "–"; if (v >= 1) return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 4 }); return "$" + Number(v.toPrecision(4)).toFixed(Math.max(2, 3 - Math.floor(Math.log10(v)))); };
  const axis = v => v >= 1 ? v.toFixed(3) : v.toPrecision(3).replace(/^0/, "");
  const hm = iso => { if (!iso) return "–"; const d = new Date(iso); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };

  /* ---------- data */
  async function get(rel) {
    if (!S.dp) throw new Error("no data path");
    const r = await fetch(`d/${encodeURIComponent(S.dp)}/${rel.replace(/\.json$/, ".bin")}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
    let j;
    try { j = await DeskCrypto.decryptJSON(S.dk, await r.arrayBuffer()); }
    catch (e) { throw Object.assign(new Error("decrypt"), { decrypt: true }); }
    try { localStorage.setItem("lg:" + rel, JSON.stringify(j)); } catch (e) { /* quota */ }
    return j;
  }
  function cached(rel) { try { return JSON.parse(localStorage.getItem("lg:" + rel)); } catch (e) { return null; } }
  function need() {
    const v = S.view, list = ["state.json"];
    if (v.name === "home") list.push(`chart-${S.range}.json`);
    if (v.name === "activity") list.push("activity-0.json");
    if (v.name === "agents") ["scanner", "scanner2", "scanner3", "auditor", "analyst", "executor", "risk"].forEach(a => list.push(`agents/${a}.json`));
    if (v.name === "account") list.push("account.json", "settings.json");
    if (v.name === "coin" && v.mint) list.push(`coin/${v.mint}.json`, `audit/${v.mint}.json`);
    if (v.name === "audit") list.push(v.mint ? `audit/${v.mint}.json` : "audit/latest.json");
    return list;
  }
  async function poll() {
    const files = need();
    let ok = true, notFound = [], bad = false;
    await Promise.all(files.map(async f => {
      try { S.d[f] = await get(f); }
      catch (e) { if (e.decrypt) { bad = true; ok = false; }
        else if (e.status === 404 && f !== "state.json") { notFound.push(f); S.d[f] = S.d[f] || cached(f) || null; } else { ok = false; S.d[f] = S.d[f] || cached(f); } }
    }));
    S.notFound = notFound;
    S.decryptFail = bad;
    if (bad) {   // never show numbers we could not verify: drop data + cache, show the error states
      S.d = {};
      Object.keys(localStorage).filter(k => k.startsWith("lg:")).forEach(k => localStorage.removeItem(k));
    }
    const st = S.d["state.json"];
    const stale = st && (Date.now() - Date.parse(st.updated_at)) / 60000 > STALE_MIN;
    if (ok) { S.lastOk = st ? st.updated_at : new Date().toISOString(); S.failures = 0; }
    else S.failures++;
    S.offline = !ok || !!stale || (st && st.online === false);
    S.retryAt = Date.now() + POLL_S * 1000;
    render();
    events();
    if (!L.at) live();
  }
  function offlineRow() {
    const el = $("#offline");
    if (!S.offline && S.dp) { el.hidden = true; return; }
    const n = Math.max(0, Math.round((S.retryAt - Date.now()) / 1000));
    const st = S.d["state.json"];
    const last = st ? hm(st.updated_at) : (S.lastOk ? hm(S.lastOk) : "never");
    el.textContent = S.decryptFail ? "Can't decrypt desk data · open the app once with its new private link" : S.dp ? `Desk offline · retrying in ${n}s · last update ${last}` : "Open the private link from Telegram in Safari, then Share → Add to Home Screen";
    el.hidden = false;
  }
  setInterval(offlineRow, 1000);

  /* ---------- live layer: DexScreener, only for mints that are already in the decrypted data */
  function liveMints() {
    const st = S.d["state.json"]; if (!st) return [];
    const m = [];
    const add = x => { if (x && !m.includes(x) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x)) m.push(x); };
    (st.open || []).forEach(p => add(p.mint));
    if (S.view.name === "coin") add(S.view.mint);
    (st.closed || []).slice(0, 5).forEach(p => add(p.mint));
    (st.activity || []).forEach(a => add(a.mint));
    st.agents.forEach(c => { (c.feed || []).slice(0, 3).forEach(f => add(f.mint)); if (c.last) add(c.last.mint); add(c.lastExitMint); });
    const ch = S.d[`chart-${S.range}.json`]; if (ch) (ch.marks || []).slice(-4).forEach(k => add(k.mint));
    return m.slice(0, 30);
  }
  function poolOf(mint) {
    const st = S.d["state.json"], c = S.d[`coin/${mint}.json`];
    const o = st && (st.open || []).find(p => p.mint === mint);
    return (o && o.pool) || (c && c.pool) || null;
  }
  async function live() {
    L.at = Date.now();
    if (NOLIVE || document.hidden) return;
    const mints = liveMints(); if (!mints.length) return;
    try {
      const r = await fetch(DS + mints.join(","), { cache: "no-store", referrerPolicy: "no-referrer", credentials: "omit" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const pairs = await r.json();
      if (!Array.isArray(pairs)) throw new Error("shape");
      const now = Date.now(), bucket = new Date(now).toISOString().slice(0, 16);
      mints.forEach(mint => {
        const mine = pairs.filter(p => p && p.baseToken && p.baseToken.address === mint && p.priceUsd);
        if (!mine.length) return;
        const pool = poolOf(mint);
        const pr = mine.find(p => p.pairAddress === pool) || mine.slice().sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0];
        const price = Number(pr.priceUsd);
        const img = (mine.find(p => p.info && p.info.imageUrl) || {}).info;
        if (img && img.imageUrl && /^https:\/\//.test(img.imageUrl)) L.img[mint] = img.imageUrl;
        if (!(price > 0)) return;
        const prev = L.px[mint];
        const vm5 = pr.volume && pr.volume.m5 != null ? Number(pr.volume.m5) : null;
        L.px[mint] = { price, ts: now, liq: pr.liquidity ? pr.liquidity.usd : null, mc: pr.marketCap || pr.fdv || null,
          vol24: pr.volume ? pr.volume.h24 : null, vm5 };
        L.peak[mint] = Math.max(L.peak[mint] || 0, price);
        const dv = prev && prev.vm5 != null && vm5 != null ? Math.max(0, vm5 - prev.vm5) : 0;
        const h = L.hist[mint] = L.hist[mint] || [];
        const cur = h[h.length - 1];
        if (cur && cur.t === bucket) { cur.h = Math.max(cur.h, price); cur.l = Math.min(cur.l, price); cur.c = price; cur.v += dv; }
        else h.push({ t: bucket, o: cur ? cur.c : price, h: Math.max(price, cur ? cur.c : price), l: Math.min(price, cur ? cur.c : price), c: price, v: dv });
        if (h.length > 240) h.shift();
      });
      L.ok = true;
    } catch (e) { L.ok = false; /* quiet: published numbers stay on screen */ }
    render();
  }
  setInterval(() => { if (Date.now() - L.at >= LIVE_S * 1000 - 200) live(); }, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { poll(); live(); } });
  const livePx = (mint, fallback) => { const l = L.px[mint]; return l && Date.now() - l.ts < 120e3 ? l.price : fallback; };
  /* live balance = published balance + the move of each open position since the price the desk last marked it at (same formula as the desk) */
  function liveBalance(st) {
    let v = st.balance;
    (st.open || []).forEach(p => { const lp = livePx(p.mint, null); if (lp && p.lastPrice && p.entry && p.mode === "PAPER") v += p.size * (lp - p.lastPrice) / p.entry; });
    return Math.round(v * 100) / 100;
  }
  function exitLineOf(p, mint) {
    const peak = Math.max(p.peak || 0, L.peak[mint] && p.trailActive ? L.peak[mint] : 0);
    return p.trailActive ? Math.max(p.stop, peak * (1 - p.trailPct / 100)) : p.stop;
  }

  /* ---------- odometer: changed digits roll 700ms ease-out, 40ms stagger right to left */
  function odometer(el, text) {
    if (!el) return;
    const chars = [...text];
    const prevNum = parseFloat((el.dataset.v || "").replace(/[^0-9.\-]/g, "")), nowNum = parseFloat(text.replace(/[^0-9.\-]/g, ""));
    if (el.dataset.len != chars.length || REDUCED) {
      el.innerHTML = chars.map(c => /\d/.test(c)
        ? `<span class="d"><span class="col">${[...Array(10).keys()].map(n => `<span>${n}</span>`).join("")}</span></span>`
        : `<span>${esc(c)}</span>`).join("");
      el.dataset.len = chars.length; el.dataset.v = text;
      const digits = chars.filter(x => /\d/.test(x));
      [...el.querySelectorAll(".col")].forEach((c, i) => { c.style.transition = "none"; c.style.transform = `translateY(-${digits[i] * 10}%)`; void c.offsetHeight; c.style.transition = ""; });
      return;
    }
    if (el.dataset.v === text) return;
    const old = [...(el.dataset.v || "")];
    const nodes = [...el.children];
    let stagger = 0;
    for (let i = chars.length - 1; i >= 0; i--) {
      const col = nodes[i] && nodes[i].querySelector(".col");
      if (col && chars[i] !== old[i]) { col.style.transitionDelay = (stagger * 40) + "ms"; stagger++; col.style.transform = `translateY(-${Number(chars[i]) * 10}%)`; }
      else if (!col && nodes[i]) nodes[i].textContent = chars[i];
    }
    el.dataset.v = text;
    if (isFinite(prevNum) && isFinite(nowNum) && prevNum !== nowNum) {
      el.classList.remove("up", "down"); void el.offsetWidth; el.classList.add(nowNum > prevNum ? "up" : "down");
    }
  }

  /* ---------- shared pieces */
  const paperPill = mode => mode === "PAPER" ? `<span class="pill paper">PAPER</span>` : "";
  /* strategy badge (Nov 10): every trade row / position says which strategy took it; old rows without a tag = normal */
  const TRADE_KINDS = ["bought", "sold", "stopped"];
  const SB = { scalp: ["scalp", "Scalp"], compounder: ["comp", "Compounder"], normal: ["normal", "Normal"] };
  const stratBadge = (s, kind) => (s || (kind && TRADE_KINDS.includes(kind))) ? `<span class="sb ${(SB[s] || SB.normal)[0]}">${(SB[s] || SB.normal)[1]}</span>` : "";
  const hypeCls = v => v == null ? "" : v >= 0.5 ? "green" : v >= 0.25 ? "orange" : "sec";
  const chev = `<svg class="chev" viewBox="0 0 8 14"><path d="M1 1l6 6-6 6"/></svg>`;
  const backBtn = label => `<button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>${esc(label || "Back")}</button>`;
  const sk = (h, mt = 12, mx = 16) => `<div class="sk" style="height:${h}px;margin:${mt}px ${mx}px 0"></div>`;
  function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 1800); }
  const hue = s => { let h = 0; for (const ch of String(s || "?")) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  function avatar(mint, name, size = 40) {
    const nm = String(name || mint || "?").replace(/^(Bought|Sold|Stopped|Rejected)\s+/, "");
    const ini = esc(nm.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?");
    const img = L.img[mint];
    return `<span class="av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;background:hsl(${hue(mint || nm)} 45% 28%)">${ini}${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : ""}</span>`;
  }
  function imgFor(mint) {   // canvas use: cached Image elements for chart pills
    const u = L.img[mint]; if (!u) return null;
    if (!L.imgEl[mint]) { const im = new Image(); im.referrerPolicy = "no-referrer"; im.onload = () => render(); im.src = u; L.imgEl[mint] = im; }
    return L.imgEl[mint];
  }
  const ICON = {
    scanner: ["#0fb5a6", `<path d="M12 3l2.2 3.8 4.3-.9-.9 4.3L21.4 12l-3.8 2.2.9 4.3-4.3-.9L12 21.4l-2.2-3.8-4.3.9.9-4.3L2.6 12l3.8-2.2-.9-4.3 4.3.9z" fill="#fff" stroke="none"/><circle cx="12" cy="12" r="3" fill="#0fb5a6" stroke="none"/>`],
    scanner2: ["#5e5ce6", `<circle cx="11" cy="11" r="6" stroke="#fff" fill="none"/><path d="M20 20l-4.5-4.5" stroke="#fff"/><path d="M8.5 11h5M11 8.5v5" stroke="#fff"/>`],
    scanner3: ["#ff9f0a", `<path d="M12 21c-3.5-1.5-6-4.6-6-8.4C6 8 9.2 5 12 3c2.8 2 6 5 6 9.6 0 3.8-2.5 6.9-6 8.4z" fill="#fff" stroke="none"/><path d="M12 21V11" stroke="#ff9f0a" stroke-width="2"/><path d="M12 15l-3-2.5M12 13l3-2.5" stroke="#ff9f0a" stroke-width="1.6"/>`],
    auditor: ["#3a3a3c", `<ellipse cx="12" cy="6" rx="7" ry="2.5" fill="#fff" stroke="none"/><ellipse cx="12" cy="12" rx="7" ry="2.5" fill="#30d158" stroke="none"/><ellipse cx="12" cy="18" rx="7" ry="2.5" fill="#ff453a" stroke="none"/>`],
    analyst: ["#e5352b", `<path d="M12 4l9 15H3z" fill="#fff" stroke="none"/><circle cx="9.6" cy="14" r="1.2" fill="#e5352b" stroke="none"/><circle cx="14.4" cy="14" r="1.2" fill="#e5352b" stroke="none"/>`],
    executor: ["#7d5cff", `<path d="M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6h-6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4z" fill="#fff" stroke="none"/><circle cx="8.5" cy="12" r="1.3" fill="#7d5cff" stroke="none"/><circle cx="15.5" cy="12" r="1.3" fill="#7d5cff" stroke="none"/>`],
    risk: ["#ff7a1a", `<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" fill="#fff" stroke="none"/><circle cx="9.5" cy="11" r="1.3" fill="#ff7a1a" stroke="none"/><circle cx="14.5" cy="11" r="1.3" fill="#ff7a1a" stroke="none"/>`],
    lock: ["#30d158", `<rect x="5" y="11" width="14" height="10" rx="2" fill="#fff" stroke="none"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="#fff" fill="none" stroke-width="2"/>`]
  };
  const icon = (k, size = 32) => { const [bg, p] = ICON[k] || ICON.scanner; return `<span class="aic" style="width:${size}px;height:${size}px;background:${bg}"><svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round">${p}</svg></span>`; };
  const SUBCOL = { scanner: "#64d2ff", scanner2: "#a5a3ff", scanner3: "#ffb340", auditor: "#ebebf599", analyst: "#ffd60a", executor: "#30d158", risk: "#ff6b9a" };

  function splitVal(a) {
    const parts = String(a.value || "").split(" · ");
    return { main: parts[0], sub: parts.slice(1).join(" · ") };
  }
  function actRow(a) {
    const { main, sub } = splitVal(a);
    const valCls = /^\+/.test(main) ? "green" : /^-/.test(main) ? "red" : (a.kind === "rejected" ? "sec" : "");
    const subtitle = /\d\d:\d\d/.test(a.subtitle || "") ? a.subtitle : `${a.subtitle} · ${a.time}`;
    const badge = { bought: "↗", sold: "↙", stopped: "✕", rejected: "–" }[a.kind] || "·";
    return `<button class="arow" data-open="${a.target}" data-mint="${esc(a.mint)}">
      <span class="avw">${avatar(a.mint, a.title, 40)}<i class="kb ${a.kind}">${badge}</i></span>
      <div class="main"><div class="t">${esc(a.title)}${stratBadge(a.strategy, a.kind)}</div><div class="s">${esc(subtitle.replace(/ · (Scalp|Compounder)\b/, ""))}</div></div>
      <div class="v"><div class="m ${valCls}">${esc(main)}</div><div class="s">${esc(sub)}</div></div></button>`;
  }

  /* compact agent cards (home carousel) */
  function feedRows(c) {
    const rows = (c.feed || []).slice(0, 3);
    if (!rows.length) return `<div class="cs">${esc(c.key === "scanner2" ? (c.enabled === false ? "Off" : "Watching pools over " + short(c.minLiq))
      : c.key === "scanner3" ? (c.enabled === false ? "Off" : `Young coins from ${short(c.minMcap)} mcap · liq ${short(c.minLiq)}+${c.waiting ? " · " + c.waiting + " waiting" : ""}`)
      : "Listening for graduations")}</div>`;
    return rows.map(f => f.verdict === "pass"
      ? `<div class="fr">${avatar(f.mint, f.name, 16)}<span class="fn pass">${esc(f.name)}</span><span class="fx green">passed</span></div>`
      : `<div class="fr">${avatar(f.mint, f.name, 16)}<span class="fn kill">${esc(f.name)}</span><span class="fx">${esc(f.reason || "")}</span></div>`).join("");
  }
  function agentCard(c) {
    const sub = `<div class="asub" style="color:${SUBCOL[c.key]}"><span class="sd ${c.status === "running" ? "" : c.status}"></span>${esc(c.status === "running" ? c.headline : c.status === "paused" ? "Paused" : "Down")}</div>`;
    let body = "";
    if (c.key === "scanner" || c.key === "scanner2" || c.key === "scanner3") body = `<div class="feedc">${feedRows(c)}</div>`;
    else if (c.key === "auditor") {
      const strips = (c.last ? c.last.strips : Array(9).fill(null)).map(s => `<i class="${s === true ? "ok" : s === false ? "bad" : ""}"></i>`).join("");
      body = `<div class="strips">${strips}</div><div class="cb">${esc(c.running ? "taking apart..." : c.last ? c.last.name : "No coin yet")}</div>
        <div class="cs ${c.last && c.last.text && c.last.text !== "cleared" ? "red" : ""}">${esc(c.running ? "" : c.last ? c.last.text : "")}${c.rejectedText ? " · " + esc(c.rejectedText) : ""}</div>`;
    } else if (c.key === "analyst") {
      const l = c.last;
      body = `<div class="anr"><canvas class="ring" data-ring="${l ? l.score : ""}" data-min="${c.minScore}"></canvas>
        <div class="anc">${l ? avatar(l.mint, l.name, 22) : ""}<div class="cb">${esc(l ? l.name : "No coin yet")}</div>
        <div class="cs ${l && l.pass ? "green" : ""}">${l ? (l.pass ? "passed" : esc(l.reason || "rejected")) : "scoring..."}</div></div></div>`;
    } else if (c.key === "executor") {
      const l = c.last;
      body = l ? `<div class="exr">${avatar(l.mint, l.name, 22)}<div><div class="cb">${esc(l.name)}</div><div class="cs">${esc(l.text)}</div></div></div>
        ${l.bar.startsWith("✓") ? `<div class="fillp">✓ Filled</div>` : `<div class="execp"><i style="width:${l.progress}%"></i><span>Executing... ${l.progress}%</span></div>`}`
        : `<div class="cs">${c.stackPct}% of stack per coin · waiting for a signal</div>`;
    } else if (c.key === "risk") {
      const pnl = c.lastExitPnl;
      body = `<div class="cb">${esc(c.lastExit || "No exits yet")}</div>
        ${c.lastExitName ? `<div class="cs ${pnl > 0 ? "green" : pnl < 0 ? "red" : ""}">${esc(c.lastExitName)} ${pnl != null ? esc(signedUsd(pnl)) : ""}</div>` : ""}
        <div class="tags"><span class="tag redt">${esc(c.pills[0])}</span><span class="tag greent">${esc(c.pills[1])}</span></div>`;
    }
    return `<div class="acard" data-agent="${c.key}"><div class="ah">${icon(c.key)}<div><div class="an">${esc(c.name)}</div>${sub}</div></div><div class="abody">${body}</div></div>`;
  }
  function drawRings() { document.querySelectorAll("canvas[data-ring]").forEach(cv => Charts.drawRing(cv, cv.dataset.ring === "" ? null : Number(cv.dataset.ring), Number(cv.dataset.min))); }

  /* ---------- events: drop-down pill for new activity, take-profit card + confetti for a newly closed winner */
  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  function events() {
    const st = S.d["state.json"]; if (!st || S.decryptFail) return;
    const newest = st.activity[0];
    const seenAct = lsGet("pillSeen", null);
    if (seenAct == null) lsSet("pillSeen", newest ? newest.id : 0);
    else if (newest && newest.id > seenAct) { lsSet("pillSeen", newest.id); notify(newest); }
    const closed = st.closed || [];
    let seen = lsGet("seenWins", null);
    if (seen == null) { lsSet("seenWins", closed.map(p => p.id)); return; }   // first visit: nothing to celebrate retroactively
    const fresh = closed.filter(p => !seen.includes(p.id));
    if (!fresh.length) return;
    seen = seen.concat(fresh.map(p => p.id)).slice(-200); lsSet("seenWins", seen);
    const win = fresh.filter(p => p.pnl > 0).sort((a, b) => b.pnl - a.pnl)[0];
    if (win) takeProfit(win);
  }
  function notify(a) {
    const el = $("#npill");
    const { main, sub } = splitVal(a);
    el.innerHTML = `<img class="appic" src="icons/icon-192.png" alt=""><div class="nb"><div class="nt">Grok Bot</div><div class="nx">${esc(a.title)} · ${esc(main)}${sub && /%/.test(sub) ? " (" + esc(sub) + ")" : ""}</div></div>
      <div class="nr"><span class="ter">now</span>${a.mint ? avatar(a.mint, a.title, 26) : ""}</div>`;
    el.dataset.mint = a.mint || ""; el.dataset.open = a.target || "";
    el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
    clearTimeout(notify.t); notify.t = setTimeout(() => el.classList.remove("show"), 4500);
  }
  function takeProfit(p) {
    const el = $("#tp");
    el.innerHTML = `${icon("lock", 44)}<div class="tpm"><div class="tpt">Risk sold ${esc(p.name)}</div><div class="tps">locked the gain · no hands</div></div>
      <div class="tpv num">${esc(signedUsd(p.pnl))}${p.pct != null ? `<div class="tpp">+${esc(p.pct.toFixed(0))}%</div>` : ""}</div>`;
    el.dataset.mint = p.mint;
    el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
    Charts.confetti();
    clearTimeout(takeProfit.t); takeProfit.t = setTimeout(() => el.classList.remove("show"), 7000);
  }

  /* ---------- screens */
  function home() {
    const st = S.d["state.json"], ch = S.d[`chart-${S.range}.json`];
    const v = $("#view");
    if (!v.querySelector("#home")) {
      v.innerHTML = `<div id="home">
        <div class="hnav"><button class="appav" data-tab="account"><img src="icons/icon-192.png" alt=""></button>
          <div class="hmid"><button class="title" data-tab="account">Grok Bot ${chev}</button><div class="ticker" id="ticker"></div></div>
          <button class="icon-btn" id="searchBtn" aria-label="Search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></button>
          <button class="icon-btn" id="bell" aria-label="Activity"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><span class="dot" id="belldot" hidden></span></button></div>
        <div class="search" id="search" hidden><input placeholder="Name, symbol or mint" id="searchIn" autocomplete="off"><div id="searchRes"></div></div>
        <div id="homeBody"></div></div>`;
    }
    const body = $("#homeBody");
    if (!st) { body.innerHTML = sk(70, 6) + sk(24) + sk(210) + sk(180, 20) + sk(200, 20); return; }
    if (!body.querySelector("#bal")) {
      body.innerHTML = `<div class="balance-wrap"><div class="balance-row"><div class="balance num"><span class="odo" id="bal"></span></div><span id="paper"></span></div>
        <div class="today num" id="today"></div></div>
        <div class="chart-box"><canvas id="line"></canvas><div class="chart-empty" id="chartEmpty" hidden>Waiting for the first trade</div></div>
        <div class="ranges" id="ranges">${["LIVE", "1H", "4H", "1D", "1W", "ALL"].map(r => `<button data-range="${r}">${r === "LIVE" ? '<i class="blink"></i>' : ""}${r}</button>`).join("")}</div>
        <div id="compBox"></div>
        <div class="sec-head"><h2>Agents</h2><span class="green" id="running"></span></div><div class="carousel" id="cards"></div><div class="pdots" id="pdots"></div>
        <div class="sec-head"><h2>Activity</h2><button class="link" data-tab="activity">See all</button></div><div id="act"></div>`;
      $("#cards").addEventListener("scroll", pageDots, { passive: true });
    }
    const bal = liveBalance(st);
    odometer($("#bal"), usd(bal));
    $("#paper").innerHTML = paperPill(st.mode);
    const dlt = bal - st.start, dp = st.start ? 100 * dlt / st.start : 0, upc = dlt >= 0;
    $("#today").innerHTML = `<span class="${upc ? "green" : "red"}">${upc ? "▲" : "▼"} ${usd(Math.abs(dlt))} (${Math.abs(dp).toFixed(2)}%)</span>
      <span class="pill mult ${upc ? "" : "down"}">${(st.start ? bal / st.start : 1).toFixed(2)}×</span>`;
    $("#mini").innerHTML = `<div class="mb num">${usd(bal)}</div><div class="mp ${upc ? "green" : "red"}">${dp >= 0 ? "+" : ""}${dp.toFixed(2)}%</div>`;
    ticker(st);
    document.querySelectorAll("#ranges button").forEach(b => b.classList.toggle("on", b.dataset.range === S.range));
    $("#running").textContent = `${st.running} running`;
    compBox(st);
    const sl = $("#cards").scrollLeft;
    $("#cards").innerHTML = st.agents.map(agentCard).join("");
    $("#cards").scrollLeft = sl;
    $("#pdots").innerHTML = st.agents.map(() => "<i></i>").join("");
    pageDots(); drawRings();
    $("#act").innerHTML = st.activity.length ? `<div class="list">${st.activity.map(actRow).join("")}</div>` : `<div class="empty">Nothing yet tonight</div>`;
    const seen = Number(localStorage.getItem("seenAct") || 0), newest = st.activity[0] ? st.activity[0].id : 0;
    $("#belldot").hidden = !(newest > seen);
    const data = ch ? Object.assign({}, ch, { points: ch.points.slice() }) : { points: [], marks: [], start: st.start };
    if (S.range === "LIVE" && data.points.length && bal !== st.balance) data.points.push([new Date().toISOString(), bal]);
    $("#chartEmpty").hidden = data.points.length >= 2;
    Charts.drawLine($("#line"), data, S.range, imgFor);
  }
  /* compounder (Nov 10): its own paper sub-budget, wins roll into its free cash -> compounding curve */
  function compBox(st) {
    const cs = st.strategies && st.strategies.compounder, el = $("#compBox");
    if (!el) return;
    if (!cs || !cs.budget) { el.innerHTML = ""; return; }
    const up = cs.equity >= cs.budget;
    const key = JSON.stringify([cs.equity, cs.free, cs.open, cs.enabled, (cs.curve || []).length]);
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    el.innerHTML = `<div class="cmp"><div class="cmph"><span class="sb comp" style="margin-left:0">Compounder</span><span class="sec">${cs.enabled ? "on" : "off"} · ${cs.open} open · ${cs.trades} trades${cs.halves ? " · " + cs.halves + " halves" : ""}</span></div>
      <div class="cmpr"><div><div class="k">Sub-budget</div><div class="val num">${usd(cs.equity)}</div><div class="s ${up ? "green" : "red"}">${(cs.multiple || 1).toFixed(2)}× of ${usd(cs.budget)}</div></div>
        <div><div class="k">Free cash</div><div class="val num">${usd(cs.free)}</div><div class="s sec">${usd(cs.inTrades)} in trades</div></div>
        <canvas id="cmpc"></canvas></div><div class="s sec cmpn">${esc(cs.rules || "")}</div></div>`;
    spark($("#cmpc"), (cs.curve || []).map(p => p[1]), cs.budget);
  }
  function spark(cv, vals, base) {
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 120, h = cv.clientHeight || 44;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    const v = vals.length >= 2 ? vals : [base, base];
    const lo = Math.min(base, ...v), hi = Math.max(base, ...v), span = (hi - lo) || 1;
    const y = x => h - 4 - (x - lo) / span * (h - 8);
    ctx.strokeStyle = "rgba(235,235,245,.25)"; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, y(base)); ctx.lineTo(w, y(base)); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = v[v.length - 1] >= base ? "#30d158" : "#ff453a"; ctx.lineWidth = 2; ctx.beginPath();
    v.forEach((p, i) => { const xx = i * (w - 2) / (v.length - 1) + 1; i ? ctx.lineTo(xx, y(p)) : ctx.moveTo(xx, y(p)); });
    ctx.stroke();
  }
  function pageDots() {
    const c = $("#cards"); if (!c) return;
    const cards = c.children.length, w = c.firstElementChild ? c.firstElementChild.offsetWidth + 10 : 1;
    const i = Math.min(cards - 1, Math.round(c.scrollLeft / w));
    [...$("#pdots").children].forEach((d, k) => d.classList.toggle("on", k === i));
  }
  function ticker(st) {
    const el = $("#ticker"); if (!el) return;
    const items = (st.activity || []).filter(a => a.kind !== "rejected").slice(0, 3);
    if (!items.length) { el.innerHTML = `<span class="ter">${esc(st.mode)} · ${st.running} agents running</span>`; return; }
    const i = (ticker.i || 0) % items.length, a = items[i];
    const { main, sub } = splitVal(a);
    const cls = /^\+/.test(main) ? "green" : /^-/.test(main) ? "red" : "sec";
    const html = `<span class="tk"><span class="sec">${esc(a.title)}</span> <span class="${cls}">${esc(main)}${sub && /%/.test(sub) ? " (" + esc(sub) + ")" : ""}</span></span>`;
    if (el.dataset.k !== a.id + ":" + main) { el.innerHTML = html; el.dataset.k = a.id + ":" + main; }
  }
  setInterval(() => { ticker.i = (ticker.i || 0) + 1; const st = S.d["state.json"]; if (st && $("#ticker")) ticker(st); }, 4000);
  function searchResults(qs) {
    const st = S.d["state.json"]; if (!st) return "";
    const ql = qs.trim().toLowerCase(); if (!ql) return "";
    const hits = st.coins.filter(c => (c.name || "").toLowerCase().includes(ql) || (c.symbol || "").toLowerCase().includes(ql) || c.mint.toLowerCase() === ql).slice(0, 8);
    return hits.length ? `<div class="list" style="margin:8px 0 0">${hits.map(c => `<button class="lrow" style="width:100%;text-align:left" data-open="coin" data-mint="${esc(c.mint)}">
      <div class="main"><div class="t">${esc(c.name || c.mint)}</div><div class="s">${esc(c.symbol || "")} · ${esc(c.mint.slice(0, 4) + "..." + c.mint.slice(-4))}</div></div>${chev}</button>`).join("")}</div>`
      : `<div class="empty">No coin tonight matches. Paste the full mint.</div>`;
  }

  function agents() {
    const st = S.d["state.json"];
    const order = ["scanner", "scanner2", "scanner3", "auditor", "analyst", "executor", "risk"].filter(k => !st || st.agents.some(a => a.key === k));
    let h = `<h1 class="large">Agents ${paperPill(st && st.mode)}</h1>`;
    if (!st) { $("#view").innerHTML = h + order.map(() => sk(220, 0, 16) + "<div style='height:14px'></div>").join(""); return; }
    h += order.map(k => {
      const c = st.agents.find(a => a.key === k), d = S.d[`agents/${k}.json`];
      const on = c.status !== "paused";
      const locked = k === "risk" && d && d.locked;
      const rows = d ? d.decisions.map(x => {
        const cls = /pass|bought|trail|guarding/.test(x.verdict) ? "ok" : /kill|red|reject|stop|pulled|skipped|missed/.test(x.verdict) ? "bad" : "";
        return `<div class="tm">${esc(x.time)}</div><div class="cn"><a href="${esc(x.coin_url)}" target="_blank" rel="noopener">${esc(x.name)}</a> <span class="ter">${esc(x.verdict)}</span></div><div class="rs ${cls}">${esc(x.reason || "")}</div>`;
      }).join("") : "";
      return `<div class="fcard"><div class="top">${icon(k, 36)}<div class="nm">${esc(c.name)}<div class="asub" style="color:${SUBCOL[k]}"><span class="sd ${c.status === "running" ? "" : c.status}"></span>${esc(c.headline)}</div></div>
        <button class="switch-wrap" data-switch="${k}" data-locked="${locked ? 1 : 0}"><span class="switch ${on ? "on" : ""} ${locked ? "locked" : ""}"></span></button></div>
        <div class="cnt">${c.status} · ${d ? d.today : "–"} today${locked ? " · locked while a position is open" : ""}</div>
        <div class="dec">${rows || `<div></div><div class="ter">No decisions yet</div><div></div>`}</div>
        <button class="shortcut" data-tab="account" data-section="${k}"><span>Settings</span>${chev}</button></div>`;
    }).join("");
    $("#view").innerHTML = h + `<div class="note">Pause and resume go through Telegram: "pause scanner", "resume scanner".</div>`;
  }

  async function activity() {
    const p0 = S.d["activity-0.json"];
    const st0 = S.d["state.json"]; let h = `<h1 class="large">Activity ${paperPill(st0 && st0.mode)}</h1>`;
    if (!p0) { $("#view").innerHTML = h + sk(60, 0) + sk(60, 1) + sk(60, 1) + sk(60, 1); return; }
    const rows = (S.actRows && S.actRows.length > p0.rows.length) ? S.actRows : p0.rows;
    S.actNext = S.actNext !== undefined && S.actRows && S.actRows.length > p0.rows.length ? S.actNext : p0.next;
    S.actRows = rows;
    h += rows.length ? `<div class="list">${rows.map(actRow).join("")}</div>` : `<div class="empty">Nothing yet tonight</div>`;
    if (S.actNext) h += `<button class="cta" style="background:var(--card);color:#fff" id="more">Load more</button>`;
    $("#view").innerHTML = h;
    localStorage.setItem("seenAct", rows[0] ? rows[0].id : 0);
  }

  const backLabel = () => ({ home: "Home", agents: "Agents", activity: "Activity", account: "Account" }[(S.stack && S.stack.length && S.stack[S.stack.length - 1].name) || "home"] || "Back");
  function audit() {
    const a = S.d[S.view.mint ? `audit/${S.view.mint}.json` : "audit/latest.json"];
    let h = `<div class="nav">${backBtn(backLabel())}<div class="grow"></div></div>`;
    const key = "audit:" + (S.view.mint || "latest") + ":" + (a ? a.ts : "") + ":" + (a ? a.status : "") + ":" + (a && L.img[a.mint] ? 1 : 0);
    if ($("#view").dataset.k === key) return;   // nothing new: keep the beam animation
    $("#view").dataset.k = key;
    if (!a) {
      const nf = S.notFound && S.notFound.length;
      $("#view").innerHTML = h + (nf ? `<div class="empty">No coin taken apart yet</div>` : `<div class="sk" style="width:220px;height:290px;margin:10px auto;border-radius:50%"></div>` + sk(300, 20)); return;
    }
    if (a.status === "none") { $("#view").innerHTML = h + `<div class="empty" style="padding-top:80px">No coin taken apart yet</div>`; return; }
    h += `<div class="coinhead"><div class="crow">${avatar(a.mint, a.name, 44)}<div><div class="nm">${esc(a.name)}</div><div class="sub">${esc(a.symbol || "")} · Solana · Auditor</div></div></div></div>
      <div class="discs" id="discs">${a.layers.map((l, i) => `<div class="disc" data-i="${i}" style="top:${i * 28}px;z-index:${9 - i}"><span class="mk"></span></div>`).join("")}<div class="beam" id="beam"></div></div>
      <div class="verdict"><div class="v1 ${a.status === "rejected" ? "red" : a.status === "cleared" ? "green" : ""}">${esc(a.line1)}</div>${a.line2 ? `<div class="v2">${esc(a.line2)}</div>` : ""}</div>
      <div class="list" style="margin-top:12px">${a.layers.map(l => `<div class="lrow" style="min-height:52px"><span class="lnum ${l.pass === true ? "ok" : l.pass === false ? "bad" : ""}">${l.n}</span>
        <div class="main"><div class="t" style="font-size:15px">${esc(l.name)}</div></div>
        <div class="lv ${l.pass == null ? "nc" : l.pass ? "" : "bad"}">${esc(l.value)}</div></div>`).join("")}</div>
      <div class="list" style="margin-top:16px"><button class="lrow" style="width:100%;text-align:left" data-ro="auditor"><div class="main"><div class="t">Take apart before buying</div>
        <div class="s">Change it in Telegram: "set auditor enabled off" (asks twice)</div></div><span class="switch ${a.enabled ? "on" : ""} locked"></span></button></div>
      <a class="cta" href="${esc(a.coin_url)}" target="_blank" rel="noopener">Open on FOMO</a>`;
    $("#view").innerHTML = h;
    beam(a);
  }
  /* cyan beam: 350ms per layer top to bottom, then 150ms to green/red; waits on a layer the server hasn't sent */
  function beam(a) {
    const key = a.mint + a.ts, discs = [...document.querySelectorAll(".disc")], b = $("#beam");
    const paint = (i) => { const l = a.layers[i]; if (l.pass === true) { discs[i].classList.add("ok"); discs[i].querySelector(".mk").textContent = "✓"; }
      else if (l.pass === false) { discs[i].classList.add("bad"); discs[i].querySelector(".mk").textContent = "✕"; } };
    const known = a.layers.findIndex(l => l.pass === null && l.value !== "not checked" && l.value !== "not in this run");
    const upto = known === -1 ? a.layers.length : known;
    if (REDUCED || S.animated[key]) { for (let i = 0; i < upto; i++) paint(i); if (known !== -1) { b.style.opacity = 1; b.style.top = (known * 28 + 21) + "px"; } return; }
    S.animated[key] = true;
    let i = 0;
    b.style.top = "21px"; b.style.opacity = 1;
    const next = () => {
      if (i >= upto) { b.style.opacity = known === -1 ? 0 : 1; return; }
      b.style.top = (i * 28 + 21) + "px";
      setTimeout(() => { paint(i); i++; setTimeout(next, 150); }, 350);
    };
    next();
  }

  function mergedCandles(mint, base) {
    const out = (base || []).map(c => Object.assign({}, c));
    (L.hist[mint] || []).forEach(c => {
      const last = out[out.length - 1];
      if (last && last.t === c.t) { last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.v += c.v; }
      else if (!last || c.t > last.t) out.push(Object.assign({}, c, { o: last ? last.c : c.o }));
    });
    return out.slice(-60);
  }
  function coin() {
    const m = S.view.mint, c = S.d[`coin/${m}.json`];
    const v = $("#view");
    if (!c) {
      const nf = S.notFound && S.notFound.includes(`coin/${m}.json`);
      v.innerHTML = `<div class="nav">${backBtn(backLabel())}<div class="grow"></div></div>` + (nf ? `<div class="empty">This coin isn't on the desk tonight.</div>` : sk(40, 0) + sk(70) + sk(260) + sk(140)); return;
    }
    const p = c.position;
    if (!v.querySelector(`#coin[data-mint="${m}"]`) || v.querySelector("#coin").dataset.pos !== String(!!p)) {
      v.innerHTML = `<div id="coin" data-mint="${esc(m)}" data-pos="${!!p}"><div class="nav">${backBtn(backLabel())}<div class="grow"></div>
          <button class="shield" id="shield" data-open="audit" data-mint="${esc(m)}"></button></div>
        <div class="coinhead"><div class="crow" id="chead"></div>
          <div class="price num"><span class="odo" id="cprice"></span></div><div class="since" id="since"></div></div>
        <div class="candles"><canvas id="cnd"></canvas></div>
        <div class="stats" id="stats"></div><div id="cards2"></div>
        <a class="cta ${p ? "sell" : ""}" href="${esc(c.coin_url)}" target="_blank" rel="noopener">${esc(c.button)}</a></div>`;
    }
    $("#chead").innerHTML = `${avatar(m, c.name, 44)}<div><div class="nm">${esc(c.name)} ${paperPill(c.mode)}</div><div class="sub">${esc(c.symbol || "")} · ${esc(c.chain)}${c.age ? " · " + esc(c.age) : ""}</div></div>`;
    $("#shield").className = "shield " + (c.shieldOk ? "" : "bad"); $("#shield").textContent = "⛨ " + c.shield;
    const price = livePx(m, c.price);
    const priceTxt = px(price);
    $("#cprice").parentElement.classList.toggle("small", priceTxt.length > 9);
    odometer($("#cprice"), priceTxt);
    if (p && price) { const sp = 100 * (price / p.entry - 1); $("#since").className = "since " + (sp >= 0 ? "green" : "red"); $("#since").textContent = `${sp >= 0 ? "▲" : "▼"} ${Math.abs(sp).toFixed(1)}% since entry`; }
    else if (c.lastTrade) { const lt = c.lastTrade; $("#since").className = "since " + (lt.pnl >= 0 ? "green" : "red"); $("#since").textContent = `Last trade ${lt.reason || "closed"} · ${signedUsd(lt.pnl)}`; }
    else $("#since").textContent = "";
    const lv = L.px[m] && Date.now() - L.px[m].ts < 120e3 ? L.px[m] : null;
    $("#stats").innerHTML = `<div><div class="k">Market cap</div><div class="val num">${short(lv && lv.mc != null ? lv.mc : c.marketCap)}</div></div>
      <div><div class="k">Liquidity</div><div class="val num">${short(lv && lv.liq != null ? lv.liq : c.liquidity)}</div></div>
      <div><div class="k">Holders</div><div class="val num">${c.holders == null ? "n/a" : c.holders.toLocaleString("en-US")}</div></div>
      <div><div class="k">24h volume</div><div class="val num">${short(lv && lv.vol24 != null ? lv.vol24 : c.volume24h)}</div></div>`
      + (c.hype ? `<div class="hyp"><div class="k">Hype</div><div class="val num ${hypeCls(c.hype.value)}">${c.hype.value.toFixed(2)}</div>
        <div class="s sec">${esc(c.hype.text || "")}${c.hype.minCompounder != null ? ` · Compounder needs ${c.hype.minCompounder}` : ""}</div></div>`
        : `<div class="hyp"><div class="k">Hype</div><div class="val num sec">n/a</div><div class="s sec">checked when the Analyst scores the coin</div></div>`)
      + (c.venue === "curve" ? `<div class="hyp"><div class="k">Venue</div><div class="val">pump.fun curve</div><div class="s sec">not graduated yet · Young coins</div></div>` : "");
    let exitLine = null, exitLabel = "";
    if (p) {
      exitLine = exitLineOf(p, m); exitLabel = p.trailActive ? "Risk trailing stop" : "Risk stop";
      const val = price ? p.size * price / p.entry : null, pnl = val != null ? val - p.size : null;
      const left = p.timeoutLeftS - Math.max(0, (Date.now() - Date.parse(c.updated_at)) / 1000), lh = Math.max(0, Math.floor(left / 3600)), lm = Math.max(0, Math.floor(left % 3600 / 60));
      $("#cards2").innerHTML = `<div class="pcard">${icon("executor", 40)}<div class="pm"><div class="pt">Your position${stratBadge(p.strategy || "normal")}</div><div class="ps">${usd(p.size)} in · Executor</div></div>
          <div class="pv"><div class="pbig num">${usd(val)}</div><div class="num ${pnl >= 0 ? "green" : "red"}">${signedUsd(pnl)}</div></div></div>
        <div class="pcard">${icon("risk", 40)}<div class="pm"><div class="pt">Risk · ${p.trailActive ? "trailing stop" : "stop"}</div>
          <div class="ps">${p.strategy === "compounder" ? (p.halfDone ? `half sold · rest exits if it drops ${p.trailPct}% from top` : `exit at -${esc(p.stopPct)}% · sells half at ${px(p.half)} (2x)`)
            : p.trailActive ? `exit if it drops ${p.trailPct}% from top` : `exit at -${esc(p.stopPct)}% · trails ${p.trailPct}% from ${px(p.trailStart)}`}${p.tp ? ` · take profit ${px(p.tp)}` : ""}</div>
          <div class="ps ter">${p.strategy === "compounder" ? (p.timeoutLeftS > 9e6 ? "no time stop" : `time stop in ${lh ? lh + "h " : ""}${lm}m`) : `${p.strategy === "scalp" ? "time stop" : "timeout"} in ${lh ? lh + "h " : ""}${lm}m`}</div></div><div class="pv"><div class="mono orange">${axis(exitLine)}</div></div></div>`;
    } else if (c.lastTrade) {
      const lt = c.lastTrade;
      $("#cards2").innerHTML = `<div class="pcard">${icon("risk", 40)}<div class="pm"><div class="pt">Last trade${stratBadge(lt.strategy || "normal")}</div><div class="ps">${esc(lt.reason || "closed")} · in ${px(lt.entry)} · out ${px(lt.exit)}</div></div>
        <div class="pv"><div class="pbig num ${lt.pnl >= 0 ? "green" : "red"}">${signedUsd(lt.pnl)}</div></div></div>`;
    } else $("#cards2").innerHTML = "";
    Charts.drawCandles($("#cnd"), mergedCandles(m, c.candles), { entry: p ? p.entry : null, entryTs: p ? p.openedAt : null, exitLine, exitLabel, price, fmt: axis });
  }

  function account() {
    const a = S.d["account.json"], s = S.d["settings.json"];
    let h = `<h1 class="large">Account ${paperPill(a && a.mode)}</h1>`;
    if (!a || !s) { $("#view").innerHTML = h + sk(100, 0) + sk(150, 20) + sk(400, 20); return; }
    h += `<div class="list"><div class="lrow"><div class="main"><div class="t">Mode</div><div class="s">LIVE needs typing LIVE in Telegram</div></div>
        <div class="seg" style="width:150px"><span class="${a.mode === "PAPER" ? "on paperon" : ""}">PAPER</span><span class="${a.mode === "LIVE" ? "on" : ""}">LIVE</span></div></div>
      <div class="lrow"><div class="main"><div class="t">Stack</div><div class="s">${a.mode === "PAPER" ? "Simulated, started at " + usd(a.paperStart) : "Set with \"stack 1240\" in Telegram"}</div></div><div class="v num">${usd(a.stack)}</div></div></div>
      <div class="group-title">FOMO</div><div class="list">
      <a class="lrow" href="${esc(a.profile_url)}" target="_blank" rel="noopener"><div class="main"><div class="t">Your FOMO profile</div><div class="s">@${esc(a.fomoHandle)}</div></div>${chev}</a>
      <button class="lrow" style="width:100%;text-align:left" id="invite" data-url="${esc(a.signup_url)}"><div class="main"><div class="t">Invite a friend</div></div>${chev}</button></div>
      <div class="group-title">Notifications</div><div class="list">
      <div class="lrow"><div class="main"><div class="t">Telegram</div><div class="s">${esc(a.telegram.bot)}</div></div><div class="v ${a.telegram.connected ? "green" : "red"}">${a.telegram.connected ? "Connected" : "Not connected"}</div></div>
      <a class="lrow" href="https://t.me/${esc(a.telegram.bot.replace("@", ""))}" target="_blank" rel="noopener"><div class="main"><div class="t">Send test push</div><div class="s">Send "test" to the bot</div></div>${chev}</a>
      <div class="lrow"><div class="main"><div class="t">Web push</div><div class="s">${esc(a.webpush.note)}</div></div></div></div>
      ${a.integrations ? `<div class="group-title">Data sources</div><div class="list">` + a.integrations.map(x =>
        `<div class="lrow"><div class="main"><div class="t">${esc(x.name)}</div><div class="s">${esc(x.detail)}</div></div><div class="v ${x.ok ? "green" : ""}">${esc(x.status)}</div></div>`).join("") +
        `<div class="lrow"><div class="main"><div class="t">Live prices in this app</div><div class="s">DexScreener, polled by your browser every ${LIVE_S}s for the coins on the desk</div></div><div class="v ${L.ok ? "green" : ""}">${L.ok == null ? "starting" : L.ok ? "on" : "fallback"}</div></div></div>` : ""}
      <div class="note">${esc(a.readOnlyNote)}</div>`;
    const label = { scanner: "Scanner", scanner2: "Big coins", scanner3: "Young coins", compounder: "Compounder", hype: "Hype check", scalp: "Scalp", strategy: "Strategies", auditor: "Auditor", analyst: "Analyst", executor: "Executor", risk: "Risk", desk: "Desk", paper: "Paper fills" };
    s.groups.forEach(g => {
      h += `<div class="group-title" id="set-${g.agent}">${label[g.agent] || esc(g.agent)}</div><div class="list">` + g.items.map(it => {
        let ctl;
        if (it.choices) ctl = `<div class="seg" style="min-height:36px">${it.choices.map(c => `<span class="${String(c) === String(it.value) ? "on" : ""}">${esc(String(c))}</span>`).join("")}</div>`;
        else if (it.min !== undefined) ctl = `<input type="number" value="${esc(it.value)}" disabled>`;
        else ctl = `<input type="text" value="${esc(it.value)}" disabled>`;
        const slider = it.min !== undefined ? `<input type="range" min="${it.min}" max="${it.max}" step="any" value="${esc(it.value)}" disabled><div class="rng"><span>${it.min}</span><span>${it.max}</span></div>` : "";
        return `<div class="setrow"><div class="top"><span>${esc(it.name.replace(/_/g, " "))}</span>${it.choices ? "" : ctl}</div>${it.choices ? `<div style="margin-top:8px">${ctl}</div>` : ""}${slider}</div>`;
      }).join("") + `</div>`;
    });
    const y = window.scrollY;
    $("#view").innerHTML = h + `<div style="height:20px"></div>`;
    if (S.view.section) { const el = $("#set-" + S.view.section); if (el) el.scrollIntoView(); S.view.section = null; } else window.scrollTo(0, y);
  }

  /* ---------- router */
  function render() {
    offlineRow();
    const n = S.view.name;
    document.body.dataset.view = n;
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === n || (n === "coin" || n === "audit") && t.dataset.tab === S.tabBefore));
    if (!S.dp) { $("#view").innerHTML = `<div class="empty" style="padding-top:120px">Open the private link from Telegram in Safari, then Share → Add to Home Screen.</div>`; return; }
    ({ home, agents, activity, audit, coin, account }[n] || home)();
    miniHeader();
  }
  function transition(kind) {
    const v = $("#view"); if (REDUCED) return;
    v.classList.remove("push", "pop"); void v.offsetWidth; v.classList.add(kind);
  }
  function go(view) {
    if (["home", "agents", "activity", "account"].includes(view.name)) S.tabBefore = view.name;
    const tab = ["home", "agents", "activity", "account"].includes(view.name);
    if (tab) S.stack = [];
    else if (view.name !== S.view.name || view.mint !== S.view.mint) { S.stack = S.stack || []; S.stack.push(S.view); }
    S.view = view; $("#view").innerHTML = ""; delete $("#view").dataset.k; window.scrollTo(0, 0);
    render(); if (!tab) transition("push");
    poll(); if (view.name === "coin") live();
  }
  function miniHeader() { const m = $("#mini"); if (m) m.classList.toggle("show", S.view.name === "home" && window.scrollY > 150); }
  window.addEventListener("scroll", miniHeader, { passive: true });
  document.addEventListener("click", async e => {
    const t = e.target.closest("[data-tab],[data-open],[data-range],[data-back],[data-switch],[data-ro],#invite,#more,#searchBtn,#bell,.acard,#npill,#tp");
    if (!t) return;
    if (t.id === "npill") { t.classList.remove("show"); if (t.dataset.mint && t.dataset.open) go({ name: t.dataset.open, mint: t.dataset.mint }); return; }
    if (t.id === "tp") { t.classList.remove("show"); if (t.dataset.mint) go({ name: "coin", mint: t.dataset.mint }); return; }
    if (t.id === "searchBtn") { const s = $("#search"); s.hidden = !s.hidden; if (!s.hidden) $("#searchIn").focus(); return; }
    if (t.id === "bell") { go({ name: "activity" }); return; }
    if (t.id === "invite") {
      const url = t.dataset.url;
      if (navigator.share) { try { await navigator.share({ url }); } catch (err) { /* cancelled */ } }
      else { try { await navigator.clipboard.writeText(url); } catch (err) { /* ignore */ } toast("Link copied"); }
      return;
    }
    if (t.id === "more" && S.actNext) {
      try { const pg = await get(S.actNext); S.actRows = S.actRows.concat(pg.rows); S.actNext = pg.next; activity(); } catch (err) { toast("Couldn't load more"); }
      return;
    }
    if (t.dataset.switch) { toast(t.dataset.locked === "1" ? "Risk is locked while a position is open" : `Use Telegram: "pause ${t.dataset.switch}" / "resume ${t.dataset.switch}"`); return; }
    if (t.dataset.ro) { toast("Change it in Telegram (asks twice)"); return; }
    if (t.dataset.back !== undefined) { const prev = (S.stack || []).pop() || { name: S.tabBefore || "home" }; S.view = prev; $("#view").innerHTML = ""; delete $("#view").dataset.k; render(); transition("pop"); poll(); return; }
    if (t.dataset.range) { S.range = t.dataset.range; render(); poll(); return; }
    if (t.dataset.open) { if (t.dataset.mint) go({ name: t.dataset.open, mint: t.dataset.mint }); return; }
    if (t.classList.contains("acard")) { if (t.dataset.agent === "auditor") go({ name: "audit" }); else go({ name: "agents" }); return; }
    if (t.dataset.tab) { go({ name: t.dataset.tab, section: t.dataset.section }); return; }
  });
  document.addEventListener("input", e => { if (e.target.id === "searchIn") $("#searchRes").innerHTML = searchResults(e.target.value); });
  let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(render, 150); });
  render(); poll(); setInterval(poll, POLL_S * 1000);
})();
