// WardOS - reusable UI primitives: toast, modal, alert sound, charts.
import { icon } from "./icons.js";
import { esc } from "./util.js";
import { config } from "../shared/config.js";

// ------------------------------------------------------------
// Toasts
// ------------------------------------------------------------

let toastRoot = null;

export function toast(title, message = "", kind = "info", ms = 4500) {
  if (!toastRoot) {
    toastRoot = document.createElement("div");
    toastRoot.className = "toasts";
    toastRoot.setAttribute("aria-live", "polite");
    document.body.appendChild(toastRoot);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<div><strong>${esc(title)}</strong>${message ? `<span class="muted">${esc(message)}</span>` : ""}</div>`;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, ms);
}

// ------------------------------------------------------------
// Modal (returns a promise; resolves with submit result or null)
// ------------------------------------------------------------

export function modal({ title, body, submitLabel = "Save", submitClass = "primary", onSubmit, cancelLabel = "Cancel", hideSubmit = false }) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" novalidate>
        <div class="modal-head"><h2 id="modal-title">${esc(title)}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">${icon("close")}</button></div>
        <div class="modal-body">${body}<div class="form-error hidden" role="alert"></div></div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-close>${esc(cancelLabel)}</button>
          ${hideSubmit ? "" : `<button type="submit" class="btn ${submitClass}">${esc(submitLabel)}</button>`}
        </div>
      </form>`;
    document.body.appendChild(backdrop);
    const form = backdrop.querySelector("form");
    const errorBox = form.querySelector(".form-error");

    const close = value => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      previous?.focus?.();
      resolve(value);
    };
    const onKey = e => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("mousedown", e => { if (e.target === backdrop) close(null); });
    form.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => close(null)));

    form.addEventListener("submit", async e => {
      e.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      errorBox.classList.add("hidden");
      if (!onSubmit) return close(true);
      button?.classList.add("loading");
      try {
        const data = Object.fromEntries(new FormData(form).entries());
        const result = await onSubmit(data, form);
        if (result !== false) close(result ?? true);
      } catch (error) {
        errorBox.textContent = error.message || "Something went wrong";
        errorBox.classList.remove("hidden");
      } finally {
        button?.classList.remove("loading");
      }
    });

    setTimeout(() => (form.querySelector("input, select, textarea, button[type=submit]") ?? form).focus(), 30);
  });
}

export function confirmDialog(title, text, label = "Confirm", cls = "primary") {
  return modal({ title, body: `<p class="muted">${esc(text)}</p>`, submitLabel: label, submitClass: cls });
}

// ------------------------------------------------------------
// Critical alert sound
// One AudioContext, unlocked on the first user interaction.
// ------------------------------------------------------------

export class AlertSound {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem("wardos-muted") === "1";
    this.state = "locked"; // locked | ready | unavailable
    this.listeners = new Set();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.state = "unavailable";
      return;
    }
    this.unlock = async () => {
      try {
        this.ctx ??= new AC();
        if (this.ctx.state === "suspended") await this.ctx.resume();
        this.state = this.ctx.state === "running" ? "ready" : "locked";
      } catch {
        this.state = "unavailable";
      }
      if (this.state === "ready") {
        window.removeEventListener("pointerdown", this.unlock);
        window.removeEventListener("keydown", this.unlock);
      }
      this.emit();
    };
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() { for (const cb of this.listeners) cb(this); }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem("wardos-muted", this.muted ? "1" : "0"); } catch { /* ignore */ }
    this.emit();
  }

  /** Two-tone chime (critical). Never loops on its own. */
  play(kind = "critical") {
    if (this.muted || this.state !== "ready" || !this.ctx) return false;
    const t0 = this.ctx.currentTime;
    const tones = kind === "critical" ? [[880, 0], [660, 0.22], [880, 0.44]] : [[660, 0]];
    for (const [freq, at] of tones) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.2);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.22);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
    return true;
  }

  destroy() {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
    this.ctx?.close();
  }
}

