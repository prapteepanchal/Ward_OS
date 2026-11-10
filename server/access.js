// ============================================================
// WardOS - Access control (enforced on every API call and on
// every live-stream event).
//
//  nurse   -> patients admitted to the ward(s) they are assigned to
//  doctor  -> patients on whose care team they are
//  patient -> only themself
// ============================================================

export const PERMISSIONS = {
  "alerts.acknowledge": ["nurse", "doctor"],
  "alerts.resolve": ["nurse", "doctor"],          // nurses: non-critical only (checked in route)
  "alerts.resolveCritical": ["doctor"],
  "notes.write": ["nurse", "doctor"],
  "notes.requestDoctor": ["nurse"],
  "notes.codeBlue": ["nurse", "doctor"],
  "patients.admit": ["nurse"],
  "patients.discharge": ["nurse"],
  "devices.manage": ["nurse"],
  "devices.view": ["nurse", "doctor"],
  "reports.patient": ["nurse", "doctor"],
  "reports.ward": ["nurse", "doctor"],
  "staff.view": ["nurse", "doctor"]
};

export function can(principal, permission) {
  return !!principal && (PERMISSIONS[permission] ?? []).includes(principal.role);
}

/**
 * IDs of patients the principal may see.
 * @param {boolean} includeDischarged staff may open discharged
 *        records of their own ward / care team (reports, history).
 */
export function visiblePatientIds(db, principal, { includeDischarged = false } = {}) {
  if (!principal) return new Set();
  const active = includeDischarged ? "" : "AND p.discharged_at IS NULL";

  if (principal.role === "patient") {
    return new Set([principal.patientId]);
  }

  if (principal.role === "nurse") {
    if (!principal.wardIds.length) return new Set();
    const placeholders = principal.wardIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT p.id FROM patients p WHERE p.ward_id IN (${placeholders}) ${active}`).all(...principal.wardIds);
    return new Set(rows.map(r => r.id));
  }

  if (principal.role === "doctor") {
    const rows = db.prepare(`
      SELECT p.id FROM patients p
      JOIN care_team c ON c.patient_id = p.id
      WHERE c.user_id = ? ${active}
    `).all(principal.userId);
    return new Set(rows.map(r => r.id));
  }

  return new Set();
}

export function canViewPatient(db, principal, patientId, options) {
  const id = Number(patientId);
  if (!Number.isInteger(id)) return false;
  if (principal?.role === "patient") return principal.patientId === id;
  return visiblePatientIds(db, principal, options).has(id);
}

/** Wards whose overview the principal may see. */
export function visibleWardIds(db, principal) {
  if (!principal) return [];
  if (principal.role === "nurse") return [...principal.wardIds];
  if (principal.role === "doctor") {
    return db.prepare(`
      SELECT DISTINCT p.ward_id AS id FROM patients p
      JOIN care_team c ON c.patient_id = p.id
      WHERE c.user_id = ? AND p.discharged_at IS NULL
    `).all(principal.userId).map(r => r.id);
  }
  return [];
}

export function nurseCoversWard(principal, wardId) {
  return principal?.role === "nurse" && principal.wardIds.includes(String(wardId));
}
