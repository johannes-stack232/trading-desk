/* Grok Bot Desk · plan B client. Reads DATA_PATH and the AES key from #d=…&k=… on every load (kept in the URL), localStorage as fallback,
   polls the encrypted data files and decrypts them with WebCrypto AES-GCM. Every FOMO link comes from the JSON (written by links.py). */
(function () {
  "use strict";
  const POLL_S = 15, STALE_MIN = 15;
  const REDUCED = Charts.REDUCED;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = { dp: null, dk: null, decryptFail: false, view: { name: "home" }, range: "LIVE", d: {}, offline: false, lastOk: null, retryAt: 0, failures: 0, prevChart: null, animated: {} };

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

  /* ---------- formatting */
  const usd = (v, d = 2) => v == null ? "–" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const short = v => { if (v == null) return "n/a"; const a = Math.abs(v); return a >= 1e9 ? "$" + (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? "$" + (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? "$" + (a / 1e3).toFixed(1) + "K" : "$" + a.toFixed(0); };
  const px = v => { if (v == null) return "–"; if (v >= 1) return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 4 }); return "$" + Number(v.toPrecision(4)).toString(); };
  const pct = v => v == null ? "–" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  const hm = iso => { if (!iso) return "–"; const d = new Date(iso); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  const ago = iso => { if (!iso) return "never"; return hm(iso); };

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
    if (v.name === "agents") ["scanner", "auditor", "analyst", "executor", "risk"].forEach(a => list.push(`agents/${a}.json`));
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

  /* ---------- odometer: changed digits roll 600ms ease-out, 30ms stagger right to left */
  function odometer(el, text) {
    const chars = [...text];
    if (el.dataset.len != chars.length || REDUCED) {
      const dot = text.indexOf(".");
      el.innerHTML = chars.map((c, i) => { const cc = dot >= 0 && i >= dot ? " c" : "";
        return /\d/.test(c)
        ? `<span class="d${cc}"><span class="col">${[...Array(10).keys()].map(n => `<span>${n}</span>`).join("")}</span></span>`
        : `<span class="${cc.trim()}">${esc(c)}</span>`; }).join("");
      el.dataset.len = chars.length; el.dataset.v = text;
      [...el.querySelectorAll(".col")].forEach((c, i) => { const dch = chars.filter(x => /\d/.test(x))[i]; c.style.transform = `translateY(-${dch * 1.05}em)`; });
      return;
    }
    const old = [...(el.dataset.v || "")];
    const nodes = [...el.children];
    let stagger = 0;
    for (let i = chars.length - 1; i >= 0; i--) {
      const col = nodes[i] && nodes[i].querySelector(".col");
      if (col && chars[i] !== old[i]) {
        col.style.transitionDelay = (stagger * 30) + "ms"; stagger++;
        col.style.transform = `translateY(-${Number(chars[i]) * 1.05}em)`;
      } else if (!col && nodes[i]) nodes[i].textContent = chars[i];
    }
    el.dataset.v = text;
  }

  /* ---------- shared pieces */
  const paperPill = mode => mode === "PAPER" ? `<span class="pill paper">PAPER</span>` : "";
  const chev = `<svg class="chev" viewBox="0 0 8 14"><path d="M1 1l6 6-6 6"/></svg>`;
  const backBtn = `<button class="back" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Back</button>`;
  const sk = (h, mt = 12, mx = 16) => `<div class="sk" style="height:${h}px;margin:${mt}px ${mx}px 0"></div>`;
  function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 1800); }
  function actRow(a) {
    const letter = { bought: "B", sold: "S", stopped: "!", rejected: "×" }[a.kind] || "·";
    const valCls = /^\+/.test(a.value) ? "green" : /^-/.test(a.value) ? "red" : (a.kind === "rejected" ? "sec" : "");
    return `<button class="lrow" style="width:100%;text-align:left" data-open="${a.target}" data-mint="${esc(a.mint)}">
      <div class="badge ${a.kind}">${letter}</div>
      <div class="main"><div class="t">${esc(a.title)}</div><div class="s">${esc(a.subtitle)}</div></div>
      <div class="v ${valCls}">${esc(a.value)}<div class="s ter" style="font-size:12px">${esc(a.time)}</div></div></button>`;
  }
  function agentCard(c, st) {
    const dot = `<span class="sdot ${c.status === "running" ? "" : c.status}"></span>`;
    let body = "";
    if (c.key === "scanner") {
      body = c.count === 0 && !(c.feed || []).length ? `<div class="sec">Listening for graduations</div>` :
        `<div class="feed">${(c.feed || []).slice(0, 5).map(f => f.verdict === "pass"
          ? `<div class="row pass"><span class="l">${esc(f.text)}</span></div>`
          : `<div class="row kill"><span class="l">${esc(f.name)}</span><span class="r">${esc(f.reason || "")}</span></div>`).join("")}</div>`;
    } else if (c.key === "auditor") {
      const strips = (c.last ? c.last.strips : Array(8).fill(null)).map(s => `<i class="${s === true ? "ok" : s === false ? "bad" : ""}"></i>`).join("");
      const line = c.running ? "taking apart..." : c.last ? c.last.text : "No coin taken apart yet";
      body = `<div class="strips">${strips}</div><div style="font-weight:600">${esc(line)}</div><div class="sec">${esc(c.rejectedText)}</div>`;
    } else if (c.key === "analyst") {
      body = `<canvas class="ring" data-ring="${c.last ? c.last.score : ""}" data-min="${c.minScore}"></canvas>
        <div class="sec" style="text-align:center">${c.last ? esc(c.last.name) + (c.last.pass ? " · passed" : " · " + esc(c.last.reason || "rejected")) : "No coin scored yet"}${c.mode === "rules" ? " · rules" : ""}</div>`;
    } else if (c.key === "executor") {
      const l = c.last;
      body = l ? `<div style="font-weight:600">${esc(l.text)}</div><div class="bar"><i style="width:${l.progress}%"></i></div>
        <div class="${l.bar.startsWith("✓") ? "green" : "sec"}">${esc(l.bar === "✓ Filled" ? "✓ Filled" : "Executing... " + l.progress + "%")}</div>`
        : `<div class="sec">${c.stackPct}% of stack per coin · waiting for a signal</div>`;
    } else if (c.key === "risk") {
      body = `<div style="font-weight:600">${esc(c.lastExit || (c.count ? "" : "No exits yet"))}</div>
        <div style="display:flex;gap:8px"><span class="pill mono redp">${esc(c.pills[0])}</span><span class="pill mono greenp">${esc(c.pills[1])}</span></div>`;
    }
    return `<div class="acard" data-agent="${c.key}"><div class="an" style="color:${c.color}">${dot}${esc(c.name)}</div>
      <div class="head num">${esc(c.headline)}</div><div class="body">${body}</div></div>`;
  }
  function drawRings() { document.querySelectorAll("canvas[data-ring]").forEach(cv => Charts.drawRing(cv, cv.dataset.ring === "" ? null : Number(cv.dataset.ring), Number(cv.dataset.min))); }

  /* ---------- screens */
  function home() {
    const st = S.d["state.json"], ch = S.d[`chart-${S.range}.json`];
    const v = $("#view");
    if (!v.querySelector("#home")) {
      v.innerHTML = `<div id="home">
        <div class="nav"><button class="icon-btn" data-tab="account"><span class="avatar">J</span></button>
          <div class="title">Grok Bot ›</div><div class="grow"></div>
          <button class="icon-btn" id="searchBtn"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></button>
          <button class="icon-btn" id="bell"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><span class="dot" id="belldot" hidden></span></button></div>
        <div class="search" id="search" hidden><input placeholder="Name, symbol or mint" id="searchIn" autocomplete="off"><div id="searchRes"></div></div>
        <div id="homeBody"></div></div>`;
    }
    const body = $("#homeBody");
    if (!st) { body.innerHTML = sk(70, 6) + sk(24) + sk(230) + sk(300, 20); return; }
    if (!body.querySelector("#bal")) {
      body.innerHTML = `<div class="balance-wrap"><div class="balance-row"><div class="balance num"><span class="odo" id="bal"></span></div><span id="paper"></span></div>
        <div class="today num" id="today"></div></div>
        <div class="chart-box"><canvas id="line"></canvas><div class="chart-empty" id="chartEmpty" hidden>Waiting for the first trade</div></div>
        <div class="ranges" id="ranges">${["LIVE", "1H", "4H", "1D", "1W", "ALL"].map(r => `<button data-range="${r}">${r}</button>`).join("")}</div>
        <div class="sec-head"><h2 id="agentsHead">Agents</h2></div><div class="carousel" id="cards"></div>
        <div class="sec-head"><h2>Activity</h2><button class="link" data-tab="activity">See all</button></div><div id="act"></div>`;
    }
    odometer($("#bal"), usd(st.balance));
    $("#paper").innerHTML = paperPill(st.mode);
    $("#today").innerHTML = `<span class="${st.todayPct >= 0 ? "green" : "red"}">${pct(st.todayPct)}</span><span class="sec">today</span>
      <span class="pill mult">${(st.multiplier || 1).toFixed(2)}×</span>`;
    document.querySelectorAll("#ranges button").forEach(b => b.classList.toggle("on", b.dataset.range === S.range));
    $("#agentsHead").textContent = `Agents · ${st.running} running`;
    const sl = $("#cards").scrollLeft;
    $("#cards").innerHTML = st.agents.map(c => agentCard(c, st)).join("");
    $("#cards").scrollLeft = sl;
    drawRings();
    $("#act").innerHTML = st.activity.length ? `<div class="list">${st.activity.map(actRow).join("")}</div>` : `<div class="empty">Nothing yet tonight</div>`;
    const seen = Number(localStorage.getItem("seenAct") || 0), newest = st.activity[0] ? st.activity[0].id : 0;
    $("#belldot").hidden = !(newest > seen);
    const data = ch || { points: [], marks: [], start: st.start };
    $("#chartEmpty").hidden = (data.marks || []).length > 0;
    Charts.drawLine($("#line"), data, S.prevChart);
    S.prevChart = data;
  }
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
    const order = ["scanner", "auditor", "analyst", "executor", "risk"];
    let h = `<h1 class="large">Agents</h1>`;
    if (!st) { $("#view").innerHTML = h + order.map(() => sk(220, 0, 16) + "<div style='height:14px'></div>").join(""); return; }
    h += order.map(k => {
      const c = st.agents.find(a => a.key === k), d = S.d[`agents/${k}.json`];
      const on = c.status !== "paused";
      const locked = k === "risk" && d && d.locked;
      const rows = d ? d.decisions.map(x => {
        const cls = /pass|bought|trail|guarding/.test(x.verdict) ? "ok" : /kill|red|reject|stop|pulled|skipped|missed/.test(x.verdict) ? "bad" : "";
        return `<div class="tm">${esc(x.time)}</div><div class="cn"><a href="${esc(x.coin_url)}" target="_blank" rel="noopener">${esc(x.name)}</a> <span class="ter">${esc(x.verdict)}</span></div><div class="rs ${cls}">${esc(x.reason || "")}</div>`;
      }).join("") : "";
      return `<div class="fcard"><div class="top"><span class="sdot ${c.status === "running" ? "" : c.status}"></span><div class="nm" style="color:${c.color}">${esc(c.name)}</div>
        <button class="switch-wrap" data-switch="${k}" data-locked="${locked ? 1 : 0}"><span class="switch ${on ? "on" : ""} ${locked ? "locked" : ""}"></span></button></div>
        <div class="cnt">${c.status} · ${d ? d.today : "–"} today${locked ? " · locked while a position is open" : ""}</div>
        <div class="dec">${rows || `<div></div><div class="ter">No decisions yet</div><div></div>`}</div>
        <button class="shortcut" data-tab="account" data-section="${k}"><span>Settings</span>${chev}</button></div>`;
    }).join("");
    $("#view").innerHTML = h + `<div class="note">Pause and resume go through Telegram: "pause scanner", "resume scanner".</div>`;
  }

  async function activity() {
    const p0 = S.d["activity-0.json"];
    let h = `<h1 class="large">Activity</h1>`;
    if (!p0) { $("#view").innerHTML = h + sk(60, 0) + sk(60, 1) + sk(60, 1) + sk(60, 1); return; }
    const rows = (S.actRows && S.actRows.length > p0.rows.length) ? S.actRows : p0.rows;
    S.actNext = S.actNext !== undefined && S.actRows && S.actRows.length > p0.rows.length ? S.actNext : p0.next;
    S.actRows = rows;
    h += rows.length ? `<div class="list">${rows.map(actRow).join("")}</div>` : `<div class="empty">Nothing yet tonight</div>`;
    if (S.actNext) h += `<button class="cta" style="background:var(--card);color:#fff" id="more">Load more</button>`;
    $("#view").innerHTML = h;
    localStorage.setItem("seenAct", rows[0] ? rows[0].id : 0);
  }

  function audit() {
    const a = S.d[S.view.mint ? `audit/${S.view.mint}.json` : "audit/latest.json"];
    let h = `<div class="nav">${backBtn}<div class="grow"></div></div>`;
    if (!a) {
      const nf = S.notFound && S.notFound.length;
      $("#view").innerHTML = h + (nf ? `<div class="empty">No coin taken apart yet</div>` : `<div class="sk" style="width:220px;height:290px;margin:10px auto;border-radius:50%"></div>` + sk(300, 20)); return;
    }
    if (a.status === "none") { $("#view").innerHTML = h + `<div class="empty" style="padding-top:80px">No coin taken apart yet</div>`; return; }
    h += `<div class="coinhead"><div class="nm">${esc(a.name)}</div><div class="sub">${esc(a.symbol || "")} · Solana · Auditor</div></div>
      <div class="discs" id="discs">${a.layers.map((l, i) => `<div class="disc" data-i="${i}" style="top:${i * 31}px;z-index:${8 - i}"><span class="mk"></span></div>`).join("")}<div class="beam" id="beam"></div></div>
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
    const known = a.layers.findIndex(l => l.pass === null && l.value !== "not checked");
    const upto = known === -1 ? 8 : known;
    if (REDUCED || S.animated[key]) { for (let i = 0; i < upto; i++) paint(i); if (known !== -1) { b.style.opacity = 1; b.style.top = (known * 31 + 21) + "px"; } return; }
    S.animated[key] = true;
    let i = 0;
    b.style.top = "21px"; b.style.opacity = 1;
    const next = () => {
      if (i >= upto) { b.style.opacity = known === -1 ? 0 : 1; return; }
      b.style.top = (i * 31 + 21) + "px";
      setTimeout(() => { paint(i); i++; setTimeout(next, 150); }, 350);
    };
    next();
  }

  function coin() {
    const m = S.view.mint, c = S.d[`coin/${m}.json`];
    let h = `<div class="nav">${backBtn}<div class="grow"></div></div>`;
    if (!c) {
      const nf = S.notFound && S.notFound.includes(`coin/${m}.json`);
      $("#view").innerHTML = h + (nf ? `<div class="empty">This coin isn't on the desk tonight.</div>` : sk(40, 0) + sk(70) + sk(260) + sk(140)); return;
    }
    const p = c.position;
    const since = p && p.sinceEntryPct != null ? `<div class="since ${p.sinceEntryPct >= 0 ? "green" : "red"}">${p.sinceEntryPct >= 0 ? "▲" : "▼"} ${Math.abs(p.sinceEntryPct).toFixed(2)}% since entry</div>` : "";
    const priceTxt = px(c.price);
    h += `<div class="coinhead"><div class="nm">${esc(c.name)} ${paperPill(c.mode)}</div>
      <div class="sub">${esc(c.symbol || "")} · ${esc(c.chain)}${c.age ? " · " + esc(c.age) : ""} <span class="shield ${c.shieldOk ? "" : "bad"}">⛨ ${esc(c.shield)}</span></div>
      <div class="price num ${priceTxt.length > 9 ? "small" : ""}">${priceTxt}</div>${since}</div>
      <div class="candles"><canvas id="cnd"></canvas></div>
      <div class="stats"><div><div class="k">Market cap</div><div class="val num">${short(c.marketCap)}</div></div>
        <div><div class="k">Liquidity</div><div class="val num">${short(c.liquidity)}</div></div>
        <div><div class="k">24h volume</div><div class="val num">${short(c.volume24h)}</div></div>
        <div><div class="k">Holders</div><div class="val num">${c.holders == null ? "n/a" : c.holders.toLocaleString("en-US")}</div></div></div>`;
    if (p) {
      const left = p.timeoutLeftS, lh = Math.floor(left / 3600), lm = Math.floor(left % 3600 / 60);
      h += `<div class="poscard"><div class="h">Your position</div><div class="big num">${usd(p.size)} in · Executor</div></div>
        <div class="poscard"><div class="h">Exit</div>
          <div class="kv"><span class="sec">Stop line</span><span class="num red">${px(p.stop)} · -${esc(p.stopPct)}%</span></div>
          <div class="kv"><span class="sec">Trail line</span><span class="num green">${p.trailActive ? px(p.trailLine) + " · " + p.trailPct + "% off the top" : "starts at " + px(p.trailStart)}</span></div>
          <div class="kv"><span class="sec">Time left to timeout</span><span class="num">${lh}h ${lm}m</span></div></div>`;
    }
    h += `<a class="cta ${p ? "sell" : ""}" href="${esc(c.coin_url)}" target="_blank" rel="noopener">${esc(c.button)}</a>`;
    $("#view").innerHTML = h;
    Charts.drawCandles($("#cnd"), c.candles, p ? p.exitLine : null, px);
  }

  function account() {
    const a = S.d["account.json"], s = S.d["settings.json"], st = S.d["state.json"];
    let h = `<h1 class="large">Account</h1>`;
    if (!a || !s) { $("#view").innerHTML = h + sk(100, 0) + sk(150, 20) + sk(400, 20); return; }
    h += `<div class="list"><div class="lrow"><div class="main"><div class="t">Mode</div><div class="s">LIVE needs typing LIVE in Telegram</div></div>
        <div class="seg" style="width:150px"><span class="${a.mode === "PAPER" ? "on" : ""}">PAPER</span><span class="${a.mode === "LIVE" ? "on" : ""}">LIVE</span></div></div>
      <div class="lrow"><div class="main"><div class="t">Stack</div><div class="s">${a.mode === "PAPER" ? "Simulated, started at " + usd(a.paperStart) : "Set with \"stack 1240\" in Telegram"}</div></div><div class="v num">${usd(a.stack)}</div></div></div>
      <div class="group-title">FOMO</div><div class="list">
      <a class="lrow" href="${esc(a.profile_url)}" target="_blank" rel="noopener"><div class="main"><div class="t">Your FOMO profile</div><div class="s">@${esc(a.fomoHandle)}</div></div>${chev}</a>
      <button class="lrow" style="width:100%;text-align:left" id="invite" data-url="${esc(a.signup_url)}"><div class="main"><div class="t">Invite a friend</div></div>${chev}</button></div>
      <div class="group-title">Notifications</div><div class="list">
      <div class="lrow"><div class="main"><div class="t">Telegram</div><div class="s">${esc(a.telegram.bot)}</div></div><div class="v ${a.telegram.connected ? "green" : "red"}">${a.telegram.connected ? "Connected" : "Not connected"}</div></div>
      <a class="lrow" href="https://t.me/${esc(a.telegram.bot.replace("@", ""))}" target="_blank" rel="noopener"><div class="main"><div class="t">Send test push</div><div class="s">Send "test" to the bot</div></div>${chev}</a>
      <div class="lrow"><div class="main"><div class="t">Web push</div><div class="s">${esc(a.webpush.note)}</div></div></div></div>
      <div class="note">${esc(a.readOnlyNote)}</div>`;
    const label = { scanner: "Scanner", auditor: "Auditor", analyst: "Analyst", executor: "Executor", risk: "Risk", desk: "Desk" };
    s.groups.forEach(g => {
      h += `<div class="group-title" id="set-${g.agent}">${label[g.agent]}</div><div class="list">` + g.items.map(it => {
        let ctl;
        if (it.choices) ctl = `<div class="seg" style="min-height:36px">${it.choices.map(c => `<span class="${String(c) === String(it.value) ? "on" : ""}">${esc(String(c))}</span>`).join("")}</div>`;
        else if (it.min !== undefined) ctl = `<input type="number" value="${esc(it.value)}" disabled>`;
        else ctl = `<input type="text" value="${esc(it.value)}" disabled>`;
        const slider = it.min !== undefined ? `<input type="range" min="${it.min}" max="${it.max}" step="any" value="${esc(it.value)}" disabled><div class="rng"><span>${it.min}</span><span>${it.max}</span></div>` : "";
        return `<div class="setrow"><div class="top"><span>${esc(it.name.replace(/_/g, " "))}</span>${it.choices ? "" : ctl}</div>${it.choices ? `<div style="margin-top:8px">${ctl}</div>` : ""}${slider}</div>`;
      }).join("") + `</div>`;
    });
    $("#view").innerHTML = h + `<div style="height:20px"></div>`;
    if (S.view.section) { const el = $("#set-" + S.view.section); if (el) el.scrollIntoView(); S.view.section = null; }
  }

  /* ---------- router */
  function render() {
    offlineRow();
    const n = S.view.name;
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === n || (n === "coin" || n === "audit") && t.dataset.tab === S.tabBefore));
    if (!S.dp) { $("#view").innerHTML = `<div class="empty" style="padding-top:120px">Open the private link from Telegram in Safari, then Share → Add to Home Screen.</div>`; return; }
    ({ home, agents, activity, audit, coin, account }[n] || home)();
  }
  function go(view) {
    if (["home", "agents", "activity", "account"].includes(view.name)) S.tabBefore = view.name;
    if (view.name !== S.view.name || view.mint !== S.view.mint) { S.stack = S.stack || []; S.stack.push(S.view); }
    S.view = view; $("#view").innerHTML = ""; S.prevChart = null; window.scrollTo(0, 0);
    render(); poll();
  }
  document.addEventListener("click", async e => {
    const t = e.target.closest("[data-tab],[data-open],[data-range],[data-back],[data-switch],[data-ro],#invite,#more,#searchBtn,#bell,.acard");
    if (!t) return;
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
    if (t.dataset.back !== undefined) { const prev = (S.stack || []).pop() || { name: "home" }; S.view = prev; $("#view").innerHTML = ""; render(); poll(); return; }
    if (t.dataset.range) { S.range = t.dataset.range; S.prevChart = null; render(); poll(); return; }
    if (t.dataset.open) { if (t.dataset.mint) go({ name: t.dataset.open, mint: t.dataset.mint }); return; }
    if (t.classList.contains("acard")) { if (t.dataset.agent === "auditor") go({ name: "audit" }); else go({ name: "agents" }); return; }
    if (t.dataset.tab) { go({ name: t.dataset.tab, section: t.dataset.section }); return; }
  });
  document.addEventListener("input", e => { if (e.target.id === "searchIn") $("#searchRes").innerHTML = searchResults(e.target.value); });
  window.addEventListener("resize", () => render());
  render(); poll(); setInterval(poll, POLL_S * 1000);
})();
