/* Spin-the-Wheel logic. UI lives in index.html + style.css; content in options.json. */
(function () {
  "use strict";

  const CONFIG = {
    wheelSize: 380,
    minTurns: 4, maxTurns: 9,          // pace varies randomly per spin
    minSeconds: 4, maxSeconds: 8,      // duration varies randomly per spin
    colorMinDistance: 70,              // adjacent slices must differ by at least this (perceptual)
    // Victorian jewel-tone palette (deep, antique)
    palette: ["#7B2D26", "#15345B", "#22503A", "#4E2A52", "#8A4B2B",
              "#1F5A5A", "#5C1A33", "#55551E", "#35406B", "#6E3B1E", "#2E4428", "#704214"]
  };
  const LABEL_COLOR = "#f3e9d2";   // parchment ink on the dark slices
  const EDGE_COLOR = "#d9b64e";    // gold separators between slices
  const DEFAULT = { title: "Spin the Wheel", options: { A: null, B: null, C: null, D: null, E: null, F: null } };

  const canvas = document.getElementById("wheel");
  const ctx = canvas.getContext("2d");
  const spinBtn = document.getElementById("spin");
  const resultEl = document.getElementById("result");
  const wordEl = document.getElementById("word");
  const titleEl = document.getElementById("title");
  const wrap = document.getElementById("wrap");

  const SIZE = CONFIG.wheelSize, R = SIZE / 2;
  canvas.width = SIZE; canvas.height = SIZE;
  canvas.style.width = SIZE + "px"; canvas.style.height = SIZE + "px";
  wrap.style.width = SIZE + "px"; wrap.style.height = SIZE + "px";

  let segments = [], rotation = 0, spinning = false;

  function secureRandom() { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] / 4294967296; }

  // ── parse options.json (schema A object map; also accepts arrays) ──
  function parseOptions(raw) {
    const out = [];
    const clampW = v => (typeof v === "number" && isFinite(v)) ? Math.max(0, Math.min(100, v)) : null;
    if (Array.isArray(raw)) {
      raw.forEach(it => {
        if (typeof it === "string") out.push({ label: it, weight: null });
        else if (it && typeof it === "object") out.push({ label: String(it.label), weight: clampW(it.weight) });
      });
    } else if (raw && typeof raw === "object") {
      Object.keys(raw).forEach(k => out.push({ label: k, weight: clampW(raw[k]) }));
    }
    return out;
  }

  // ── weighting: a weight keeps w% of the equal share; freed space is split equally among nulls ──
  function computeShares(entries) {
    const N = entries.length, E = 100 / N;
    const nulls = []; let freed = 0;
    const pct = entries.map(e => {
      if (e.weight == null) { nulls.push(e); return null; }
      const s = (e.weight / 100) * E; freed += E - s; return s;
    });
    if (nulls.length) {
      const add = freed / nulls.length;
      entries.forEach((e, i) => { if (pct[i] == null) pct[i] = E + add; });
    } else {
      const sum = pct.reduce((a, b) => a + b, 0);
      if (sum > 0) for (let i = 0; i < pct.length; i++) pct[i] = pct[i] / sum * 100;
      else for (let i = 0; i < pct.length; i++) pct[i] = E;
    }
    return pct;
  }

  // ── colors: random, but every adjacent slice (incl wrap) is perceptually distinct ──
  function hexToRgb(h) { h = h.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function colorDist(a, b) {
    const rm = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  }
  function assignColors(n) {
    const pal = CONFIG.palette.map(h => ({ hex: h, rgb: hexToRgb(h) })), out = [];
    for (let i = 0; i < n; i++) {
      const nb = [];
      if (i > 0) nb.push(out[i - 1]);
      if (i === n - 1 && n > 1) nb.push(out[0]);
      const sc = pal.map(c => ({ c, d: nb.length ? Math.min.apply(null, nb.map(x => colorDist(c.rgb, x.rgb))) : Infinity }));
      const ok = sc.filter(s => s.d >= CONFIG.colorMinDistance);
      let p;
      if (ok.length) p = ok[Math.floor(secureRandom() * ok.length)].c;
      else { sc.sort((a, b) => b.d - a.d); p = sc[0].c; }
      out.push(p);
    }
    return out.map(c => c.hex);
  }

  function build(entries, title) {
    const pct = computeShares(entries), colors = assignColors(entries.length);
    let cum = 0;
    segments = entries.map((e, i) => {
      const sizeDeg = pct[i] / 100 * 360;
      const s = { label: e.label, color: colors[i], startDeg: cum, sizeDeg };
      cum += sizeDeg; return s;
    }).filter(s => s.sizeDeg > 0.0001);
    if (title) { titleEl.textContent = title; document.title = title; }
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, SIZE, SIZE);
    segments.forEach(s => {
      const start = -Math.PI / 2 + s.startDeg * Math.PI / 180, end = start + s.sizeDeg * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(R, R); ctx.arc(R, R, R - 2, start, end); ctx.closePath();
      ctx.fillStyle = s.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = EDGE_COLOR; ctx.stroke();   // gold separators
      ctx.save(); ctx.translate(R, R); ctx.rotate(start + (end - start) / 2);
      ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillStyle = LABEL_COLOR;
      ctx.font = "600 16px 'Cormorant Garamond', Georgia, serif";
      const label = String(s.label);
      ctx.fillText(label.length > 16 ? label.slice(0, 15) + "…" : label, R - 22, 0);
      ctx.restore();
    });
  }

  function winnerLabel(rot) {
    const a0 = ((-rot % 360) + 360) % 360;
    for (const s of segments) if (a0 >= s.startDeg && a0 < s.startDeg + s.sizeDeg) return s.label;
    return segments.length ? segments[segments.length - 1].label : "";
  }

  function spin() {
    if (spinning || segments.length < 1) return;
    spinning = true; spinBtn.disabled = true; resultEl.classList.remove("show"); wordEl.textContent = "";
    const turns = CONFIG.minTurns + Math.floor(secureRandom() * (CONFIG.maxTurns - CONFIG.minTurns + 1));
    rotation += turns * 360 + secureRandom() * 360;
    const dur = CONFIG.minSeconds + secureRandom() * (CONFIG.maxSeconds - CONFIG.minSeconds);
    canvas.style.transition = "transform " + dur.toFixed(2) + "s cubic-bezier(0.17,0.67,0.12,0.99)";
    canvas.style.transform = "rotate(" + rotation + "deg)";
  }
  canvas.addEventListener("transitionend", function () {
    spinning = false; spinBtn.disabled = false;
    wordEl.textContent = winnerLabel(rotation); resultEl.classList.add("show");
  });

  spinBtn.addEventListener("click", spin);

  // repaint once the engraved font loads so canvas labels adopt it
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);

  // content: one file (options.json) drives title + options + weights
  fetch("options.json", { cache: "no-store" })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(cfg => {
      const e = parseOptions(cfg.options);
      e.length >= 2 ? build(e, cfg.title) : build(parseOptions(DEFAULT.options), DEFAULT.title);
    })
    .catch(() => build(parseOptions(DEFAULT.options), DEFAULT.title));
})();
