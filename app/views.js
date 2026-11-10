// ============================================================
// WardOS - Screens shared by the nurse and doctor dashboards.
// Every number shown here is derived from live/stored state.
// ============================================================

import { api, download, saveBlob, ApiError } from "./api.js";
import { icon } from "./icons.js";
import { toast, modal, confirmDialog, vitalChart, setChartData } from "./ui.js";
import { acknowledge } from "./shell.js";
import {
  esc, statusChip, severityChip, lifecycleChip, fmtVital, UNITS, VITAL_NAMES, vitalLevel, normalRange,
  timeAgo, fmtTime, fmtDate, statusReason, SEVERITY_RANK, DEVICE_STATUS, debounce, $, $$
} from "./util.js";
import { buildPatientReport, buildWardReport, reportFilename } from "../shared/report_builder.js";
import { browserDeflate, XLSX_MIME } from "../shared/xlsx.js";

// ------------------------------------------------------------
// Metrics
// ------------------------------------------------------------

export function wardMetrics(patients, alerts) {
  const by = s => patients.filter(p => p.status === s).length;
  return {
    total: patients.length,
    online: patients.filter(p => p.deviceStatus === "online").length,
    offline: patients.filter(p => ["offline", "no-data", "link-lost", "unassigned"].includes(p.deviceStatus)).length,
    removed: by("removed"),
    critical: by("critical"),
    warning: by("warning"),
    stable: by("ok"),
    unack: alerts.filter(a => a.status === "NEW").length
  };
}

export function metricCard(label, value, cls, iconName, sub, filter) {
  return `<div class="metric ${cls} ${filter ? "clickable" : ""}" ${filter ? `data-filter="${filter}" role="button" tabindex="0"` : ""}>
    <div class="k">${icon(iconName)}${esc(label)}</div>
    <div class="v">${value}</div>
    <div class="s">${esc(sub)}</div>
  </div>`;
}

// ------------------------------------------------------------
// Patient tile / row
// ------------------------------------------------------------

function vitalMini(p, key) {
  const level = vitalLevel(p, key);
  const cls = level === "crit" ? "crit" : level === "warn" ? "warn" : level === "stale" ? "stale" : "";
  return `<div class="vital-mini ${cls}"><div class="lbl">${key === "spo2" ? "SpO₂" : key.toUpperCase()}</div>
    <div class="val" data-v="${p.id}-${key}">${fmtVital(p.vitals[key], key)}<small>${UNITS[key]}</small></div></div>`;
}

export function patientTile(p, i = 0) {
  return `<button class="tile ${p.status}" data-patient="${p.id}" style="animation-delay:${Math.min(i, 12) * 25}ms"
      aria-label="${esc(p.name)}, bed ${esc(p.bed ?? "")}, status ${esc(p.status)}">
    <div class="tile-head">
      <div style="min-width:0"><div class="bed">${esc(p.ward ?? "")} · BED ${esc(p.bed ?? "--")}</div>
        <h3>${esc(p.name)}</h3><div class="ids">${esc(p.mrn)}${p.age ? ` · ${p.age}${esc(p.sex ?? "")}` : ""}</div></div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">${statusChip(p.status)}${p.sim ? '<span class="tag sim">SIM</span>' : ""}</div>
    </div>
    <div class="vitals-row">${vitalMini(p, "hr")}${vitalMini(p, "spo2")}${vitalMini(p, "temp")}</div>
    <div class="reason">${esc(statusReason(p))}</div>
    <div class="tile-foot">
      <span class="dev ${esc(p.deviceStatus)}"><span class="d"></span>${p.deviceId ? `DEV ${esc(p.deviceId)}` : "NO DEVICE"}</span>
      <span title="${esc(fmtTime(p.lastSeen, true))}">${p.lastSeen ? `<span data-ago="${p.lastSeen}">${timeAgo(p.lastSeen)}</span>` : "--"}</span>
    </div>
  </button>`;
}

function vitalCell(p, key) {
  const level = vitalLevel(p, key);
  return `<td class="num ${level === "crit" ? "crit" : level === "warn" ? "warn" : level === "stale" ? "dim" : ""}">${fmtVital(p.vitals[key], key)}</td>`;
}

export function patientRow(p) {
  return `<tr class="clickable" data-patient="${p.id}" tabindex="0">
    <td class="mono">${esc(p.bed ?? "--")}</td>
    <td><strong style="font-weight:500">${esc(p.name)}</strong><div class="dim mono" style="font-size:11.5px">${esc(p.mrn)} · ${esc(p.ward ?? "")}</div></td>
    <td>${statusChip(p.status)}</td>
    ${vitalCell(p, "hr")}${vitalCell(p, "spo2")}${vitalCell(p, "temp")}
    <td class="mono">${p.deviceId ? esc(p.deviceId) : "--"}</td>
    <td class="muted" style="font-size:12.5px">${esc(DEVICE_STATUS[p.deviceStatus] ?? p.deviceStatus)}</td>
    <td class="mono dim">${p.lastSeen ? `<span data-ago="${p.lastSeen}">${timeAgo(p.lastSeen)}</span>` : "--"}</td>
  </tr>`;
}

const TABLE_HEAD = `<thead><tr><th>Bed</th><th>Patient</th><th>Status</th><th style="text-align:right">HR</th><th style="text-align:right">SpO₂</th><th style="text-align:right">Temp</th><th>Device</th><th>Connectivity</th><th>Last data</th></tr></thead>`;

// ------------------------------------------------------------
// MONITORING VIEW (grid / table, search, filters, sort)
// ------------------------------------------------------------

