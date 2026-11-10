// ============================================================
// WardOS - Report workbook layout (shared)
// File: shared/report_builder.js
//
// Turns plain report data into XLSX sheets. Used by the server
// (authoritative data from the database) and by the browser's
// offline fallback (data from the local IndexedDB cache, which
// is always marked INCOMPLETE).
// ============================================================

import { config } from "./config.js";
import { StateStore } from "./state_store.js";
import { buildXlsx } from "./xlsx.js";

const evaluator = new StateStore({ alertEngine: null });

const STATUS_LABEL = {
  ok: "STABLE", warning: "WARNING", critical: "CRITICAL", offline: "OFFLINE", removed: "REMOVED"
};

const DEVICE_LABEL = {
  online: "Online", offline: "Offline", removed: "Sensor removed", "no-data": "No data yet",
  "link-lost": "Broker link lost", unassigned: "No device"
};

function h(text) { return { v: text, s: "header" }; }
function dt(ms) { return ms ? { v: ms, s: "datetime" } : "--"; }
function num(value, decimals = 0) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return decimals ? { v: Math.round(Number(value) * 10 ** decimals) / 10 ** decimals, s: "decimal" } : Math.round(Number(value));
}

export function vitalStats(readings, key) {
  const values = readings.map(r => r[key]).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  if (!values.length) return { min: null, max: null, avg: null, count: 0 };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    count: values.length
  };
}

export function abnormalRows(readings) {
  const out = [];
  for (const r of readings) {
    if (r.removed) continue;
    const vitals = { hr: r.hr, spo2: r.spo2, temp: r.temp };
    for (const c of evaluator.getCriticalVitals(vitals)) out.push({ ts: r.ts, severity: "CRITICAL", ...c });
    for (const w of evaluator.getWarningVitals(vitals)) out.push({ ts: r.ts, severity: "WARNING", ...w });
  }
  return out;
}

function headerBlock(title, meta, data) {
  const rows = [
    [{ v: title, s: "title" }],
    [{ v: "WardOS - IoMT Patient Monitoring", s: "subtitle" }],
    []
  ];
  for (const [label, value] of meta) rows.push([{ v: label, s: "bold" }, value]);
  rows.push([]);
  if (data.incomplete) {
    rows.push([{ v: "INCOMPLETE DATA", s: "critical" }, data.incompleteReason || "Generated from locally cached data while the WardOS server was unreachable."]);
    rows.push([]);
  }
  rows.push([{ v: "Notice", s: "bold" }, "Monitoring thresholds are configurable alerting limits, not diagnoses. Verify readings clinically."]);
  rows.push([]);
  return rows;
}

function thresholdsRows() {
  const t = config.thresholds;
  return [
    [h("Monitoring thresholds"), h("Warning"), h("Critical")],
    ["Heart rate (BPM)", `< ${t.hr.warningLow} or > ${t.hr.warningHigh}`, `< ${t.hr.criticalLow} or > ${t.hr.criticalHigh}`],
    ["SpO2 (%)", `< ${t.spo2.warningLow}`, `< ${t.spo2.criticalLow}`],
    ["Temperature (°C)", `> ${t.temp.warningHigh}`, `< ${t.temp.criticalLow} or > ${t.temp.criticalHigh}`]
  ];
}

function alertsSheet(alerts, includePatient) {
  const rows = [[
    h("Raised"), ...(includePatient ? [h("Patient"), h("MRN"), h("Bed")] : []),
    h("Severity"), h("Type"), h("Description"), h("Value"), h("Status"),
    h("Acknowledged at"), h("Acknowledged by"), h("Closed at"), h("Closed by"), h("Resolution note")
  ]];
  for (const a of alerts) {
    rows.push([
      dt(a.createdAt),
      ...(includePatient ? [a.patientName ?? "--", a.mrn ?? "--", a.bed ?? "--"] : []),
      { v: a.severity, s: a.severity === "CRITICAL" ? "critical" : a.severity === "WARNING" ? "warning" : "default" },
      a.type,
      a.message ?? "",
      a.value !== null && a.value !== undefined ? `${a.value}${a.unit ?? ""}` : "--",
      a.status,
      dt(a.acknowledgedAt),
      a.acknowledgedByName ?? "--",
      dt(a.resolvedAt ?? a.expiredAt),
      a.status === "EXPIRED" ? "Auto-cleared (not acknowledged)" : (a.resolvedByName ?? "--"),
      a.resolutionNote ?? ""
    ]);
  }
  if (alerts.length === 0) rows.push(["No alerts in this period"]);
  return {
    name: "Alerts",
    freezeRows: 1,
    autoFilter: { headerRow: 1 },
    widths: includePatient ? [20, 20, 10, 6, 10, 16, 60, 10, 14, 20, 20, 20, 20, 30] : [20, 10, 16, 60, 10, 14, 20, 20, 20, 20, 30],
    rows
  };
}

