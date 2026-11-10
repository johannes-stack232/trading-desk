/* Hand-drawn canvas charts (no library). devicePixelRatio aware. */
(function () {
  const REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function setup(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  const t = s => Date.parse(s);
  const seenMarks = new Map();

  /* Home line chart: points [[iso, value]], marks [{ts,text,color}], start value (dashed line). */
  function drawLine(cv, data, prev) {
    const run = p => {
      const { ctx, w, h } = setup(cv);
      const pts = (data.points || []).map(([ts, v]) => [t(ts), v]);
      const start = data.start;
      const padT = 64, padB = 14;
      let lo = start, hi = start;
      pts.forEach(p => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
      if (hi - lo < Math.max(1, Math.abs(start) * 0.002)) { const m = Math.max(1, Math.abs(start) * 0.002); lo -= m; hi += m; }
      const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
      const x0 = pts.length ? pts[0][0] : Date.now() - 3600e3, x1 = pts.length ? pts[pts.length - 1][0] : Date.now();
      const span = Math.max(1, x1 - x0);
      const X = x => 16 + (w - 32) * (x - x0) / span;
      const Y = v => padT + (h - padT - padB) * (1 - (v - lo) / (hi - lo));
      // dashed start line
      ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(235,235,245,0.3)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Y(start)); ctx.lineTo(w, Y(start)); ctx.stroke(); ctx.restore();
      if (pts.length < 2) return;
      // animate the newest point sliding in
      let draw = pts;
      if (p < 1 && pts.length >= 2) {
        const a = pts[pts.length - 2], b = pts[pts.length - 1];
        draw = pts.slice(0, -1).concat([[a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p]]);
      }
      const grad = ctx.createLinearGradient(0, padT, 0, h);
      grad.addColorStop(0, "rgba(0,211,90,0.28)"); grad.addColorStop(1, "rgba(0,211,90,0)");
      ctx.beginPath(); draw.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1])));
      ctx.lineTo(X(draw[draw.length - 1][0]), h); ctx.lineTo(X(draw[0][0]), h); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); draw.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1])));
      ctx.strokeStyle = "#00d35a"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      const last = draw[draw.length - 1];
      ctx.fillStyle = "#00d35a"; ctx.beginPath(); ctx.arc(X(last[0]), Y(last[1]), 3.5, 0, 7); ctx.fill();
      // marks above the line, never overlapping: a later mark moves up a row
      ctx.font = "600 12px -apple-system, 'SF Pro Text', sans-serif"; ctx.textBaseline = "middle";
      const rows = [];
      const valAt = x => { let v = pts[0][1]; for (const q of pts) { if (q[0] <= x) v = q[1]; else break; } return v; };
      (data.marks || []).forEach(m => {
        const mx = t(m.ts); if (mx < x0 || mx > x1) return;
        const key = m.ts + m.text; if (!seenMarks.has(key)) seenMarks.set(key, performance.now());
        const age = performance.now() - seenMarks.get(key);
        const alpha = REDUCED ? 1 : Math.min(1, age / 200);
        const tw = ctx.measureText(m.text).width + 14;
        let x = Math.min(Math.max(X(mx) - tw / 2, 4), w - tw - 4);
        const baseY = Math.max(14, Y(valAt(mx)) - 22);
        let row = 0;
        while ((rows[row] || []).some(r => !(x + tw < r[0] || x > r[1]))) row++;
        (rows[row] = rows[row] || []).push([x - 4, x + tw + 4]);
        const y = Math.max(12, baseY - row * 24);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#1c1c1e"; roundRect(ctx, x, y - 10, tw, 20, 10); ctx.fill();
        ctx.fillStyle = m.color; ctx.fillText(m.text, x + 7, y + 0.5);
        ctx.beginPath(); ctx.arc(X(mx), Y(valAt(mx)), 3, 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
      });
      if ((data.marks || []).some(m => performance.now() - (seenMarks.get(m.ts + m.text) || 0) < 200) && !REDUCED) requestAnimationFrame(() => run(1));
    };
    const grew = prev && data.points && prev.points && data.points.length > prev.points.length;
    if (!grew || REDUCED) return run(1);
    const t0 = performance.now();
    const step = now => { const p = Math.min(1, (now - t0) / 250); run(p); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /* Coin screen: 1-minute candles + volume bars + orange dashed exit line. */
  function drawCandles(cv, candles, exitLine, fmt) {
    const { ctx, w, h } = setup(cv);
    const volH = 46, padT = 16, padB = volH + 10, padR = 8;
    if (!candles || !candles.length) {
      ctx.fillStyle = "rgba(235,235,245,0.6)"; ctx.font = "15px -apple-system, sans-serif"; ctx.textAlign = "center";
      ctx.fillText("Waiting for price polls", w / 2, h / 2); return;
    }
    let lo = Infinity, hi = -Infinity, vmax = 0;
    candles.forEach(c => { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); vmax = Math.max(vmax, c.v || 0); });
    if (exitLine) { lo = Math.min(lo, exitLine); hi = Math.max(hi, exitLine); }
    if (hi === lo) { hi *= 1.01; lo *= 0.99; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const n = Math.max(candles.length, 30);
    const cw = (w - 16 - padR) / n;
    const X = i => 16 + cw * (i + 0.5 + (n - candles.length));
    const Y = v => padT + (h - padT - padB) * (1 - (v - lo) / (hi - lo));
    candles.forEach((c, i) => {
      const up = c.c >= c.o; const col = up ? "#00d35a" : "#ff453a";
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(i), Y(c.h)); ctx.lineTo(X(i), Y(c.l)); ctx.stroke();
      const bw = Math.max(1.5, cw * 0.62); const y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c));
      ctx.fillRect(X(i) - bw / 2, y1, bw, Math.max(1, y2 - y1));
      if (vmax > 0) { const vh = (c.v || 0) / vmax * volH; ctx.globalAlpha = 0.45; ctx.fillRect(X(i) - bw / 2, h - vh, bw, vh); ctx.globalAlpha = 1; }
    });
    if (exitLine) {
      const y = Y(exitLine);
      ctx.save(); ctx.setLineDash([6, 4]); ctx.strokeStyle = "#ff9f0a"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.restore();
      ctx.fillStyle = "#ff9f0a"; ctx.font = "600 12px -apple-system, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText("Risk trailing stop · " + fmt(exitLine), 16, y - 3);
    }
  }

  /* Analyst score ring 0-100, green from minScore. */
  function drawRing(cv, score, minScore) {
    const { ctx, w, h } = setup(cv);
    const r = Math.min(w, h) / 2 - 7, cx = w / 2, cy = h / 2;
    ctx.lineWidth = 10; ctx.lineCap = "round";
    ctx.strokeStyle = "#2c2c2e"; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    if (score != null) {
      ctx.strokeStyle = score >= minScore ? "#00d35a" : "#ffd60a";
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(100, score)) / 100); ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "700 30px -apple-system, 'SF Pro Display', sans-serif";
    ctx.fillText(score == null ? "–" : String(score), cx, cy);
  }

  window.Charts = { drawLine, drawCandles, drawRing, REDUCED };
})();