export function monitorView(el, ctx, { title, subtitle, showMetrics = true, defaultView = "grid", extraActions = "" }) {
  const state = {
    q: "", status: "all", ward: "all", conn: "all",
    sort: "severity",
    view: localStorage.getItem("wardos-view") || defaultView
  };

  el.innerHTML = `
    <div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="actions">${extraActions}</div></div>
    ${showMetrics ? `<div class="metrics" id="metrics">${Array.from({ length: 7 }, () => '<div class="skeleton sk-metric"></div>').join("")}</div>` : ""}
    <div class="toolbar">
      <label class="search"><span class="sr-only">Search patients</span>${icon("search")}<input class="input" id="q" placeholder="Search name, patient ID, bed or device" autocomplete="off"></label>
      <div class="seg" id="status-seg" role="group" aria-label="Filter by status"></div>
      <select class="select" id="ward-f" aria-label="Filter by ward"></select>
      <select class="select" id="conn-f" aria-label="Filter by device connectivity">
        <option value="all">All devices</option><option value="online">Online</option><option value="offline">Offline / no data</option><option value="removed">Sensor removed</option><option value="unassigned">No device</option>
      </select>
      <select class="select" id="sort-f" aria-label="Sort">
        <option value="severity">Sort: severity</option><option value="updated">Sort: latest update</option><option value="bed">Sort: bed</option><option value="name">Sort: name</option>
      </select>
      <div class="seg" role="group" aria-label="Layout">
        <button data-view="grid" aria-label="Grid view" title="Grid">${icon("grid")}</button>
        <button data-view="table" aria-label="Table view" title="Table">${icon("list")}</button>
      </div>
    </div>
    <div id="patients"><div class="tiles">${Array.from({ length: 6 }, () => '<div class="skeleton sk-tile"></div>').join("")}</div></div>`;

  const q = $("#q", el);
  q.addEventListener("input", debounce(() => { state.q = q.value.trim().toLowerCase(); render(true); }, 120));
  $("#ward-f", el).addEventListener("change", e => { state.ward = e.target.value; render(true); });
  $("#conn-f", el).addEventListener("change", e => { state.conn = e.target.value; render(true); });
  $("#sort-f", el).addEventListener("change", e => { state.sort = e.target.value; render(true); });
  $$("[data-view]", el).forEach(b => b.addEventListener("click", () => {
    state.view = b.dataset.view;
    try { localStorage.setItem("wardos-view", state.view); } catch { /* ignore */ }
    render(true);
  }));
  el.addEventListener("click", e => {
    const target = e.target.closest("[data-patient]");
    if (target) ctx.openPatient(Number(target.dataset.patient));
    const metric = e.target.closest("[data-filter]");
    if (metric) applyMetricFilter(metric.dataset.filter);
  });
  el.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const target = e.target.closest("tr[data-patient], [data-filter]");
    if (target?.dataset.patient) ctx.openPatient(Number(target.dataset.patient));
    else if (target?.dataset.filter) applyMetricFilter(target.dataset.filter);
  });

  function applyMetricFilter(f) {
    if (["critical", "warning", "ok"].includes(f)) { state.status = f; state.conn = "all"; }
    else if (f === "online" || f === "offline") { state.conn = f; state.status = "all"; }
    else if (f === "all") { state.status = "all"; state.conn = "all"; }
    else if (f === "alerts") return ctx.navigate("alerts");
    $("#conn-f", el).value = state.conn;
    render(true);
  }

  function filtered() {
    const list = ctx.store.patientList.filter(p => {
      if (state.q) {
        const hay = `${p.name} ${p.mrn} ${p.bed} ${p.deviceId ?? ""} ${p.ward}`.toLowerCase();
        if (!hay.includes(state.q)) return false;
      }
      if (state.status !== "all" && p.status !== state.status) return false;
      if (state.ward !== "all" && p.wardId !== state.ward) return false;
      if (state.conn === "online" && p.deviceStatus !== "online") return false;
      if (state.conn === "offline" && !["offline", "no-data", "link-lost"].includes(p.deviceStatus)) return false;
      if (state.conn === "removed" && p.deviceStatus !== "removed") return false;
      if (state.conn === "unassigned" && p.deviceStatus !== "unassigned") return false;
      return true;
    });
    const bedCmp = (a, b) => String(a.wardId).localeCompare(String(b.wardId)) || String(a.bed).localeCompare(String(b.bed), undefined, { numeric: true });
    list.sort({
      severity: (a, b) => (SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status]) || bedCmp(a, b),
      updated: (a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
      bed: bedCmp,
      name: (a, b) => a.name.localeCompare(b.name)
    }[state.sort]);
    return list;
  }

  let lastStructure = "";
  function render(force = false) {
    const all = ctx.store.patientList;
    if (!ctx.store.ready && !ctx.store.fromCache) return;

    // Metrics
    if (showMetrics) {
      const m = wardMetrics(all, ctx.store.openAlerts);
      const metricsEl = $("#metrics", el);
      const metricsHtml =
        metricCard("Patients", m.total, "info", "users", "assigned to you", "all") +
        metricCard("Critical", m.critical, m.critical ? "crit" : "mute", "siren", "need attention now", "critical") +
        metricCard("Warning", m.warning, m.warning ? "warn" : "mute", "alert", "outside limits", "warning") +
        metricCard("Stable", m.stable, "ok", "shield", "within limits", "ok") +
        metricCard("Devices online", m.online, "ok", "device", `of ${m.total} patients`, "online") +
        metricCard("Offline / no data", m.offline + m.removed, m.offline + m.removed ? "warn" : "mute", "wifiOff", `${m.removed} sensor removed`, "offline") +
        metricCard("Unacknowledged", m.unack, m.unack ? "crit" : "mute", "bell", "open alerts", "alerts");
      if (metricsEl.dataset.html !== metricsHtml) {
        metricsEl.innerHTML = metricsHtml;
        metricsEl.dataset.html = metricsHtml;
        if (!metricsEl.classList.contains("settled")) setTimeout(() => metricsEl.classList.add("settled"), 700);
      }
    }

    // Status segment with live counts
    const counts = { all: all.length };
    for (const s of ["critical", "warning", "ok", "offline", "removed"]) counts[s] = all.filter(p => p.status === s).length;
    $("#status-seg", el).innerHTML = [["all", "All"], ["critical", "Critical"], ["warning", "Warning"], ["ok", "Stable"], ["offline", "Offline"], ["removed", "Removed"]]
      .map(([v, l]) => `<button data-status="${v}" aria-pressed="${state.status === v}">${l}<span class="n">${counts[v]}</span></button>`).join("");
    $$("[data-status]", el).forEach(b => b.addEventListener("click", () => { state.status = b.dataset.status; render(true); }));

    const wards = [...new Map(all.map(p => [p.wardId, p.ward])).entries()];
    const wardSel = $("#ward-f", el);
    const wardHtml = `<option value="all">All wards</option>` + wards.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join("");
    if (wardSel.dataset.html !== wardHtml) { wardSel.innerHTML = wardHtml; wardSel.dataset.html = wardHtml; wardSel.value = state.ward; }
    $$("[data-view]", el).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));

    const list = filtered();
    const container = $("#patients", el);
    const structure = `${state.view}|${list.map(p => `${p.id}:${p.status}:${p.deviceStatus}:${(p.flags?.critical ?? []).join()}:${(p.flags?.warning ?? []).join()}`).join(",")}`;

    if (!force && structure === lastStructure) {
      // Same layout: update values in place so the grid doesn't jump.
      for (const p of list) updateValues(container, p);
      return;
    }
    lastStructure = structure;

    if (!list.length) {
      container.innerHTML = `<div class="card empty">${icon("search")}<strong>No patients match these filters</strong>
        <span>${all.length ? "Clear the search or filters to see everyone." : "No patients are assigned to you yet."}</span></div>`;
      return;
    }
    container.innerHTML = state.view === "grid"
      ? `<div class="tiles">${list.map((p, i) => patientTile(p, force ? i : 0)).join("")}</div>`
      : `<div class="card table-wrap"><table class="table">${TABLE_HEAD}<tbody>${list.map(patientRow).join("")}</tbody></table></div>`;
  }

  const off = ctx.store.on(type => { if (["snapshot", "patients", "alert"].includes(type)) render(type === "snapshot"); });
  render(true);
  return () => off();
}