// ------------------------------------------------------------
// Motion helpers
// ------------------------------------------------------------

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Count a number up/down to its new value (integers only). */
export function tweenNumber(node, to, ms = 600) {
  const from = Number(node.dataset.n ?? to);
  node.dataset.n = to;
  if (from === to || reducedMotion()) { node.textContent = to; return; }
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = Math.round(from + (to - from) * eased);
    if (t < 1 && node.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------
// Sparklines - last 10 minutes of REAL samples. Gaps in the
// data stay gaps; nothing is interpolated or invented.
// ------------------------------------------------------------

const SPARK_COLORS = { hr: "#F59E9E", spo2: "#7DB8FA", temp: "#F5C76B" };
const SPARK_RANGE = { hr: [40, 150], spo2: [85, 100], temp: [35, 40] };

export function drawSpark(canvas, samples, key, windowMs = 10 * 60000) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const now = Date.now();
  const pts = samples.filter(s => s[key] !== null && s[key] !== undefined && now - s.ts <= windowMs);
  if (pts.length < 2) return;

  let [lo, hi] = SPARK_RANGE[key];
  for (const s of pts) { lo = Math.min(lo, s[key]); hi = Math.max(hi, s[key]); }
  // Zoom towards the data so small trends are visible.
  const vals = pts.map(s => s[key]);
  const dMin = Math.min(...vals), dMax = Math.max(...vals);
  const span = Math.max(dMax - dMin, key === "temp" ? 0.6 : key === "spo2" ? 4 : 12);
  lo = (dMin + dMax) / 2 - span * 0.65;
  hi = (dMin + dMax) / 2 + span * 0.65;

  const x = ts => ((ts - (now - windowMs)) / windowMs) * w;
  const y = v => h - 2 - ((v - lo) / (hi - lo)) * (h - 4);

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, SPARK_COLORS[key] + "10");
  grad.addColorStop(1, SPARK_COLORS[key]);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let prev = null;
  for (const s of pts) {
    if (!prev || s.ts - prev.ts > 5000) ctx.moveTo(x(s.ts), y(s[key]));
    else ctx.lineTo(x(s.ts), y(s[key]));
    prev = s;
  }
  ctx.stroke();

  // Latest-value dot
  const last = pts[pts.length - 1];
  if (now - last.ts < 8000) {
    ctx.fillStyle = SPARK_COLORS[key];
    ctx.beginPath();
    ctx.arc(Math.min(x(last.ts), w - 2), y(last[key]), 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------
// Charts (Chart.js 4, loaded globally from /lib/chart.min.js)
// ------------------------------------------------------------

const COLORS = { hr: "#F87171", spo2: "#60A5FA", temp: "#FBBF24", raw: "rgba(138,151,171,0.55)" };

function baseOptions(key, { compact = false, showRaw = false } = {}) {
  const t = config.thresholds[key];
  const suggested = { hr: [40, 150], spo2: [84, 100], temp: [35, 40] }[key];
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 400 },
    interaction: { mode: "index", intersect: false },
    parsing: false,
    normalized: true,
    plugins: {
      legend: { display: showRaw, labels: { color: "#8A97AB", boxWidth: 10, font: { family: "IBM Plex Mono", size: 11 } } },
      tooltip: {
        backgroundColor: "#232B3A", borderColor: "#344156", borderWidth: 1, titleColor: "#E8EDF4", bodyColor: "#E8EDF4",
        titleFont: { family: "IBM Plex Mono", size: 11 }, bodyFont: { family: "IBM Plex Mono", size: 12 },
        callbacks: { title: items => new Date(items[0].parsed.x).toLocaleString() }
      },
      bands: { key, t }
    },
    scales: {
      x: {
        type: "linear",
        grid: { color: "rgba(38,48,65,0.6)", drawTicks: false },
        border: { display: false },
        ticks: {
          color: "#5F6B7E", font: { family: "IBM Plex Mono", size: 10.5 }, maxTicksLimit: compact ? 4 : 7, padding: 6,
          callback: v => new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
        }
      },
      y: {
        suggestedMin: suggested[0], suggestedMax: suggested[1],
        grid: { color: "rgba(38,48,65,0.6)", drawTicks: false },
        border: { display: false },
        ticks: { color: "#5F6B7E", font: { family: "IBM Plex Mono", size: 10.5 }, maxTicksLimit: 5, padding: 6 }
      }
    }
  };
}

// Shades the warning thresholds so abnormal values stand out.
const bandsPlugin = {
  id: "bands",
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: a, scales: { y } } = chart;
    if (!opts?.t || !a) return;
    const t = opts.t;
    ctx.save();
    const shade = (from, to, color) => {
      const top = y.getPixelForValue(to), bottom = y.getPixelForValue(from);
      const y1 = Math.max(a.top, Math.min(top, bottom)), y2 = Math.min(a.bottom, Math.max(top, bottom));
      if (y2 > y1) { ctx.fillStyle = color; ctx.fillRect(a.left, y1, a.right - a.left, y2 - y1); }
    };
    const warn = "rgba(251,191,36,0.05)";
    if (t.warningHigh !== undefined) shade(t.warningHigh, y.max, warn);
    if (t.warningLow !== undefined) shade(y.min, t.warningLow, warn);
    ctx.restore();
  }
};