function readingsSheet(readings, { includePatient = false, sampling }) {
  const rows = [[
    h("Time"), ...(includePatient ? [h("Patient"), h("Bed")] : []),
    h("Heart rate (BPM)"), h("SpO2 (%)"), h("Temp (°C)"), h("Emergency"), h("Flag"), h("Source")
  ]];
  for (const r of readings) {
    let flag = "";
    let style = "default";
    if (r.removed) { flag = "Sensor removed"; style = "muted"; }
    else {
      const vitals = { hr: r.hr, spo2: r.spo2, temp: r.temp };
      if (evaluator.getCriticalVitals(vitals).length || r.emergency === "EMERGENCY") { flag = "CRITICAL"; style = "critical"; }
      else if (evaluator.getWarningVitals(vitals).length) { flag = "WARNING"; style = "warning"; }
    }
    rows.push([
      dt(r.ts),
      ...(includePatient ? [r.patientName ?? "--", r.bed ?? "--"] : []),
      num(r.hr), num(r.spo2), num(r.temp, 1),
      r.emergency ?? "--",
      { v: flag, s: style },
      [r.sourcePath, r.anomaly ? "anomaly" : null, r.sim ? "SIMULATED" : null].filter(Boolean).join(" · ") || "--"
    ]);
  }
  if (readings.length === 0) rows.push(["No readings recorded in this period"]);
  return {
    name: sampling === "raw" ? "Vital readings" : "Vital readings (1-min avg)",
    freezeRows: 1,
    autoFilter: { headerRow: 1 },
    widths: includePatient ? [20, 20, 6, 16, 10, 10, 12, 12, 24] : [20, 16, 10, 10, 12, 12, 24],
    rows
  };
}

// ------------------------------------------------------------
// PATIENT REPORT
// ------------------------------------------------------------

export function patientReportSheets(data) {
  const p = data.patient;
  const stats = { hr: vitalStats(data.readings, "hr"), spo2: vitalStats(data.readings, "spo2"), temp: vitalStats(data.readings, "temp") };
  const abnormal = abnormalRows(data.readings);
  const simulated = data.readings.some(r => r.sim);

  const summary = headerBlock(`Patient report - ${p.name}`, [
    ["Patient name", p.name],
    ["Patient ID (MRN)", p.mrn],
    ["Age / sex", `${p.age ?? "--"} / ${p.sex ?? "--"}`],
    ["Ward", p.ward ?? "--"],
    ["Bed", p.bed ?? "--"],
    ["Device ID", p.deviceId ?? "No device assigned"],
    ["Diagnosis / reason", p.diagnosis ?? "--"],
    ["Care team", (p.careTeam ?? []).map(c => `${c.name} (${c.relation})`).join(", ") || "--"],
    ["Admitted", dt(p.admittedAt)],
    ["Report period", `${new Date(data.from).toLocaleString()}  to  ${new Date(data.to).toLocaleString()}`],
    ["Generated at", dt(data.generatedAt)],
    ["Generated by", data.generatedBy ?? "--"],
    ["Data source", data.incomplete ? "Offline browser cache (partial)" : "WardOS server database"],
    ...(simulated ? [["Data origin", { v: "Contains SIMULATED telemetry (WardOS simulator) - not real patient data", s: "warning" }]] : [])
  ], data);

  summary.push([h("Vital"), h("Readings"), h("Min"), h("Average"), h("Max")]);
  summary.push(["Heart rate (BPM)", stats.hr.count, num(stats.hr.min), num(stats.hr.avg), num(stats.hr.max)]);
  summary.push(["SpO2 (%)", stats.spo2.count, num(stats.spo2.min), num(stats.spo2.avg), num(stats.spo2.max)]);
  summary.push(["Temperature (°C)", stats.temp.count, num(stats.temp.min, 1), num(stats.temp.avg, 1), num(stats.temp.max, 1)]);
  summary.push([]);
  summary.push([{ v: "Abnormal readings", s: "bold" }, abnormal.length]);
  summary.push([{ v: "Alerts in period", s: "bold" }, data.alerts.length]);
  summary.push([{ v: "Critical alerts", s: "bold" }, data.alerts.filter(a => a.severity === "CRITICAL").length]);
  summary.push([]);
  summary.push(...thresholdsRows());

  const abnormalSheet = {
    name: "Abnormal readings",
    freezeRows: 1,
    autoFilter: { headerRow: 1 },
    widths: [20, 12, 16, 10, 10, 12],
    rows: [
      [h("Time"), h("Severity"), h("Vital"), h("Value"), h("Limit"), h("Direction")],
      ...abnormal.map(a => [
        dt(a.ts),
        { v: a.severity, s: a.severity === "CRITICAL" ? "critical" : "warning" },
        a.vital,
        `${a.key === "temp" ? Number(a.value).toFixed(1) : a.value} ${a.unit}`,
        `${a.threshold} ${a.unit}`,
        a.direction
      ]),
      ...(abnormal.length ? [] : [["No abnormal readings in this period"]])
    ]
  };

  return [
    { name: "Summary", widths: [26, 60, 12, 12, 12], rows: summary },
    readingsSheet(data.readings, { sampling: data.sampling }),
    abnormalSheet,
    alertsSheet(data.alerts, false)
  ];
}