function updateValues(container, p) {
  for (const key of ["hr", "spo2", "temp"]) {
    const node = container.querySelector(`[data-v="${p.id}-${key}"]`);
    if (!node) continue;
    const text = fmtVital(p.vitals[key], key);
    if (node.firstChild?.nodeValue !== text) {
      node.firstChild.nodeValue = text;
      node.classList.remove("flash");
      void node.offsetWidth;
      node.classList.add("flash");
    }
  }
  const foot = container.querySelector(`[data-patient="${p.id}"] [data-ago]`);
  if (foot && p.lastSeen) { foot.dataset.ago = p.lastSeen; foot.textContent = timeAgo(p.lastSeen); }
}

// ------------------------------------------------------------
// PATIENT DETAIL (wide drawer)
// ------------------------------------------------------------

const RANGES = [["15m", 0.25], ["1h", 1], ["6h", 6], ["24h", 24], ["7d", 168]];

export function openPatientDetail(ctx, patientId) {
  const role = ctx.role;
  const backdrop = document.createElement("div");
  backdrop.className = "drawer-backdrop";
  const drawer = document.createElement("aside");
  drawer.className = "drawer wide";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  document.body.append(backdrop, drawer);

  const st = { tab: "trends", range: 1, raw: false, charts: {}, points: [], timer: null };
  const previousFocus = document.activeElement;

  const patient = () => ctx.store.patients.get(patientId);

  async function fetchPatient() {
    return patient() ?? api(`/api/patients/${patientId}`);
  }

  function header(p) {
    const team = (p.careTeam ?? []).map(c => `${esc(c.name)}${c.relation !== "attending" ? " (consult)" : ""}`).join(", ");
    return `
      <div class="drawer-head"><span class="eyebrow">Patient record</span>
        <button class="icon-btn" data-close aria-label="Close patient record">${icon("close")}</button></div>
      <div class="drawer-body">
      <div class="pd-head">
        <div style="min-width:0">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2>${esc(p.name)}</h2>${statusChip(p.status)}${p.sim ? '<span class="tag sim">SIMULATED DATA</span>' : ""}${p.dischargedAt ? '<span class="tag">DISCHARGED</span>' : ""}</div>
          <div class="facts">
            <span><b>ID</b>${esc(p.mrn)}</span><span><b>WARD</b>${esc(p.ward ?? "--")}</span><span><b>BED</b>${esc(p.bed ?? "--")}</span>
            <span><b>AGE</b>${esc(p.age ?? "--")} ${esc(p.sex ?? "")}</span><span><b>DEVICE</b>${esc(p.deviceId ?? "none")}</span>
            <span><b>ADMITTED</b>${fmtDate(p.admittedAt)}</span>
          </div>
          <div class="facts"><span><b>REASON</b>${esc(p.diagnosis ?? "--")}</span><span><b>CARE TEAM</b>${team || "--"}</span></div>
        </div>
        <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" data-act="note">${icon("note")}Note</button>
          ${role === "nurse" ? `<button class="btn" data-act="doctor">${icon("phone")}Request doctor</button>` : ""}
          <button class="btn danger" data-act="codeblue">${icon("siren")}Code blue</button>
          <button class="btn" data-act="report">${icon("download")}Report</button>
          ${role === "nurse" && !p.dischargedAt ? `<button class="btn ghost" data-act="more" aria-haspopup="true">More</button>` : ""}
        </div>
      </div>
      <div class="pd-body">
        <div class="vital-cards" id="pd-vitals"></div>
        <div class="card">
          <div class="tabs" role="tablist">
            ${[["trends", "Trends"], ["alerts", "Alert history"], ["notes", "Notes & actions"], ["device", "Device"]]
              .map(([id, l]) => `<button role="tab" data-tab="${id}" aria-selected="${st.tab === id}">${l}</button>`).join("")}
          </div>
          <div id="pd-tab"></div>
        </div>
      </div></div>`;
  }

  function renderVitals() {
    const p = patient();
    const box = $("#pd-vitals", drawer);
    if (!p || !box) return;
    const stale = ["offline", "link-lost", "no-data", "removed", "unassigned"].includes(p.deviceStatus);
    box.innerHTML = ["hr", "spo2", "temp"].map(key => {
      const level = vitalLevel(p, key);
      const cls = level === "crit" ? "crit" : level === "warn" ? "warn" : stale ? "stale" : "";
      return `<div class="vital-card ${cls}">
        <div class="lbl"><span>${icon(key === "hr" ? "heart" : key === "spo2" ? "drop" : "thermo").replace("<svg", '<svg width="15" height="15"')} ${VITAL_NAMES[key]}</span>
          ${level === "crit" ? '<span class="status critical">CRITICAL</span>' : level === "warn" ? '<span class="status warning">HIGH/LOW</span>' : ""}</div>
        <div class="val">${stale ? "--" : fmtVital(p.vitals[key], key)}<small>${UNITS[key]}</small></div>
        <div class="range">${stale ? esc(DEVICE_STATUS[p.deviceStatus] ?? "") + (p.lastSeen ? ` · last ${fmtTime(p.lastSeen)}` : "") : esc(normalRange(key))}</div>
      </div>`;
    }).join("");
  }

  async function loadHistory() {
    const p = patient();
    try {
      const kind = role === "doctor" && st.raw ? "&kind=all" : "";
      const data = await api(`/api/patients/${patientId}/vitals?hours=${st.range}&maxPoints=500${kind}`);
      st.points = data.points;
      if (st.range >= 1) ctx.store.cacheHistory(patientId, data.points.filter(x => x.kind === "clean"), null);
    } catch (error) {
      const cached = await ctx.store.cachedHistory(patientId);
      st.points = cached?.points ?? [];
      if (error instanceof ApiError && error.status === 0) toast("Offline", "Showing cached history", "warn", 3000);
    }
    const gap = Math.max(15000, (st.range * 3600000) / 500 * 3);
    for (const key of ["hr", "spo2", "temp"]) setChartData(st.charts[key], key, st.points, { gapMs: gap, showRaw: st.raw });
    const empty = $("#chart-empty-note", drawer);
    if (empty) empty.classList.toggle("hidden", st.points.length > 0);
    void p;
  }

  async function renderTab() {
    clearInterval(st.timer);
    const box = $("#pd-tab", drawer);
    $$("[data-tab]", drawer).forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === st.tab)));

    if (st.tab === "trends") {
      box.innerHTML = `
        <div class="toolbar" style="padding:12px 16px 0;margin:0">
          <div class="seg" role="group" aria-label="Time range">${RANGES.map(([l, h]) => `<button data-range="${h}" aria-pressed="${st.range === h}">${l}</button>`).join("")}</div>
          ${role === "doctor" ? `<label class="muted" style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" id="raw-t" ${st.raw ? "checked" : ""}> Overlay raw sensor signal</label>` : ""}
          <span class="dim" style="font-size:12px;margin-left:auto">Shaded bands = alert thresholds · amber dots = signal anomaly · gaps = no data</span>
        </div>
        <p id="chart-empty-note" class="dim hidden" style="padding:8px 16px 0">No readings recorded in this period.</p>
        <div class="grid cols-3" style="padding:8px 4px 4px">
          ${["hr", "spo2", "temp"].map(k => `<div><div class="eyebrow" style="padding:8px 12px 0">${VITAL_NAMES[k]} (${UNITS[k]})</div><div class="chart-box"><canvas id="c-${k}" aria-label="${VITAL_NAMES[k]} trend chart" role="img"></canvas></div></div>`).join("")}
        </div>`;
      for (const k of ["hr", "spo2", "temp"]) st.charts[k] = vitalChart($(`#c-${k}`, box), k, { showRaw: st.raw });
      $$("[data-range]", box).forEach(b => b.addEventListener("click", () => { st.range = Number(b.dataset.range); renderTab(); }));
      $("#raw-t", box)?.addEventListener("change", e => { st.raw = e.target.checked; renderTab(); });
      await loadHistory();
      if (st.range <= 1) st.timer = setInterval(loadHistory, 10000);
    }

    if (st.tab === "alerts") {
      box.innerHTML = `<div class="empty">Loading…</div>`;
      try {
        const alerts = await api(`/api/patients/${patientId}/alerts?hours=168`);
        box.innerHTML = alerts.length ? `<div class="alert-list" style="padding-left:16px">${alerts.map(a => alertItem(a, role)).join("")}</div>`
          : `<div class="empty">${icon("shield")}<strong>No alerts in the last 7 days</strong></div>`;
        wireAlertActions(box, role, () => renderTab());
      } catch (error) {
        box.innerHTML = `<div class="empty">${icon("wifiOff")}<strong>Alert history unavailable</strong><span>${esc(error.message)}</span></div>`;
      }
    }

    if (st.tab === "notes") {
      box.innerHTML = `<div class="empty">Loading…</div>`;
      try {
        const notes = await api(`/api/patients/${patientId}/notes`);
        const label = { NOTE: "Note", DOCTOR_REQUEST: "Doctor requested", CODE_BLUE: "CODE BLUE called" };
        box.innerHTML = `<div class="card-body notes">${notes.length ? notes.map(n => `
          <div class="note-item ${n.kind}"><div class="h"><span>${esc(label[n.kind])} · ${esc(n.author)} (${esc(n.authorRole)})</span><span>${fmtTime(n.createdAt, true)}${n.deviceId ? ` · dev ${esc(n.deviceId)} seq ${esc(n.seq ?? "--")}` : ""}</span></div>
          ${n.text ? `<p>${esc(n.text)}</p>` : ""}</div>`).join("") : `<div class="empty">${icon("note")}<strong>No notes yet</strong><span>Use “Note” to document observations. Every action is audit-logged.</span></div>`}</div>`;
      } catch (error) {
        box.innerHTML = `<div class="empty">${icon("wifiOff")}<strong>Notes unavailable</strong><span>${esc(error.message)}</span></div>`;
      }
    }

    if (st.tab === "device") {
      const p = patient() ?? {};
      box.innerHTML = `<div class="card-body"><dl class="kv">
        <dt>Device ID</dt><dd>${esc(p.deviceId ?? "None assigned")}</dd>
        <dt>Connectivity</dt><dd>${esc(DEVICE_STATUS[p.deviceStatus] ?? p.deviceStatus ?? "--")}</dd>
        <dt>Last telemetry</dt><dd>${p.lastSeen ? `${fmtTime(p.lastSeen, true)} (${timeAgo(p.lastSeen)})` : "--"}</dd>
        <dt>Last reading time</dt><dd>${fmtTime(p.lastReadingAt, true)}</dd>
        <dt>Sequence</dt><dd>${esc(p.seq ?? "--")}</dd>
        <dt>Processing path</dt><dd>${esc(p.mlMeta?.sourcePath ?? "--")}${p.mlMeta?.cleaned === false ? " (raw, uncleaned)" : ""}</dd>
        <dt>Signal anomaly</dt><dd>${p.mlMeta?.anomalyDetected ? "Flagged by the cleaning pipeline - verify at bedside" : "None"}</dd>
        <dt>Emergency flag</dt><dd>${esc(p.vitals?.emergency ?? "--")}</dd>
        <dt>Data origin</dt><dd>${p.sim ? "SIMULATOR (not a real device)" : "Wearable device"}</dd>
      </dl><p class="dim" style="margin-top:14px;font-size:12px">Anomaly flags describe signal quality from the ML cleaning pipeline. They are not clinically validated predictions.</p></div>`;
    }
  }

  async function action(act) {
    const p = await fetchPatient();
    if (act === "note") {
      const ok = await modal({
        title: `Note for ${p.name}`,
        body: `<div class="field"><label for="n-text">Observation</label><textarea class="textarea" id="n-text" name="text" maxlength="1000" required placeholder="What did you observe or do?"></textarea></div>`,
        submitLabel: "Save note",
        onSubmit: async data => {
          if (!data.text.trim()) throw new Error("Write the note first");
          return api(`/api/patients/${patientId}/notes`, { method: "POST", body: { kind: "NOTE", text: data.text } });
        }
      });
      if (ok) { toast("Note saved", "", "ok", 2500); if (st.tab === "notes") renderTab(); }
    }
    if (act === "doctor") {
      const ok = await modal({
        title: "Request doctor review",
        body: `<p class="muted">Records a doctor review request for ${esc(p.name)} (bed ${esc(p.bed)}) with the current device reading attached.</p>
          <div class="field"><label for="d-text">Reason (optional)</label><textarea class="textarea" id="d-text" name="text" maxlength="1000"></textarea></div>`,
        submitLabel: "Request doctor",
        onSubmit: data => api(`/api/patients/${patientId}/notes`, { method: "POST", body: { kind: "DOCTOR_REQUEST", text: data.text } })
      });
      if (ok) toast("Doctor review requested", "Logged in the patient record", "ok");
    }
    if (act === "codeblue") {
      const ok = await confirmDialog("Call code blue?", `This records a CODE BLUE for ${p.name}, bed ${p.bed}, in the patient record and audit log. Follow your hospital's emergency protocol at the same time - WardOS does not page the response team.`, "Record code blue", "solid-danger");
      if (ok) {
        try {
          await api(`/api/patients/${patientId}/notes`, { method: "POST", body: { kind: "CODE_BLUE", text: "" } });
          toast("Code blue recorded", "", "crit");
        } catch (error) { toast("Not recorded", error.message, "crit"); }
      }
    }
    if (act === "report") exportPatientReport(ctx, patientId);
    if (act === "more") {
      const choice = await modal({
        title: "Patient administration",
        hideSubmit: true,
        cancelLabel: "Close",
        body: `<div style="display:flex;flex-direction:column;gap:8px">
          <button type="button" class="btn" data-choice="code">Issue new patient access code</button>
          <button type="button" class="btn danger" data-choice="discharge">Discharge patient…</button></div>`
      });
      void choice;
    }
  }

  // "More" modal buttons are wired via delegation on document.
  const onDocClick = async e => {
    const choice = e.target.closest("[data-choice]")?.dataset.choice;
    if (!choice) return;
    e.target.closest(".modal-backdrop")?.remove();
    const p = await fetchPatient();
    if (choice === "code") {
      try {
        const r = await api(`/api/patients/${patientId}/access-code`, { method: "POST", body: {} });
        await modal({ title: "New access code", hideSubmit: true, cancelLabel: "Done", body: `<p class="muted">Give this code to ${esc(p.name)}. It is shown only once; previous codes and patient sessions stop working.</p><div class="code-reveal">${esc(r.accessCode)}</div>` });
      } catch (error) { toast("Failed", error.message, "crit"); }
    }
    if (choice === "discharge") {
      const ok = await confirmDialog("Discharge patient?", `${p.name} will be removed from active monitoring, their device unassigned and open alerts closed. History stays available for reports.`, "Discharge", "danger");
      if (ok) {
        try {
          await api(`/api/patients/${patientId}/discharge`, { method: "POST", body: {} });
          toast("Patient discharged", p.name, "ok");
          close();
        } catch (error) { toast("Discharge failed", error.message, "crit"); }
      }
    }
  };
  document.addEventListener("click", onDocClick);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener("hashchange", close);
    clearInterval(st.timer);
    for (const c of Object.values(st.charts)) c?.destroy();
    off();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onDocClick);
    backdrop.remove();
    drawer.remove();
    previousFocus?.focus?.();
  }
  const onKey = e => { if (e.key === "Escape" && !document.querySelector(".modal-backdrop")) close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", close);
  window.addEventListener("hashchange", close, { once: true });

  const off = ctx.store.on((type, payload) => {
    if ((type === "patient" && payload.id === patientId) || type === "snapshot") renderVitals();
  });

  (async () => {
    let p;
    try { p = await fetchPatient(); } catch (error) {
      drawer.innerHTML = `<div class="empty" style="height:100%">${icon("alert")}<strong>Patient unavailable</strong><span>${esc(error.message)}</span><button class="btn" data-close>Close</button></div>`;
      drawer.querySelector("[data-close]").addEventListener("click", close);
      return;
    }
    drawer.setAttribute("aria-label", `Patient record: ${p.name}`);
    drawer.innerHTML = header(p);
    drawer.querySelector("[data-close]").addEventListener("click", close);
    $$("[data-act]", drawer).forEach(b => b.addEventListener("click", () => action(b.dataset.act)));
    $$("[data-tab]", drawer).forEach(b => b.addEventListener("click", () => { st.tab = b.dataset.tab; renderTab(); }));
    if (!patient()) ctx.store.patients.set(p.id, p);
    renderVitals();
    renderTab();
    drawer.querySelector("[data-close]").focus();
  })();
}