let pluginRegistered = false;

export function vitalChart(canvas, key, { compact = false, showRaw = false } = {}) {
  if (!window.Chart) return null;
  if (!pluginRegistered) { window.Chart.register(bandsPlugin); pluginRegistered = true; }
  window.Chart.getChart(canvas)?.destroy();

  const datasets = [{
    label: showRaw ? "Cleaned" : key.toUpperCase(),
    data: [],
    borderColor: COLORS[key],
    backgroundColor: COLORS[key] + "22",
    borderWidth: 1.8,
    pointRadius: 0,
    pointHoverRadius: 3,
    tension: 0.25,
    spanGaps: false,
    fill: false
  }];
  if (showRaw) {
    datasets.push({ label: "Raw sensor", data: [], borderColor: COLORS.raw, borderDash: [4, 4], borderWidth: 1, pointRadius: 0, tension: 0.2, spanGaps: false });
  }
  datasets.push({
    label: "Anomaly", data: [], showLine: false, pointRadius: 4, pointBackgroundColor: "#FBBF24", pointBorderColor: "#0A0E14", pointBorderWidth: 1
  });

  return new window.Chart(canvas, { type: "line", data: { datasets }, options: baseOptions(key, { compact, showRaw }) });
}

/**
 * Feed points [{ts, kind?, hr, spo2, temp, anomaly}] into a chart.
 * Gaps longer than gapMs are broken (no line drawn through
 * periods without data - nothing is interpolated).
 */
export function setChartData(chart, key, points, { gapMs = 15000, showRaw = false } = {}) {
  if (!chart) return;
  const clean = [], raw = [], anomalies = [];
  let lastClean = null, lastRaw = null;
  for (const p of points) {
    const v = p[key];
    const target = p.kind === "raw" ? raw : clean;
    const last = p.kind === "raw" ? lastRaw : lastClean;
    if (last !== null && p.ts - last > gapMs) target.push({ x: last + 1, y: null });
    target.push({ x: p.ts, y: v === null || v === undefined ? null : v });
    if (p.kind === "raw") lastRaw = p.ts; else lastClean = p.ts;
    if (p.anomaly && p.kind !== "raw" && v !== null) anomalies.push({ x: p.ts, y: v });
  }
  // Fit the Y axis to the data around the clinically useful range.
  const values = [...clean, ...raw].map(p => p.y).filter(v => v !== null && Number.isFinite(v));
  const base = { hr: [40, 150], spo2: [84, 100], temp: [35, 40] }[key];
  const pad = key === "temp" ? 0.3 : 3;
  chart.options.scales.y.min = Math.floor(Math.min(base[0], ...values) - pad);
  chart.options.scales.y.max = key === "spo2" ? 100 : Math.ceil(Math.max(base[1], ...values) + pad);

  chart.data.datasets[0].data = clean;
  if (showRaw) chart.data.datasets[1].data = raw;
  chart.data.datasets[chart.data.datasets.length - 1].data = anomalies;
  chart.update();
}
