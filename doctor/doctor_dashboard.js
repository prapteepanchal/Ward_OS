// ============================================================
// WardOS - Clinician workspace (doctor)
// Triage-first: who needs review, why, and what changed.
// Shares the same live data as the nurse view, scoped to the
// doctor's care team by the server.
// ============================================================

import { startApp } from "../app/shell.js";
import { monitorView, alertsView, reportsView, devicesView, openPatientDetail, metricCard, wardMetrics, alertItem } from "../app/views.js";
import { api } from "../app/api.js";
import { icon } from "../app/icons.js";
import { vitalChart, setChartData } from "../app/ui.js";
import { esc, statusChip, fmtVital, vitalLevel, statusReason, timeAgo, SEVERITY_RANK, $, $$ } from "../app/util.js";
import { acknowledge } from "../app/shell.js";

function triageView(el, ctx) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Good ${greeting()}, ${esc(ctx.me.name.replace(/^Dr\.?\s*/i, "Dr. "))}</h1>
      <p>Your patients ranked by clinical priority. Thresholds raise monitoring alerts only - not diagnoses.</p></div></div>
    <div class="metrics" id="d-metrics"></div>
    <div class="split">
      <div class="card">
        <div class="card-head"><h2>Triage list</h2><span class="sub">critical → warning → connectivity → stable</span></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Patient</th><th>Status</th><th style="text-align:right">HR</th><th style="text-align:right">SpO₂</th><th style="text-align:right">Temp</th><th>Why</th><th>Last data</th></tr></thead><tbody id="triage"></tbody></table></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card"><div class="card-head"><h2>Needs review</h2><span class="sub" id="rev-count"></span></div><div id="review" class="alert-list" style="max-height:440px;overflow:auto"></div></div>
        <div class="card"><div class="card-head"><h2>Focus trend</h2><span class="sub" id="focus-name">select a patient</span></div>
          <div class="seg" style="margin:10px 12px 0" role="group" aria-label="Vital"><button data-k="hr" aria-pressed="true">HR</button><button data-k="spo2">SpO₂</button><button data-k="temp">Temp</button></div>
          <div class="chart-box sm"><canvas id="focus-chart" role="img" aria-label="Last hour trend for focused patient"></canvas></div></div>
      </div>
    </div>`;

  let focus = null;
  let focusKey = "hr";
  const chartCanvas = $("#focus-chart", el);
  let chart = vitalChart(chartCanvas, focusKey, { compact: true });

  async function loadFocus() {
    if (!focus) return;
    const p = ctx.store.patients.get(focus);
    $("#focus-name", el).textContent = p ? `${p.name} · last hour` : "";
    try {
      const data = await api(`/api/patients/${focus}/vitals?hours=1&maxPoints=240`);
      setChartData(chart, focusKey, data.points);
    } catch { /* keep previous */ }
  }
  $$("[data-k]", el).forEach(b => b.addEventListener("click", () => {
    focusKey = b.dataset.k;
    $$("[data-k]", el).forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    chart = vitalChart(chartCanvas, focusKey, { compact: true });
    loadFocus();
  }));

  function render() {
    const patients = ctx.store.patientList.slice().sort((a, b) => (SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status]) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    const m = wardMetrics(patients, ctx.store.openAlerts);
    setHtml($("#d-metrics", el),
      metricCard("My patients", m.total, "info", "users", `${new Set(patients.map(p => p.wardId)).size} ward(s)`) +
      metricCard("Critical", m.critical, m.critical ? "crit" : "mute", "siren", "immediate review") +
      metricCard("Warning", m.warning, m.warning ? "warn" : "mute", "alert", "outside limits") +
      metricCard("Stable", m.stable, "ok", "shield", "within limits") +
      metricCard("Not monitored", m.offline + m.removed, m.offline + m.removed ? "warn" : "mute", "wifiOff", "offline / removed / no device") +
      metricCard("Open alerts", ctx.store.openAlerts.length, m.unack ? "crit" : "mute", "bell", `${m.unack} unacknowledged`));

    setHtml($("#triage", el), patients.length ? patients.map(p => {
      const cell = k => {
        const l = vitalLevel(p, k);
        return `<td class="num ${l === "crit" ? "crit" : l === "warn" ? "warn" : l === "stale" ? "dim" : ""}">${fmtVital(p.vitals[k], k)}</td>`;
      };
      return `<tr class="clickable" data-patient="${p.id}" tabindex="0" ${p.id === focus ? 'style="background:rgba(35,43,58,.7)"' : ""}>
        <td><strong style="font-weight:500">${esc(p.name)}</strong><div class="dim mono" style="font-size:11.5px">${esc(p.wardId)} · bed ${esc(p.bed)} · ${esc(p.mrn)}</div></td>
        <td>${statusChip(p.status)}</td>${cell("hr")}${cell("spo2")}${cell("temp")}
        <td class="muted" style="font-size:12.5px;max-width:260px">${esc(statusReason(p)) || '<span class="dim">--</span>'}</td>
        <td class="mono dim">${p.lastSeen ? `<span data-ago="${p.lastSeen}">${timeAgo(p.lastSeen)}</span>` : "--"}</td></tr>`;
    }).join("") : `<tr><td colspan="7"><div class="empty">${icon("users")}<strong>No patients under your care</strong></div></td></tr>`);

    const open = ctx.store.openAlerts;
    $("#rev-count", el).textContent = `${open.length} open`;
    const changed = setHtml($("#review", el), open.length ? open.map(a => alertItem(a, "doctor")).join("")
      : `<div class="empty">${icon("shield")}<strong>Nothing awaiting review</strong></div>`);
    if (!changed) { if (!focus && patients.length) { focus = patients[0].id; loadFocus(); } return; }
    $$("#review [data-ack]", el).forEach(b => b.addEventListener("click", () => acknowledge(b, b.dataset.ack)));
    $$("#review [data-open]", el).forEach(b => b.addEventListener("click", () => ctx.openPatient(Number(b.dataset.open))));
    $$("#review [data-resolve]", el).forEach(b => b.addEventListener("click", () => ctx.navigate("alerts")));

    if (!focus && patients.length) { focus = patients[0].id; loadFocus(); }
  }

  el.addEventListener("click", e => {
    const row = e.target.closest("tr[data-patient]");
    if (!row) return;
    const id = Number(row.dataset.patient);
    if (e.detail === 2 || focus === id) return ctx.openPatient(id);
    focus = id;
    render();
    loadFocus();
  });
  el.addEventListener("dblclick", e => { const row = e.target.closest("tr[data-patient]"); if (row) ctx.openPatient(Number(row.dataset.patient)); });
  el.addEventListener("keydown", e => { const row = e.target.closest("tr[data-patient]"); if (row && e.key === "Enter") ctx.openPatient(Number(row.dataset.patient)); });

  let pending = false;
  const off = ctx.store.on(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  });
  const timer = setInterval(loadFocus, 10000);
  render();
  return () => { off(); clearInterval(timer); chart?.destroy(); };
}

/** Replace markup only when it changed (keeps animations calm). */
function setHtml(node, html) {
  if (node.dataset.html === html) return false;
  node.innerHTML = html;
  node.dataset.html = html;
  if (node.classList.contains("metrics") && !node.classList.contains("settled")) setTimeout(() => node.classList.add("settled"), 700);
  return true;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

const ctx = await startApp({
  role: "doctor",
  title: "Clinician workspace",
  defaultView: "triage",
  nav: [
    { id: "triage", label: "Triage", icon: "pulse", badge: s => ({ n: s.patientList.filter(p => p.status === "critical").length, cls: "crit" }) },
    { id: "patients", label: "My patients", icon: "users" },
    { id: "alerts", label: "Alert review", icon: "bell", badge: s => ({ n: s.unacknowledged.length, cls: s.unacknowledged.some(a => a.severity === "CRITICAL") ? "crit" : "" }) },
    { id: "devices", label: "Devices", icon: "device" },
    { id: "reports", label: "Reports", icon: "report" }
  ],
  views: {
    triage: triageView,
    patients: (el, c) => monitorView(el, c, { title: "My patients", subtitle: "Click a patient for trends, raw-vs-cleaned signal, alert history and notes.", defaultView: "table", showMetrics: false }),
    alerts: alertsView,
    devices: devicesView,
    reports: reportsView
  }
});

if (ctx) ctx.openPatient = id => openPatientDetail(ctx, id);