// ------------------------------------------------------------
// ALERTS
// ------------------------------------------------------------

export function alertItem(a, role) {
  const closed = !a.open;
  const canResolve = a.open && !a.conditionActive && (a.severity !== "CRITICAL" || role === "doctor");
  return `<div class="alert-item ${a.severity} ${closed ? "closed" : ""}">
    <span class="rail"></span>
    <div>
      <div class="top">${severityChip(a.severity)} ${lifecycleChip(a.status)} <span class="tag">${esc(a.type.replace(/_/g, " "))}</span>${a.sim ? '<span class="tag sim">SIM</span>' : ""}</div>
      <div class="msg">${esc(a.message)}</div>
      ${a.note ? `<div class="note">${esc(a.note)}</div>` : ""}
      <div class="meta">
        <span>${fmtTime(a.createdAt, true)}</span>
        ${a.deviceId ? `<span>DEV ${esc(a.deviceId)}</span>` : ""}
        <span>${a.open ? (a.conditionActive ? "Condition active" : `Cleared ${fmtTime(a.conditionClearedAt)}`) : ""}</span>
        ${a.acknowledgedAt ? `<span>Ack ${esc(a.acknowledgedByName ?? "")} ${fmtTime(a.acknowledgedAt)}</span>` : ""}
        ${a.resolvedAt ? `<span>Resolved ${esc(a.resolvedByName ?? "")} ${fmtTime(a.resolvedAt)}${a.resolutionNote ? ` - “${esc(a.resolutionNote)}”` : ""}</span>` : ""}
        ${a.status === "EXPIRED" ? `<span>Auto-cleared ${fmtTime(a.expiredAt)} (never acknowledged)</span>` : ""}
      </div>
    </div>
    <div class="acts">
      ${a.status === "NEW" ? `<button class="btn sm ${a.severity === "CRITICAL" ? "solid-danger" : ""}" data-ack="${esc(a.id)}">${icon("check")}Acknowledge</button>` : ""}
      ${canResolve ? `<button class="btn sm" data-resolve="${esc(a.id)}">${icon("checks")}Resolve</button>` : ""}
      ${a.open && a.conditionActive && a.status !== "NEW" ? `<span class="dim" style="font-size:11.5px">Resolve when readings recover</span>` : ""}
      ${a.open && !a.conditionActive && a.severity === "CRITICAL" && role !== "doctor" ? `<span class="dim" style="font-size:11.5px">Doctor resolves critical</span>` : ""}
      <button class="btn sm ghost" data-open="${a.patientId}">Patient</button>
    </div>
  </div>`;
}

