/* Hand-drawn canvas charts (no library). devicePixelRatio aware. Home line (draws left to right, event pills),
   coin candles (right price axis, volume, entry pill, Risk line, current-price line, smooth rescale), score ring, confetti. */
(function () {
  const REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FONT = "-apple-system, 'SF Pro Text', BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
  const GREEN = "#30d158", RED = "#ff453a", BLUE = "#0a84ff", ORANGE = "#ff9f0a";
  function setup(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  const t = s => Date.parse(s);
  const ease = p => 1 - Math.pow(1 - p, 3);
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /* ---------- Home line chart.
     data: {points:[[iso,v]], marks:[{ts,kind,text,color,mint}], start}. The line draws left to right the first time a range is shown;
     later polls only move the head. Exit marks get a floating pill with a connector to a dot on the line; buys get a small blue dot. */
  const drawn = new Set();
  function drawLine(cv, data, key, imgFor) {
    const pts = (data.points || []).map(([ts, v]) => [t(ts), v]);
    const first = !drawn.has(key); drawn.add(key);
    const run = p => {
      const { ctx, w, h } = setup(cv);
      const padT = 62, padB = 8;
      let lo = Infinity, hi = -Infinity;
      pts.forEach(q => { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); });
      if (!pts.length) { lo = hi = data.start || 0; }
      const m0 = Math.max(0.5, Math.abs(hi) * 0.001); if (hi - lo < m0) { lo -= m0; hi += m0; }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
      if (pts.length < 2) return;
      const x0 = pts[0][0], x1 = pts[pts.length - 1][0], span = Math.max(1, x1 - x0);
      const X = x => 2 + (w - 14) * (x - x0) / span;
      const Y = v => padT + (h - padT - padB) * (1 - (v - lo) / (hi - lo));
      const xEnd = x0 + span * p;
      const draw = [];
      for (let i = 0; i < pts.length; i++) {
        if (pts[i][0] <= xEnd) draw.push(pts[i]);
        else { const a = pts[i - 1], b = pts[i]; const f = (xEnd - a[0]) / Math.max(1, b[0] - a[0]); draw.push([xEnd, a[1] + (b[1] - a[1]) * f]); break; }
      }
      const up = pts[pts.length - 1][1] >= (data.start != null ? data.start : pts[0][1]);
      const col = up ? GREEN : RED, rgb = up ? "48,209,88" : "255,69,58";
      const grad = ctx.createLinearGradient(0, padT, 0, h);
      grad.addColorStop(0, `rgba(${rgb},0.32)`); grad.addColorStop(1, `rgba(${rgb},0)`);
      ctx.beginPath(); draw.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1])));
      ctx.lineTo(X(draw[draw.length - 1][0]), h); ctx.lineTo(X(draw[0][0]), h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); draw.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1])));
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.shadowColor = `rgba(${rgb},0.6)`; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
      const head = draw[draw.length - 1];
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(head[0]), Y(head[1]), 4, 0, 7); ctx.fill();
      // marks
      const valAt = x => { let v = pts[0][1]; for (const q of pts) { if (q[0] <= x) v = q[1]; else break; } return v; };
      const marks = (data.marks || []).filter(m => { const mx = t(m.ts); return mx >= x0 && mx <= xEnd; });
      marks.forEach(m => { const mx = t(m.ts), y = Y(valAt(mx));
        ctx.beginPath(); ctx.arc(X(mx), y, 3.2, 0, 7); ctx.fillStyle = "#000"; ctx.fill();
        ctx.lineWidth = 1.6; ctx.strokeStyle = m.kind === "buy" ? GREEN : m.color; ctx.stroke(); });
      // floating pills for the latest two exits
      ctx.font = `700 13px ${FONT}`; ctx.textBaseline = "middle";
      const exits = marks.filter(m => m.kind !== "buy").slice(-2);
      const placed = [];
      exits.forEach((m, k) => {
        const mx = t(m.ts), my = Y(valAt(mx));
        const txt = m.kind === "loss" ? m.text.replace(" · ", " → ") : m.text;
        const img = imgFor && imgFor(m.mint);
        const tw = ctx.measureText(txt).width + 18 + (img ? 20 : 0), ph = 22;
        let x = Math.min(Math.max(X(mx) - tw / 2, 4), w - tw - 4);
        let y = Math.max(4, Math.min(my - 44, padT - 30));
        let guard = 0; while (guard++ < 4 && placed.some(r => !(x + tw < r[0] || x > r[1]) && Math.abs(r[2] - y) < ph + 4)) y += ph + 4;
        placed.push([x, x + tw, y]);
        ctx.globalAlpha = first && !REDUCED ? Math.max(0, Math.min(1, (p - 0.6) / 0.4)) : 1;
        ctx.strokeStyle = m.color; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(X(mx), my - 4); ctx.lineTo(X(mx), y + ph); ctx.stroke(); ctx.setLineDash([]);
        const bg = m.kind === "loss" ? "rgba(255,69,58,0.92)" : "rgba(10,40,20,0.92)";
        rr(ctx, x, y, tw, ph, 11); ctx.fillStyle = bg; ctx.fill();
        ctx.strokeStyle = m.kind === "loss" ? RED : GREEN; ctx.lineWidth = 1.2; ctx.stroke();
        let tx = x + 9;
        if (img && img.complete && img.naturalWidth) { ctx.save(); ctx.beginPath(); ctx.arc(x + 13, y + ph / 2, 8, 0, 7); ctx.clip(); ctx.drawImage(img, x + 5, y + ph / 2 - 8, 16, 16); ctx.restore(); tx += 20; }
        else if (img) tx += 20;
        ctx.fillStyle = m.kind === "loss" ? "#fff" : GREEN; ctx.fillText(txt, tx, y + ph / 2 + 0.5);
        ctx.globalAlpha = 1;
      });
    };
    if (!first || REDUCED) return run(1);
    const t0 = performance.now();
    const step = now => { const p = Math.min(1, (now - t0) / 1400); run(ease(p)); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  /* ---------- Coin candles. opt: {entry, entryTs, exitLine, exitLabel, price, fmt}. Scale eases toward the new range (smooth pan/zoom). */
  const scales = new WeakMap();
  function drawCandles(cv, candles, opt) {
    const target = (() => {
      let lo = Infinity, hi = -Infinity, vmax = 0;
      (candles || []).forEach(c => { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); vmax = Math.max(vmax, c.v || 0); });
      [opt.exitLine, opt.entry, opt.price].forEach(v => { if (v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
      if (!isFinite(lo)) return null;
      if (hi === lo) { hi *= 1.01; lo *= 0.99; }
      const pad = (hi - lo) * 0.1; return { lo: lo - pad, hi: hi + pad, vmax };
    })();
    const paint = sc => {
      const { ctx, w, h } = setup(cv);
      if (!candles || !candles.length || !sc) {
        ctx.fillStyle = "rgba(235,235,245,0.6)"; ctx.font = `15px ${FONT}`; ctx.textAlign = "center";
        ctx.fillText("Waiting for price polls", w / 2, h / 2); return;
      }
      const volH = 40, padT = 14, padB = volH + 12, axisW = 66;
      const n = Math.max(candles.length, 40), cw = (w - axisW - 4) / n;
      const X = i => 4 + cw * (i + 0.5 + (n - candles.length));
      const Y = v => padT + (h - padT - padB) * (1 - (v - sc.lo) / (sc.hi - sc.lo));
      // grid + axis labels
      ctx.font = `500 10px ui-monospace, 'SF Mono', Menlo, monospace`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      for (let k = 0; k <= 4; k++) {
        const v = sc.lo + (sc.hi - sc.lo) * (k + 0.5) / 5, y = Y(v);
        ctx.strokeStyle = "rgba(84,84,88,0.25)"; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w - axisW, y); ctx.stroke();
        ctx.fillStyle = "rgba(235,235,245,0.35)"; ctx.fillText(opt.fmt(v), w - axisW + 6, y);
      }
      candles.forEach((c, i) => {
        const up = c.c >= c.o, col = up ? GREEN : RED;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(i), Y(c.h)); ctx.lineTo(X(i), Y(c.l)); ctx.stroke();
        const bw = Math.max(1.5, cw * 0.66), y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c));
        ctx.fillRect(X(i) - bw / 2, y1, bw, Math.max(1, y2 - y1));
        if (sc.vmax > 0) { const vh = (c.v || 0) / sc.vmax * volH; ctx.globalAlpha = 0.4; ctx.fillRect(X(i) - bw / 2, h - vh, bw, vh); ctx.globalAlpha = 1; }
      });
      const hline = (v, color, dash, alpha) => { const y = Y(v); ctx.save(); ctx.globalAlpha = alpha || 1; ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w - axisW, y); ctx.stroke(); ctx.restore(); return y; };
      ctx.font = `600 11px ${FONT}`;
      if (opt.entry) {
        const y = hline(opt.entry, BLUE, [2, 3], 0.8);
        let ei = candles.findIndex(c => c.t >= (opt.entryTs || "").slice(0, 16));
        if (ei < 0) ei = 0;
        const lbl = "Executor buy", tw = ctx.measureText(lbl).width + 14, x = Math.min(Math.max(X(ei) - tw / 2, 2), w - axisW - tw - 2);
        const py = Math.min(h - padB - 2, y + 8);
        rr(ctx, x, py, tw, 18, 4); ctx.fillStyle = BLUE; ctx.fill();
        ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.fillText(lbl, x + 7, py + 9.5);
        ctx.beginPath(); ctx.moveTo(X(ei), py); ctx.lineTo(X(ei), y); ctx.strokeStyle = BLUE; ctx.stroke();
      }
      if (opt.exitLine) {
        const y = hline(opt.exitLine, "#ff6b3a", [5, 4]);
        const lbl = opt.exitLabel, tw = ctx.measureText(lbl).width + 10;
        rr(ctx, 2, y - 17, tw, 15, 3); ctx.fillStyle = "rgba(60,20,0,0.85)"; ctx.fill();
        ctx.fillStyle = ORANGE; ctx.textAlign = "left"; ctx.fillText(lbl, 7, y - 9);
      }
      const last = opt.price || candles[candles.length - 1].c;
      const y = hline(last, GREEN, [1.5, 3]);
      ctx.font = `700 11px ui-monospace, 'SF Mono', Menlo, monospace`;
      const txt = opt.fmt(last), tw = Math.max(axisW - 4, ctx.measureText(txt).width + 10);
      rr(ctx, w - tw - 1, y - 10, tw, 20, 4); ctx.fillStyle = GREEN; ctx.fill();
      ctx.fillStyle = "#000"; ctx.textAlign = "left"; ctx.fillText(txt, w - tw + 4, y + 0.5);
    };
    const prev = scales.get(cv);
    if (!target || !prev || REDUCED) { scales.set(cv, target); return paint(target); }
    const t0 = performance.now();
    const step = now => {
      const p = ease(Math.min(1, (now - t0) / 500));
      const sc = { lo: prev.lo + (target.lo - prev.lo) * p, hi: prev.hi + (target.hi - prev.hi) * p, vmax: prev.vmax + (target.vmax - prev.vmax) * p };
      scales.set(cv, sc); paint(sc); if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- Analyst score ring: red below half the pass mark, yellow below it, green from it. */
  function drawRing(cv, score, minScore) {
    const { ctx, w, h } = setup(cv);
    const r = Math.min(w, h) / 2 - 5, cx = w / 2, cy = h / 2;
    ctx.lineWidth = 6; ctx.lineCap = "round";
    ctx.strokeStyle = "#2c2c2e"; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    if (score != null) {
      ctx.strokeStyle = score >= minScore ? GREEN : score >= minScore / 2 ? "#ffd60a" : RED;
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(100, score)) / 100); ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(r * 0.8)}px -apple-system, 'SF Pro Display', sans-serif`;
    ctx.fillText(score == null ? "–" : String(score), cx, cy + 1);
  }

  /* ---------- Confetti: pink/green/blue/yellow rectangles that rotate and fall, full screen, ~3.2 s. */
  function confetti() {
    if (REDUCED) return;
    const cv = document.createElement("canvas"); cv.className = "confetti"; document.body.appendChild(cv);
    const cols = ["#ff2d92", "#30d158", "#0a84ff", "#ffd60a", "#ff6b9a", "#64d2ff"];
    const W = innerWidth, H = innerHeight;
    const ps = Array.from({ length: 150 }, () => ({ x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.35, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 11 - 4,
      w: 6 + Math.random() * 6, h: 10 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[(Math.random() * cols.length) | 0], f: Math.random() * 6 }));
    const t0 = performance.now();
    const step = now => {
      const el = now - t0; const { ctx } = setup(cv);
      ps.forEach(p => { p.vy += 0.28; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.f += 0.15;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.scale(1, Math.cos(p.f)); ctx.fillStyle = p.c;
        ctx.globalAlpha = Math.max(0, 1 - Math.max(0, el - 2600) / 600); ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); });
      if (el < 3200) requestAnimationFrame(step); else cv.remove();
    };
    requestAnimationFrame(step);
  }

  window.Charts = { drawLine, drawCandles, drawRing, confetti, REDUCED };
})();
