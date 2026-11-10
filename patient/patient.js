// ============================================================
// WardOS - Patient portal
// Plain-language view of the signed-in patient's OWN data.
// The server only ever streams this patient's record.
// ============================================================

import { startApp } from "../app/shell.js";
import { api } from "../app/api.js";
import { icon } from "../app/icons.js";
import { vitalChart, setChartData } from "../app/ui.js";
import { esc, fmtVital, UNITS, VITAL_NAMES, vitalLevel, timeAgo, fmtTime, fmtDate, $, $$ } from "../app/util.js";

const PLAIN = {
  ok: ["Your readings look steady", "Your care team is monitoring you continuously."],
  warning: ["A reading needs a closer look", "Your care team has been notified automatically and will check on you."],
  critical: ["Your care team has been alerted", "A nurse has been notified. If you feel unwell, press your call button."],
  offline: ["Your band isn't sending data", "Your band may be out of range or switched off. Let your nurse know if this continues."],
  removed: ["Your band isn't on", "The sensor reports it isn't touching your skin. Please ask your nurse to help refit it."]
};

const VITAL_HELP = {
  hr: "How many times your heart beats each minute.",
  spo2: "How much oxygen your blood is carrying.",
  temp: "Your body temperature."
};

function homeView(el, ctx) {
  let range = 6;
  let chartKey = "hr";
  el.innerHTML = `
    <div class="me-hero"><div><span class="eyebrow">My health</span><h1 id="me-hello"></h1><p id="me-place"></p></div>
      <div class="muted mono" style="font-size:12.5px" id="me-updated"></div></div>
    <div class="me-status" id="me-status"></div>
    <div class="vital-cards me-vitals" id="me-vitals"></div>
    <div class="card" style="margin-top:14px">
      <div class="card-head"><h2>My trends</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <div class="seg" role="group" aria-label="Measurement">${["hr", "spo2", "temp"].map(k => `<button data-k="${k}">${VITAL_NAMES[k]}</button>`).join("")}</div>
          <div class="seg" role="group" aria-label="Period">${[[1, "1 hour"], [6, "6 hours"], [24, "24 hours"]].map(([h, l]) => `<button data-h="${h}">${l}</button>`).join("")}</div>
        </div></div>
      <div class="chart-box" style="height:260px"><canvas id="me-chart" role="img" aria-label="My trend chart"></canvas><div class="chart-empty hidden" id="me-empty">No readings in this period yet.</div></div>
      <p class="dim" style="padding:0 16px 14px;font-size:12px">Shaded areas show the ranges where WardOS alerts your care team. Gaps mean your band wasn't sending data.</p>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><div class="card-head"><h2>My band</h2></div><div class="card-body"><dl class="kv" id="me-device"></dl></div></div>
      <div class="card"><div class="card-head"><h2>Updates</h2></div><div class="card-body" id="me-notes"></div></div>
    </div>
    <p class="dim" style="margin-top:16px;font-size:12px">These readings come from a wearable monitor and are reviewed by your care team. They are not a diagnosis. If you feel unwell, use your call button.</p>`;

  const canvas = $("#me-chart", el);
  let chart = vitalChart(canvas, chartKey);

  async function loadChart() {
    const p = me();
    if (!p) return;
    try {
      const data = await api(`/api/patients/${p.id}/vitals?hours=${range}&maxPoints=300`);
      setChartData(chart, chartKey, data.points, { gapMs: Math.max(15000, range * 3600000 / 300 * 3) });
      $("#me-empty", el).classList.toggle("hidden", data.points.length > 0);
    } catch { /* offline: keep chart */ }
  }
  const pressed = () => {
    $$("[data-k]", el).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.k === chartKey)));
    $$("[data-h]", el).forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.h) === range)));
  };
  $$("[data-k]", el).forEach(b => b.addEventListener("click", () => { chartKey = b.dataset.k; chart = vitalChart(canvas, chartKey); pressed(); loadChart(); }));
  $$("[data-h]", el).forEach(b => b.addEventListener("click", () => { range = Number(b.dataset.h); pressed(); loadChart(); }));
  pressed();

  const me = () => ctx.store.patientList[0];

  function render() {
    const p = me();
    if (!p) {
      $("#me-status", el).innerHTML = `<div class="ring">${icon("info")}</div><div><h2>Connecting…</h2><p>Loading your monitoring data.</p></div>`;
      return;
    }
    const first = p.name.split(" ")[0];
    $("#me-hello", el).textContent = `Hello, ${first}`;
    $("#me-place", el).textContent = `${p.ward} · Bed ${p.bed}${p.careTeam?.[0] ? ` · Care: ${p.careTeam[0].name}` : ""}`;
    $("#me-updated", el).innerHTML = p.lastSeen ? `Last reading <span data-ago="${p.lastSeen}">${timeAgo(p.lastSeen)}</span>` : "No readings yet";

    const [title, text] = PLAIN[p.status] ?? PLAIN.offline;
    const statusEl = $("#me-status", el);
    statusEl.className = `me-status ${p.status}`;
    statusEl.innerHTML = `<div class="ring">${icon(p.status === "ok" ? "shield" : p.status === "critical" ? "bell" : p.status === "warning" ? "alert" : "wifiOff")}</div>
      <div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;

    const live = p.deviceStatus === "online";
    $("#me-vitals", el).innerHTML = ["hr", "spo2", "temp"].map(k => {
      const level = vitalLevel(p, k);
      const cls = !live ? "stale" : level === "crit" ? "crit" : level === "warn" ? "warn" : "";
      const word = !live ? "Not available right now" : level ? "Outside usual range - your team is aware" : "Within usual range";
      return `<div class="vital-card ${cls}">
        <div class="lbl"><span>${VITAL_NAMES[k]}</span></div>
        <div class="val">${live ? fmtVital(p.vitals[k], k) : "--"}<small>${UNITS[k]}</small></div>
        <div class="plain">${esc(word)}</div>
        <div class="range">${esc(VITAL_HELP[k])}</div>
      </div>`;
    }).join("");

    const deviceText = {
      online: "Connected and sending readings", offline: "Not sending data", removed: "Sensor not touching skin",
      "no-data": "Waiting for first reading", "link-lost": "Hospital monitoring link interrupted", unassigned: "No band assigned yet"
    };
    $("#me-device", el).innerHTML = `
      <dt>Band</dt><dd>${esc(p.deviceId ?? "--")}</dd>
      <dt>Status</dt><dd>${esc(deviceText[p.deviceStatus] ?? p.deviceStatus)}</dd>
      <dt>Last reading</dt><dd>${p.lastSeen ? fmtTime(p.lastSeen, true) : "--"}</dd>
      <dt>Admitted</dt><dd>${fmtDate(p.admittedAt)}</dd>`;

    const alerts = ctx.store.openAlerts;
    $("#me-notes", el).innerHTML = alerts.length
      ? alerts.map(a => `<div class="note-item" style="margin-bottom:8px"><div class="h"><span>${a.acknowledged ? "Seen by your care team" : "Your care team has been notified"}</span><span>${fmtTime(a.createdAt)}</span></div>
          <p>${esc({ HR: "Heart rate", SPO2: "Oxygen level", TEMP: "Temperature", DEVICE: "Your band", EMERGENCY: "Emergency signal", ANOMALY: "Signal quality" }[a.vital] ?? "Monitoring")} needed attention.</p></div>`).join("")
      : `<div class="empty" style="padding:20px">${icon("shield")}<span>No updates right now.</span></div>`;
  }

  let firstLoad = true;
  const off = ctx.store.on(type => {
    render();
    if (firstLoad && me()) { firstLoad = false; loadChart(); }
  });
  render();
  if (me()) { firstLoad = false; loadChart(); }
  const timer = setInterval(loadChart, 30000);
  return () => { off(); clearInterval(timer); chart?.destroy(); };
}

await startApp({
  role: "patient",
  title: "Patient portal",
  defaultView: "home",
  nav: [{ id: "home", label: "My health", icon: "heart" }],
  views: { home: homeView }
});