function wireAlertActions(root, role, after, ctx) {
  root.querySelectorAll("[data-ack]").forEach(b => b.addEventListener("click", async () => { await acknowledge(b, b.dataset.ack); after?.(); }));
  root.querySelectorAll("[data-resolve]").forEach(b => b.addEventListener("click", async () => {
    const ok = await modal({
      title: "Resolve alert",
      body: `<p class="muted">Resolving records that the condition is over. Add what was done.</p>
        <div class="field"><label for="r-note">Resolution note</label><textarea class="textarea" id="r-note" name="note" maxlength="500" placeholder="e.g. Repositioned probe, SpO₂ recovered to 96%"></textarea></div>`,
      submitLabel: "Resolve",
      onSubmit: data => api(`/api/alerts/${encodeURIComponent(b.dataset.resolve)}/resolve`, { method: "POST", body: { note: data.note } })
    });
    if (ok) { toast("Alert resolved", "", "ok", 2500); after?.(); }
  }));
  root.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => ctx?.openPatient(Number(b.dataset.open))));
}

export function alertsView(el, ctx) {
  const st = { tab: "open", hours: 24, sev: "all" };
  el.innerHTML = `
    <div class="page-head"><div><h1>Alert centre</h1><p>New → Acknowledged → Resolved. Critical alerts stay open until acknowledged, even if readings recover.</p></div></div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Alert list">
        <button data-t="open">Open</button><button data-t="history">History</button>
      </div>
      <div class="seg" role="group" aria-label="Severity">
        <button data-s="all">All</button><button data-s="CRITICAL">Critical</button><button data-s="WARNING">Warning</button>
      </div>
      <select class="select hidden" id="hist-range" aria-label="History range"><option value="24">Last 24 hours</option><option value="72">Last 3 days</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option></select>
    </div>
    <div class="card" id="alert-box"></div>`;

  const box = $("#alert-box", el);
  $$("[data-t]", el).forEach(b => b.addEventListener("click", () => { st.tab = b.dataset.t; render(); }));
  $$("[data-s]", el).forEach(b => b.addEventListener("click", () => { st.sev = b.dataset.s; render(); }));
  $("#hist-range", el).addEventListener("change", e => { st.hours = Number(e.target.value); render(); });

  async function render() {
    $$("[data-t]", el).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.t === st.tab)));
    $$("[data-s]", el).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.s === st.sev)));
    $("#hist-range", el).classList.toggle("hidden", st.tab !== "history");

    let alerts;
    if (st.tab === "open") {
      alerts = ctx.store.openAlerts;
    } else {
      box.innerHTML = `<div class="empty">Loading history…</div>`;
      try {
        alerts = await api(`/api/alerts?status=all&hours=${st.hours}`);
      } catch (error) {
        box.innerHTML = `<div class="empty">${icon("wifiOff")}<strong>History unavailable offline</strong><span>${esc(error.message)}</span></div>`;
        return;
      }
    }
    if (st.sev !== "all") alerts = alerts.filter(a => a.severity === st.sev);
    box.innerHTML = alerts.length
      ? `<div class="alert-list" style="padding-left:0">${alerts.map(a => alertItem(a, ctx.role)).join("")}</div>`
      : `<div class="empty">${icon("shield")}<strong>${st.tab === "open" ? "No open alerts" : "No alerts in this period"}</strong></div>`;
    wireAlertActions(box, ctx.role, () => { if (st.tab === "history") render(); }, ctx);
  }

  const off = ctx.store.on(type => { if (st.tab === "open" && (type === "alert" || type === "snapshot")) render(); });
  render();
  return () => off();
}

