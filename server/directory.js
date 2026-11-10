// ============================================================
// WardOS - Patient directory (DB -> in-memory) and view models
// ============================================================

import { DeviceRegistry } from "../shared/device_registry.js";

/**
 * Load active admissions + their device assignment and care team.
 * Returns Map(patientId -> entry) and refreshes DeviceRegistry.
 */
export function loadDirectory(db) {
  const rows = db.prepare(`
    SELECT p.id, p.mrn, p.full_name, p.age, p.sex, p.diagnosis, p.ward_id, p.admitted_at,
           w.name AS ward_name, b.label AS bed_label, b.id AS bed_id,
           a.device_id
    FROM patients p
    JOIN wards w ON w.id = p.ward_id
    LEFT JOIN beds b ON b.id = p.bed_id
    LEFT JOIN device_assignments a ON a.patient_id = p.id AND a.unassigned_at IS NULL
    WHERE p.discharged_at IS NULL
    ORDER BY p.ward_id, b.label
  `).all();

  const team = db.prepare(`
    SELECT c.patient_id, c.relation, u.id, u.display_name, u.title
    FROM care_team c JOIN users u ON u.id = c.user_id
  `).all();

  const teamByPatient = new Map();
  for (const t of team) {
    if (!teamByPatient.has(t.patient_id)) teamByPatient.set(t.patient_id, []);
    teamByPatient.get(t.patient_id).push({ id: t.id, name: t.display_name, title: t.title, relation: t.relation });
  }

  const directory = new Map();
  const registry = [];

  for (const r of rows) {
    const entry = {
      id: r.id,
      mrn: r.mrn,
      name: r.full_name,
      age: r.age,
      sex: r.sex,
      diagnosis: r.diagnosis,
      wardId: r.ward_id,
      ward: r.ward_name,
      bed: r.bed_label,
      bedId: r.bed_id,
      admittedAt: r.admitted_at,
      deviceId: r.device_id ?? null,
      careTeam: (teamByPatient.get(r.id) ?? []).sort((a, b) => (a.relation === "attending" ? -1 : 1))
    };
    directory.set(r.id, entry);

    if (r.device_id) {
      registry.push({
        deviceId: r.device_id,
        patientId: r.id,
        mrn: r.mrn,
        patientName: r.full_name,
        age: r.age,
        ward: r.ward_name,
        wardId: r.ward_id,
        bed: r.bed_label
      });
    }
  }

  DeviceRegistry.load(registry);
  return directory;
}

/** Patient view sent to dashboards. */
export function patientView(entry, state, { role } = {}) {
  const view = {
    id: entry.id,
    mrn: entry.mrn,
    name: entry.name,
    age: entry.age,
    sex: entry.sex,
    diagnosis: entry.diagnosis,
    wardId: entry.wardId,
    ward: entry.ward,
    bed: entry.bed,
    admittedAt: entry.admittedAt,
    deviceId: entry.deviceId,
    careTeam: entry.careTeam.map(c => ({ id: c.id, name: c.name, title: c.title, relation: c.relation })),
    status: "offline",
    clinicalStatus: null,
    deviceStatus: entry.deviceId ? "no-data" : "unassigned",
    vitals: { hr: null, spo2: null, temp: null, emergency: null },
    flags: { critical: [], warning: [] },
    mlMeta: null,
    lastSeen: null,
    lastReadingAt: null,
    seq: null,
    sim: false
  };

  if (state && String(state.patientId) === String(entry.id)) {
    Object.assign(view, {
      status: state.status,
      clinicalStatus: state.clinicalStatus,
      deviceStatus: state.deviceStatus,
      vitals: { ...state.vitals },
      flags: { critical: [...state.flags.critical], warning: [...state.flags.warning] },
      mlMeta: { ...state.mlMeta },
      lastSeen: state.lastSeen,
      lastReadingAt: state.lastReadingAt,
      seq: state.seq,
      sim: state.sim
    });
    // Don't present the last values of an offline device as current.
    if (["offline", "link-lost", "no-data"].includes(state.deviceStatus)) {
      view.staleVitals = true;
    }
  }

  if (role === "patient") {
    delete view.seq;
    delete view.mlMeta;
  }

  return view;
}

export function alertRowToRecord(row) {
  return {
    id: row.id,
    key: `${String(row.patient_id).toLowerCase()}|${row.condition_key}`,
    conditionKey: row.condition_key,
    patientId: row.patient_id,
    mrn: row.mrn,
    patientName: row.patient_name,
    deviceId: row.device_id,
    ward: row.ward,
    wardId: row.ward_id,
    bed: row.bed,
    type: row.type,
    severity: row.severity,
    vital: row.vital,
    value: row.value,
    unit: row.unit ?? "",
    threshold: row.threshold,
    message: row.message,
    note: row.note,
    source: row.source,
    sim: !!row.sim,
    status: row.status,
    conditionActive: !!row.condition_active,
    conditionClearedAt: row.condition_cleared_at,
    createdAt: row.created_at,
    lastUpdated: row.last_updated,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedByName: row.acknowledged_by_name,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name,
    resolutionNote: row.resolution_note,
    expiredAt: row.expired_at
  };
}

/** Public alert shape for the browser (patients get a gentler subset). */
export function alertView(alert, role) {
  const open = alert.status === "NEW" || alert.status === "ACKNOWLEDGED";
  const base = {
    id: alert.id,
    patientId: alert.patientId,
    severity: alert.severity,
    type: alert.type,
    status: alert.status,
    open,
    createdAt: alert.createdAt,
    lastUpdated: alert.lastUpdated,
    conditionActive: alert.conditionActive,
    sim: alert.sim
  };
  if (role === "patient") {
    return { ...base, vital: alert.vital, acknowledged: !!alert.acknowledgedAt };
  }
  return {
    ...base,
    mrn: alert.mrn,
    patientName: alert.patientName,
    deviceId: alert.deviceId,
    ward: alert.ward,
    wardId: alert.wardId,
    bed: alert.bed,
    vital: alert.vital,
    value: alert.value,
    unit: alert.unit,
    threshold: alert.threshold,
    message: alert.message,
    note: alert.note,
    source: alert.source,
    conditionClearedAt: alert.conditionClearedAt,
    acknowledgedAt: alert.acknowledgedAt,
    acknowledgedByName: alert.acknowledgedByName,
    resolvedAt: alert.resolvedAt,
    resolvedByName: alert.resolvedByName,
    resolutionNote: alert.resolutionNote,
    expiredAt: alert.expiredAt
  };
}
