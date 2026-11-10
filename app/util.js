// WardOS - formatting & presentation helpers (browser)
import { config } from "../shared/config.js";
import { statusGlyph } from "./icons.js";

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const STATUS = {
  ok: { label: "Stable", word: "STABLE", cls: "ok" },
  warning: { label: "Warning", word: "WARNING", cls: "warning" },
  critical: { label: "Critical", word: "CRITICAL", cls: "critical" },
  offline: { label: "Offline", word: "OFFLINE", cls: "offline" },
  removed: { label: "Sensor removed", word: "REMOVED", cls: "removed" }
};

export const SEVERITY_RANK = { critical: 0, warning: 1, removed: 2, offline: 3, ok: 4 };

export const DEVICE_STATUS = {
  online: "Online",
  offline: "Offline - no data",
  removed: "Sensor removed",
  "no-data": "Awaiting first reading",
  "link-lost": "Broker link lost",
  unassigned: "No device assigned",
  idle: "Registered, idle",
  unregistered: "Detected, not registered"
};

export function statusChip(status, extra = "") {
  const s = STATUS[status] ?? STATUS.offline;
  const pulse = status === "critical" ? "pulse" : "";
  return `<span class="status ${s.cls} ${extra}" role="status">${statusGlyph(status, pulse)}${s.label}</span>`;
}

export function severityChip(severity) {
  const map = { CRITICAL: "critical", WARNING: "warning", INFO: "info" };
  const st = map[severity] ?? "neutral";
  return `<span class="status ${st}">${statusGlyph(st === "neutral" ? "offline" : st)}${esc(String(severity).charAt(0) + String(severity).slice(1).toLowerCase())}</span>`;
}

export function lifecycleChip(status) {
  const map = { NEW: "critical", ACKNOWLEDGED: "info", RESOLVED: "ok", EXPIRED: "neutral" };
  const label = { NEW: "New", ACKNOWLEDGED: "Acknowledged", RESOLVED: "Resolved", EXPIRED: "Auto-cleared" }[status] ?? status;
  return `<span class="status ${map[status] ?? "neutral"}">${esc(label)}</span>`;
}

/** Never show missing values as zero. */
export function fmtVital(value, key) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "--";
  return key === "temp" ? Number(value).toFixed(1) : String(Math.round(Number(value)));
}

export const UNITS = { hr: "BPM", spo2: "%", temp: "°C" };
export const VITAL_NAMES = { hr: "Heart rate", spo2: "SpO₂", temp: "Temperature" };

export function vitalLevel(patient, key) {
  if (patient.staleVitals || patient.deviceStatus !== "online") return "stale";
  if (patient.flags?.critical?.includes(key)) return "crit";
  if (patient.flags?.warning?.includes(key)) return "warn";
  return "";
}

export function normalRange(key) {
  const t = config.thresholds[key];
  if (key === "spo2") return `alert < ${t.warningLow}%`;
  if (key === "hr") return `alert < ${t.warningLow} / > ${t.warningHigh} BPM`;
  return `alert > ${t.warningHigh.toFixed(1)}°C`;
}

export function timeAgo(ms, now = Date.now()) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtTime(ms, withDate = false) {
  if (!ms) return "--";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (!withDate) return time;
  return `${d.toLocaleDateString([], { day: "2-digit", month: "short" })} ${time}`;
}

export function fmtDate(ms) {
  if (!ms) return "--";
  return new Date(ms).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

export function initials(name) {
  return String(name ?? "?").replace(/^dr\.?\s+/i, "").split(/\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase();
}

/** One-line explanation of why a patient has their status. */
export function statusReason(p) {
  if (p.deviceStatus === "unassigned") return "No wearable assigned";
  if (p.deviceStatus === "removed") return "Band reports sensor removed";
  if (p.deviceStatus === "link-lost") return "Monitoring link down - status unknown";
  if (p.deviceStatus === "no-data") return "Waiting for first reading";
  if (p.deviceStatus === "offline") return `No data since ${fmtTime(p.lastSeen)}`;
  const parts = [];
  if (p.vitals?.emergency === "EMERGENCY") parts.push("Emergency signal from band");
  for (const k of p.flags?.critical ?? []) parts.push(`${VITAL_NAMES[k]} critical`);
  for (const k of p.flags?.warning ?? []) parts.push(`${VITAL_NAMES[k]} out of range`);
  if (!parts.length && p.mlMeta?.anomalyDetected) parts.push("Signal anomaly flagged");
  return parts.join(" · ");
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function $(selector, root = document) { return root.querySelector(selector); }
export function $$(selector, root = document) { return [...root.querySelectorAll(selector)]; }