// ------------------------------------------------------------
// DEVICES
// ------------------------------------------------------------

export function devicesView(el, ctx) {
  const manage = ctx.role === "nurse";
  el.innerHTML = `
    <div class="page-head"><div><h1>Devices</h1><p>Wearable bands, their patient assignment and live connectivity.</p></div>
      <div class="actions">${manage ? `<button class="btn primary" id="reg-btn">${icon("plus")}Register device</button>` : ""}</div></div>
    <div class="card table-wrap" id="dev-box"><div class="empty">Loading devices…</div></div>`;

  const box = $("#dev-box", el);

  async function load() {
    let devices;
    try { devices = await api("/api/devices"); } catch (error) {
      box.innerHTML = `<div class="empty">${icon("wifiOff")}<strong>Device list unavailable</strong><span>${esc(error.message)}</span></div>`;
      return;
    }
    if (!devices.length) {
      box.innerHTML = `<div class="empty">${icon("device")}<strong>No devices</strong></div>`;
      return;
    }
    box.innerHTML = `<table class="table"><thead><tr><th>Device</th><th>Label</th><th>Status</th><th>Assigned patient</th><th>Last data</th>${manage ? "<th></th>" : ""}</tr></thead><tbody>
      ${devices.map(d => {
        const stCls = d.status === "online" ? "ok" : d.status === "unregistered" ? "info" : d.status === "removed" ? "warning" : ["offline", "link-lost"].includes(d.status) ? "critical" : "neutral";
        return `<tr>
          <td class="mono">${esc(d.id)}</td>
          <td>${esc(d.label ?? "--")}</td>
          <td><span class="status ${stCls}">${esc(DEVICE_STATUS[d.status] ?? d.status)}</span></td>
          <td>${d.patient ? `<a href="#" data-open="${d.patient.id}">${esc(d.patient.name)}</a> <span class="dim mono" style="font-size:11.5px">${esc(d.patient.wardId)} · bed ${esc(d.patient.bed)}</span>` : '<span class="dim">Unassigned</span>'}</td>
          <td class="mono dim">${d.lastSeen ? `<span data-ago="${d.lastSeen}">${timeAgo(d.lastSeen)}</span>` : "never"}</td>
          ${manage ? `<td style="text-align:right">${!d.registered ? `<button class="btn sm" data-register="${esc(d.id)}">Register</button>`
            : d.patient ? `<button class="btn sm ghost" data-unassign="${esc(d.id)}">Unassign</button>` : `<button class="btn sm" data-assign="${esc(d.id)}">Assign</button>`}</td>` : ""}
        </tr>`;
      }).join("")}</tbody></table>`;

    box.querySelectorAll("[data-open]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); ctx.openPatient(Number(a.dataset.open)); }));
    box.querySelectorAll("[data-register]").forEach(b => b.addEventListener("click", () => register(b.dataset.register)));
    box.querySelectorAll("[data-assign]").forEach(b => b.addEventListener("click", () => assign(b.dataset.assign)));
    box.querySelectorAll("[data-unassign]").forEach(b => b.addEventListener("click", async () => {
      const ok = await confirmDialog("Unassign device?", `Device ${b.dataset.unassign} will stop feeding this patient's record and their open alerts will be closed.`, "Unassign", "danger");
      if (!ok) return;
      try { await api(`/api/devices/${encodeURIComponent(b.dataset.unassign)}/unassign`, { method: "POST", body: {} }); toast("Device unassigned", "", "ok"); load(); }
      catch (error) { toast("Failed", error.message, "crit"); }
    }));
  }

  async function register(id = "") {
    const ok = await modal({
      title: "Register wearable",
      body: `<div class="field"><label for="dv-id">Device ID (as sent in MQTT “device_id”)</label><input class="input mono" id="dv-id" name="id" value="${esc(id)}" required maxlength="64" pattern="[A-Za-z0-9_.:-]+"></div>
        <div class="field"><label for="dv-label">Label</label><input class="input" id="dv-label" name="label" maxlength="60" placeholder="e.g. Band 16"></div>`,
      submitLabel: "Register",
      onSubmit: data => api("/api/devices", { method: "POST", body: data })
    });
    if (ok) { toast("Device registered", "", "ok"); load(); }
  }

  async function assign(id) {
    const free = ctx.store.patientList.filter(p => !p.deviceId).sort((a, b) => String(a.bed).localeCompare(String(b.bed)));
    if (!free.length) return toast("No patient without a device", "Unassign a device first or admit a patient.", "warn");
    const ok = await modal({
      title: `Assign device ${id}`,
      body: `<div class="field"><label for="as-p">Patient</label><select class="select" id="as-p" name="patientId" required>
        ${free.map(p => `<option value="${p.id}">${esc(p.ward)} · bed ${esc(p.bed)} - ${esc(p.name)} (${esc(p.mrn)})</option>`).join("")}</select></div>
        <p class="dim" style="font-size:12.5px">Confirm the band is physically on this patient before assigning.</p>`,
      submitLabel: "Assign",
      onSubmit: data => api(`/api/devices/${encodeURIComponent(id)}/assign`, { method: "POST", body: { patientId: Number(data.patientId) } })
    });
    if (ok) { toast("Device assigned", "", "ok"); load(); }
  }

  $("#reg-btn", el)?.addEventListener("click", () => register());
  load();
  const timer = setInterval(load, 15000);
  return () => clearInterval(timer);
}

// ------------------------------------------------------------
// REPORTS
// ------------------------------------------------------------

export async function exportPatientReport(ctx, patientId, hours = 24) {
  try {
    const name = await download(`/api/reports/patient/${patientId}?hours=${hours}`);
    toast("Report downloaded", name, "ok");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 0) return toast("Report failed", error.message, "crit");
    // Server unreachable -> build from the local cache, marked incomplete.
    const p = ctx.store.patients.get(patientId);
    const cached = await ctx.store.cachedHistory(patientId);
    if (!p) return toast("Report unavailable", "No cached data for this patient on this device", "crit");
    const readings = (cached?.points ?? []).map(x => ({ ...x, emergency: x.emergency ? "EMERGENCY" : "OK", sourcePath: "cached" }));
    const alerts = ctx.store.openAlerts.filter(a => a.patientId === patientId);
    const now = Date.now();
    const bytes = await buildPatientReport({
      patient: p, readings, sampling: "cached", alerts, from: readings[0]?.ts ?? now, to: cached?.savedAt ?? now,
      generatedAt: now, generatedBy: `${ctx.me.name} (${ctx.role}) - offline`,
      incomplete: true,
      incompleteReason: `Generated in the browser while the WardOS server was unreachable. Contains only data cached on this device${cached ? ` up to ${new Date(cached.savedAt).toLocaleString()}` : ""}; open alerts only.`
    }, { deflate: browserDeflate });
    saveBlob(new Blob([bytes], { type: XLSX_MIME }), reportFilename("Patient_OFFLINE", p.mrn));
    toast("Offline report saved", "Marked INCOMPLETE - cached data only", "warn", 7000);
  }
}