// ------------------------------------------------------------
// WARD REPORT
// ------------------------------------------------------------

export function wardReportSheets(data) {
  const patients = data.patients;
  const count = status => patients.filter(p => p.status === status).length;
  const online = patients.filter(p => p.deviceStatus === "online").length;
  const offline = patients.filter(p => ["offline", "no-data", "link-lost", "unassigned"].includes(p.deviceStatus)).length;
  const openAlerts = data.alerts.filter(a => a.status === "NEW" || a.status === "ACKNOWLEDGED").length;

  const summary = headerBlock(`Ward report - ${data.ward.name}`, [
    ["Ward", `${data.ward.name} (${data.ward.id})`],
    ["Report period", `${new Date(data.from).toLocaleString()}  to  ${new Date(data.to).toLocaleString()}`],
    ["Generated at", dt(data.generatedAt)],
    ["Generated by", data.generatedBy ?? "--"],
    ["Scope", data.scopeNote ?? "All patients admitted to this ward"],
    ["Data source", data.incomplete ? "Offline browser cache (partial)" : "WardOS server database"]
  ], data);

  summary.push([h("Ward status (at generation)"), h("Count")]);
  summary.push(["Total patients", patients.length]);
  summary.push(["Devices online", online]);
  summary.push(["Devices offline / not reporting", offline]);
  summary.push(["Sensor removed", count("removed")]);
  summary.push([{ v: "Critical patients", s: "critical" }, count("critical")]);
  summary.push([{ v: "Warning patients", s: "warning" }, count("warning")]);
  summary.push(["Stable patients", count("ok")]);
  summary.push(["Open alerts", openAlerts]);
  summary.push(["Alerts raised in period", data.alerts.length]);
  summary.push([]);
  summary.push(...thresholdsRows());

  const patientRows = [[
    h("Bed"), h("Patient"), h("MRN"), h("Device"), h("Status"), h("Device status"), h("Last data"),
    h("HR now"), h("SpO2 now"), h("Temp now"),
    h("HR min"), h("HR avg"), h("HR max"),
    h("SpO2 min"), h("SpO2 avg"),
    h("Temp max"), h("Abnormal readings"), h("Alerts")
  ]];

  for (const p of patients) {
    const readings = data.readingsByPatient?.[p.id] ?? [];
    const hr = vitalStats(readings, "hr");
    const spo2 = vitalStats(readings, "spo2");
    const temp = vitalStats(readings, "temp");
    const statusLabel = STATUS_LABEL[p.status] ?? String(p.status).toUpperCase();
    patientRows.push([
      p.bed ?? "--", p.name, p.mrn, p.deviceId ?? "--",
      { v: statusLabel, s: p.status === "critical" ? "critical" : p.status === "warning" ? "warning" : "default" },
      DEVICE_LABEL[p.deviceStatus] ?? p.deviceStatus,
      dt(p.lastSeen),
      num(p.vitals?.hr), num(p.vitals?.spo2), num(p.vitals?.temp, 1),
      num(hr.min), num(hr.avg), num(hr.max),
      num(spo2.min), num(spo2.avg),
      num(temp.max, 1),
      abnormalRows(readings).length,
      data.alerts.filter(a => String(a.patientId) === String(p.id)).length
    ]);
  }

  const allReadings = [];
  for (const p of patients) {
    for (const r of data.readingsByPatient?.[p.id] ?? []) allReadings.push({ ...r, patientName: p.name, bed: p.bed });
  }
  allReadings.sort((a, b) => a.ts - b.ts);

  return [
    { name: "Summary", widths: [32, 60], rows: summary },
    { name: "Patients", freezeRows: 1, autoFilter: { headerRow: 1 }, widths: [6, 20, 10, 8, 10, 16, 20, 8, 9, 9, 8, 8, 8, 9, 9, 9, 10, 8], rows: patientRows },
    readingsSheet(allReadings, { includePatient: true, sampling: data.sampling }),
    alertsSheet(data.alerts, true)
  ];
}

export async function buildPatientReport(data, options) {
  return buildXlsx(patientReportSheets(data), { title: `WardOS patient report ${data.patient.mrn}`, ...options });
}

export async function buildWardReport(data, options) {
  return buildXlsx(wardReportSheets(data), { title: `WardOS ward report ${data.ward.id}`, ...options });
}

export function reportFilename(kind, id, at = Date.now()) {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `WardOS_${kind}_${String(id).replace(/[^A-Za-z0-9-]/g, "")}_${stamp}.xlsx`;
}