export async function exportWardReport(ctx, wardId, hours = 24) {
  try {
    const name = await download(`/api/reports/ward/${encodeURIComponent(wardId)}?hours=${hours}`);
    toast("Ward report downloaded", name, "ok");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 0) return toast("Report failed", error.message, "crit");
    const patients = ctx.store.patientList.filter(p => p.wardId === wardId);
    if (!patients.length) return toast("Report unavailable", "No cached ward data on this device", "crit");
    const readingsByPatient = {};
    for (const p of patients) {
      const cached = await ctx.store.cachedHistory(p.id);
      readingsByPatient[p.id] = (cached?.points ?? []).map(x => ({ ...x, emergency: x.emergency ? "EMERGENCY" : "OK" }));
    }
    const now = Date.now();
    const bytes = await buildWardReport({
      ward: { id: wardId, name: patients[0].ward }, patients, readingsByPatient,
      alerts: ctx.store.openAlerts.filter(a => a.wardId === wardId), from: now - hours * 3600000, to: now, sampling: "cached",
      generatedAt: now, generatedBy: `${ctx.me.name} (${ctx.role}) - offline`,
      incomplete: true, incompleteReason: "Generated in the browser while the WardOS server was unreachable. Contains only cached data and currently open alerts."
    }, { deflate: browserDeflate });
    saveBlob(new Blob([bytes], { type: XLSX_MIME }), reportFilename("Ward_OFFLINE", wardId));
    toast("Offline ward report saved", "Marked INCOMPLETE - cached data only", "warn", 7000);
  }
}

export function reportsView(el, ctx) {
  const patients = () => ctx.store.patientList.slice().sort((a, b) => String(a.wardId + a.bed).localeCompare(String(b.wardId + b.bed)));
  const wards = () => [...new Map(ctx.store.patientList.map(p => [p.wardId, p.ward])).entries()];

  el.innerHTML = `
    <div class="page-head"><div><h1>Reports</h1><p>Excel (.xlsx) exports generated from stored readings and alerts. Only patients you are authorised to see are included.</p></div></div>
    <div class="grid cols-2">
      <div class="card"><div class="card-head"><h2>Patient report</h2><span class="sub">Vitals, abnormal readings, alerts</span></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
          <div class="field"><label for="rp-p">Patient</label><select class="select" id="rp-p"></select></div>
          <div class="field"><label for="rp-h">Period</label><select class="select" id="rp-h"><option value="1">Last hour (every reading)</option><option value="6">Last 6 hours</option><option value="24" selected>Last 24 hours</option><option value="72">Last 3 days</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option></select></div>
          <button class="btn primary" id="rp-go">${icon("download")}Export patient report</button>
        </div></div>
      <div class="card"><div class="card-head"><h2>Ward report</h2><span class="sub">Ward status, per-patient summaries, alerts</span></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
          <div class="field"><label for="rw-w">Ward</label><select class="select" id="rw-w"></select></div>
          <div class="field"><label for="rw-h">Period</label><select class="select" id="rw-h"><option value="1">Last hour</option><option value="8">Last shift (8 h)</option><option value="24" selected>Last 24 hours</option><option value="168">Last 7 days</option></select></div>
          <button class="btn primary" id="rw-go">${icon("download")}Export ward report</button>
          ${ctx.role === "doctor" ? '<p class="dim" style="font-size:12px">Doctors receive ward reports limited to patients under their care.</p>' : ""}
        </div></div>
    </div>
    <p class="dim" style="margin-top:14px;font-size:12.5px">${icon("info").replace("<svg", '<svg width="14" height="14" style="vertical-align:-2px"')} If the WardOS server is unreachable, reports are built in the browser from data cached on this device and clearly marked INCOMPLETE.</p>`;

  const fill = () => {
    $("#rp-p", el).innerHTML = patients().map(p => `<option value="${p.id}">${esc(p.ward)} · bed ${esc(p.bed)} - ${esc(p.name)} (${esc(p.mrn)})</option>`).join("") || "<option disabled>No patients</option>";
    $("#rw-w", el).innerHTML = wards().map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join("") || "<option disabled>No wards</option>";
  };
  fill();
  const off = ctx.store.on(type => { if (type === "snapshot") fill(); });

  $("#rp-go", el).addEventListener("click", async e => {
    const id = Number($("#rp-p", el).value);
    if (!id) return;
    e.currentTarget.classList.add("loading");
    await exportPatientReport(ctx, id, Number($("#rp-h", el).value));
    e.target.closest("button")?.classList.remove("loading");
  });
  $("#rw-go", el).addEventListener("click", async e => {
    const id = $("#rw-w", el).value;
    if (!id) return;
    const btn = e.currentTarget;
    btn.classList.add("loading");
    await exportWardReport(ctx, id, Number($("#rw-h", el).value));
    btn.classList.remove("loading");
  });
  return () => off();
}
