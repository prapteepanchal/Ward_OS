// ============================================================
// WardOS - REST API
// Every handler receives the server-side principal; role and
// scope are NEVER taken from the request body.
// ============================================================

import zlib from "node:zlib";
import { serverConfig } from "./config.js";
import { audit, transaction } from "./db.js";
import {
  verifySecret, verifyDummy, normalizeName, normalizeAccessCode, generateAccessCode, hashSecret,
  createSession, destroySession, destroySessionsForPatient, sessionCookie, clearedCookie,
  isThrottled, recordFailure, clearFailures
} from "./auth.js";
import { can, canViewPatient, visiblePatientIds, visibleWardIds, nurseCoversWard } from "./access.js";
import { HttpError, readJson, sendJson, sendFile, clientIp } from "./http.js";
import { patientView, alertView, alertRowToRecord } from "./directory.js";
import { buildPatientReport, buildWardReport, reportFilename } from "../shared/report_builder.js";
import { XLSX_MIME } from "../shared/xlsx.js";
import { config } from "../shared/config.js";

const deflate = async bytes => zlib.deflateRawSync(bytes);

function require(principal, permission) {
  if (!principal) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in");
  if (!can(principal, permission)) throw new HttpError(403, "FORBIDDEN", "Your role cannot perform this action");
}

function requireAuth(principal) {
  if (!principal) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in");
}

function requirePatientAccess(db, principal, patientId, options) {
  requireAuth(principal);
  if (!canViewPatient(db, principal, patientId, options)) {
    // 404 rather than 403: don't confirm the record exists.
    throw new HttpError(404, "NOT_FOUND", "Patient not found");
  }
  return Number(patientId);
}

function actor(principal) {
  return { role: principal.role, userId: principal.userId, patientId: principal.patientId, name: principal.name };
}

function str(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function range(query, defaultHours = 24, maxHours = 24 * 30) {
  const now = Date.now();
  let to = Number(query.get("to")) || now;
  let from = Number(query.get("from"));
  if (!from) {
    const hours = Math.min(Math.max(Number(query.get("hours")) || defaultHours, 0.05), maxHours);
    from = to - hours * 3600000;
  }
  if (to - from > maxHours * 3600000) from = to - maxHours * 3600000;
  return { from, to };
}

function principalView(p) {
  return {
    role: p.role, name: p.name, username: p.username ?? null, title: p.title ?? null,
    userId: p.userId, patientId: p.patientId, wardIds: p.wardIds, expiresAt: p.expiresAt
  };
}

// ------------------------------------------------------------
// Vital history (bucketed for charts)
// ------------------------------------------------------------

function vitalHistory(db, patientId, from, to, { maxPoints = 600, kind = "clean" } = {}) {
  const span = Math.max(1, to - from);
  const bucket = Math.max(1000, Math.ceil(span / maxPoints));
  const kindClause = kind === "all" ? "" : "AND kind = ?";
  const args = kind === "all" ? [bucket, bucket, patientId, from, to] : [bucket, bucket, patientId, from, to, kind];
  return db.prepare(`
    SELECT (ts / ?) * ? AS ts, kind,
           AVG(hr) AS hr, AVG(spo2) AS spo2, AVG(temp) AS temp,
           MIN(hr) AS hrMin, MAX(hr) AS hrMax, MIN(spo2) AS spo2Min, MAX(temp) AS tempMax,
           MAX(removed) AS removed, MAX(anomaly) AS anomaly, MAX(sim) AS sim,
           MAX(CASE WHEN emergency = 'EMERGENCY' THEN 1 ELSE 0 END) AS emergency
    FROM readings WHERE patient_id = ? AND ts BETWEEN ? AND ? ${kindClause}
    GROUP BY 1, kind ORDER BY 1
  `).all(...args).map(r => ({
    ts: r.ts, kind: r.kind,
    hr: round(r.hr), spo2: round(r.spo2), temp: round(r.temp, 1),
    hrMin: r.hrMin, hrMax: r.hrMax, spo2Min: r.spo2Min, tempMax: r.tempMax,
    removed: !!r.removed, anomaly: !!r.anomaly, sim: !!r.sim, emergency: !!r.emergency
  }));
}

function round(v, d = 0) {
  return v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d;
}

function reportReadings(db, patientId, from, to) {
  // Raw samples for short windows; 1-minute averages beyond 2 hours.
  const span = to - from;
  if (span <= 2 * 3600000) {
    return {
      sampling: "raw",
      readings: db.prepare(`
        SELECT ts, hr, spo2, temp, emergency, removed, anomaly, source_path AS sourcePath, sim
        FROM readings WHERE patient_id = ? AND kind = 'clean' AND ts BETWEEN ? AND ? ORDER BY ts
      `).all(patientId, from, to).map(r => ({ ...r, removed: !!r.removed, anomaly: !!r.anomaly, sim: !!r.sim }))
    };
  }
  return {
    sampling: "1min",
    readings: db.prepare(`
      SELECT (ts / 60000) * 60000 AS ts, ROUND(AVG(hr)) AS hr, ROUND(AVG(spo2)) AS spo2, ROUND(AVG(temp), 1) AS temp,
             MAX(CASE WHEN emergency = 'EMERGENCY' THEN 'EMERGENCY' ELSE NULL END) AS emergency,
             MIN(removed) AS removed, MAX(anomaly) AS anomaly, MAX(sim) AS sim, 'avg' AS sourcePath
      FROM readings WHERE patient_id = ? AND kind = 'clean' AND ts BETWEEN ? AND ?
      GROUP BY 1 ORDER BY 1
    `).all(patientId, from, to).map(r => ({ ...r, emergency: r.emergency ?? "OK", removed: !!r.removed, anomaly: !!r.anomaly, sim: !!r.sim }))
  };
}

function alertsForPatient(db, patientId, from, to, limit = 500) {
  return db.prepare(`
    SELECT * FROM alerts WHERE patient_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT ?
  `).all(patientId, from, to, limit).map(alertRowToRecord);
}

function patientRecord(db, monitoring, id) {
  const entry = monitoring.directory.get(id);
  if (entry) return entry;
  // Discharged patient: build from the database.
  const row = db.prepare(`
    SELECT p.*, w.name AS ward_name, b.label AS bed_label FROM patients p
    JOIN wards w ON w.id = p.ward_id LEFT JOIN beds b ON b.id = p.bed_id WHERE p.id = ?
  `).get(id);
  if (!row) return null;
  const careTeam = db.prepare(`
    SELECT u.id, u.display_name AS name, u.title, c.relation FROM care_team c JOIN users u ON u.id = c.user_id WHERE c.patient_id = ?
  `).all(id);
  const lastDevice = db.prepare("SELECT device_id FROM device_assignments WHERE patient_id = ? ORDER BY assigned_at DESC LIMIT 1").get(id);
  return {
    id: row.id, mrn: row.mrn, name: row.full_name, age: row.age, sex: row.sex, diagnosis: row.diagnosis,
    wardId: row.ward_id, ward: row.ward_name, bed: row.bed_label, admittedAt: row.admitted_at,
    dischargedAt: row.discharged_at, deviceId: lastDevice?.device_id ?? null, careTeam
  };
}

// ------------------------------------------------------------
// ROUTES
// ------------------------------------------------------------

export function registerRoutes(router, { db, monitoring, hub }) {

  // ---------------- AUTH ----------------

  router.get("/api/auth/options", () => ({
    patientNameOnlyLogin: serverConfig.auth.patientNameOnlyLogin,
    demo: serverConfig.demo
  }), { public: true });

  router.post("/api/auth/login", async ({ req, res }) => {
    const body = await readJson(req);
    const username = str(body.username, 80);
    const password = String(body.password ?? "");
    const role = body.role === "doctor" ? "doctor" : "nurse";
    const throttleKey = `${clientIp(req)}|${username.toLowerCase()}`;

    if (!username || !password) throw new HttpError(400, "MISSING_FIELDS", "Enter your staff ID and password");
    if (isThrottled(throttleKey)) throw new HttpError(429, "THROTTLED", "Too many failed attempts. Try again in 10 minutes.");

    const user = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(username);
    const ok = user ? verifySecret(password, user.password_hash) : verifyDummy(password);

    if (!ok) {
      recordFailure(throttleKey);
      audit(db, null, "auth.login_failed", { type: "user", id: username }, { role }, clientIp(req));
      throw new HttpError(401, "INVALID_CREDENTIALS", "Staff ID or password is incorrect");
    }
    if (user.role !== role) {
      recordFailure(throttleKey);
      throw new HttpError(403, "WRONG_ROLE", `This account is registered as ${user.role === "doctor" ? "a doctor" : "a nurse"}. Select the correct role.`);
    }

    clearFailures(throttleKey);
    const session = createSession(db, { role: user.role, userId: user.id, ip: clientIp(req), userAgent: req.headers["user-agent"] });
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), user.id);
    audit(db, { role: user.role, userId: user.id, name: user.display_name }, "auth.login", { type: "user", id: user.id }, null, clientIp(req));
    sendJson(res, 200, { ok: true, role: user.role, name: user.display_name }, { "Set-Cookie": sessionCookie(session.token, session.expiresAt) });
  }, { public: true });

  router.post("/api/auth/patient-login", async ({ req, res }) => {
    const body = await readJson(req);
    const nameKey = normalizeName(body.name);
    const code = normalizeAccessCode(body.accessCode);
    const throttleKey = `${clientIp(req)}|patient|${nameKey}`;

    if (!nameKey) throw new HttpError(400, "MISSING_FIELDS", "Enter your name as registered at admission");
    if (isThrottled(throttleKey)) throw new HttpError(429, "THROTTLED", "Too many attempts. Please ask your nurse for help.");

    const matches = db.prepare("SELECT id, full_name, access_code_hash FROM patients WHERE name_key = ? AND discharged_at IS NULL").all(nameKey);
    let patient = null;

    if (code) {
      patient = matches.find(m => verifySecret(code, m.access_code_hash)) ?? null;
      if (!matches.length) verifyDummy(code);
    } else if (serverConfig.auth.patientNameOnlyLogin) {
      if (matches.length > 1) throw new HttpError(409, "CODE_REQUIRED", "More than one patient has this name. Enter your access code.");
      patient = matches[0] ?? null;
    } else {
      throw new HttpError(400, "CODE_REQUIRED", "Enter the access code on your admission card");
    }

    if (!patient) {
      recordFailure(throttleKey);
      audit(db, null, "auth.patient_login_failed", { type: "patient-name", id: nameKey.slice(0, 40) }, null, clientIp(req));
      throw new HttpError(401, "INVALID_CREDENTIALS", code ? "Name or access code not recognised" : "No admitted patient found with that name");
    }

    clearFailures(throttleKey);
    const session = createSession(db, { role: "patient", patientId: patient.id, ip: clientIp(req), userAgent: req.headers["user-agent"] });
    audit(db, { role: "patient", patientId: patient.id, name: patient.full_name }, "auth.login", { type: "patient", id: patient.id },
      { method: code ? "access-code" : "name-only (demo)" }, clientIp(req));
    sendJson(res, 200, { ok: true, role: "patient", name: patient.full_name }, { "Set-Cookie": sessionCookie(session.token, session.expiresAt) });
  }, { public: true });

  router.post("/api/auth/logout", ({ res, token, principal }) => {
    if (principal) audit(db, actor(principal), "auth.logout");
    destroySession(db, token);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": clearedCookie() });
  }, { public: true });

  router.get("/api/auth/me", ({ principal }) => {
    requireAuth(principal);
    return principalView(principal);
  });

  // ---------------- LIVE STREAM ----------------

  router.get("/api/stream", ({ req, res, principal }) => {
    requireAuth(principal);
    hub.attach(req, res, principal);
  });

  router.get("/api/system/status", ({ principal }) => {
    requireAuth(principal);
    return principal.role === "patient" ? hub.patientSystem() : monitoring.systemStatus();
  });

  // ---------------- WARDS / STAFF ----------------

  router.get("/api/wards", ({ principal }) => {
    requireAuth(principal);
    const ids = visibleWardIds(db, principal);
    if (!ids.length) return [];
    return db.prepare(`SELECT id, name, floor FROM wards WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).all(...ids)
      .map(w => ({
        ...w,
        beds: db.prepare(`
          SELECT b.id, b.label, p.id AS patientId FROM beds b
          LEFT JOIN patients p ON p.bed_id = b.id AND p.discharged_at IS NULL
          WHERE b.ward_id = ? ORDER BY b.label
        `).all(w.id).map(b => ({ id: b.id, label: b.label, occupied: !!b.patientId }))
      }));
  });

  router.get("/api/doctors", ({ principal }) => {
    require(principal, "staff.view");
    return db.prepare("SELECT id, display_name AS name, title FROM users WHERE role = 'doctor' AND active = 1 ORDER BY display_name").all();
  });

  // ---------------- PATIENTS ----------------

  router.get("/api/patients", ({ principal }) => {
    requireAuth(principal);
    const visible = visiblePatientIds(db, principal);
    return [...visible].map(id => monitoring.directory.get(id)).filter(Boolean)
      .map(entry => patientView(entry, monitoring.getState(entry.id), { role: principal.role }));
  });

  router.get("/api/patients/:id", ({ principal, params }) => {
    const id = requirePatientAccess(db, principal, params.id, { includeDischarged: principal?.role !== "patient" });
    const entry = patientRecord(db, monitoring, id);
    if (!entry) throw new HttpError(404, "NOT_FOUND", "Patient not found");
    return { ...patientView(entry, monitoring.getState(id), { role: principal.role }), dischargedAt: entry.dischargedAt ?? null };
  });

  router.get("/api/patients/:id/vitals", ({ principal, params, query }) => {
    const id = requirePatientAccess(db, principal, params.id, { includeDischarged: principal?.role !== "patient" });
    const { from, to } = range(query, 1, 24 * 7);
    const kind = principal.role === "doctor" && query.get("kind") === "all" ? "all" : "clean";
    const maxPoints = Math.min(Math.max(Number(query.get("maxPoints")) || 600, 30), 2000);
    return { from, to, points: vitalHistory(db, id, from, to, { maxPoints, kind }) };
  });

  router.get("/api/patients/:id/alerts", ({ principal, params, query }) => {
    const id = requirePatientAccess(db, principal, params.id, { includeDischarged: principal?.role !== "patient" });
    const { from, to } = range(query, 24 * 7, 24 * 30);
    return alertsForPatient(db, id, from, to, 300).map(a => alertView(a, principal.role));
  });

  router.get("/api/patients/:id/notes", ({ principal, params }) => {
    if (principal?.role === "patient") throw new HttpError(403, "FORBIDDEN", "Not available");
    const id = requirePatientAccess(db, principal, params.id, { includeDischarged: true });
    return db.prepare(`
      SELECT id, kind, text, author_name AS author, author_role AS authorRole, created_at AS createdAt, device_id AS deviceId, seq
      FROM clinical_notes WHERE patient_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(id);
  });

  router.post("/api/patients/:id/notes", async ({ req, principal, params }) => {
    require(principal, "notes.write");
    const id = requirePatientAccess(db, principal, params.id);
    const body = await readJson(req);
    const kind = ["NOTE", "DOCTOR_REQUEST", "CODE_BLUE"].includes(body.kind) ? body.kind : "NOTE";
    if (kind === "DOCTOR_REQUEST") require(principal, "notes.requestDoctor");
    if (kind === "CODE_BLUE") require(principal, "notes.codeBlue");
    const text = str(body.text, 1000);
    if (kind === "NOTE" && !text) throw new HttpError(400, "MISSING_FIELDS", "Note text is required");

    // device_id + seq are taken from the live state, never typed by the user.
    const state = monitoring.getState(id);
    const result = db.prepare(`
      INSERT INTO clinical_notes (patient_id, user_id, author_name, author_role, kind, text, device_id, seq, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, principal.userId, principal.name, principal.role, kind, text || null, state?.deviceId ?? null, state?.seq ?? null, Date.now());
    audit(db, actor(principal), `clinical.${kind.toLowerCase()}`, { type: "patient", id }, { text: text.slice(0, 120) }, clientIp(req));
    return { ok: true, id: Number(result.lastInsertRowid) };
  });

  router.post("/api/patients", async ({ req, principal }) => {
    require(principal, "patients.admit");
    const body = await readJson(req);
    const name = str(body.name, 120);
    const wardId = str(body.wardId, 20);
    const bedId = Number(body.bedId);
    const doctorId = Number(body.doctorId);
    const age = body.age === "" || body.age === undefined ? null : Number(body.age);
    const sex = ["M", "F", "O"].includes(body.sex) ? body.sex : null;

    if (!name || name.length < 2) throw new HttpError(400, "INVALID", "Enter the patient's full name");
    if (!nurseCoversWard(principal, wardId)) throw new HttpError(403, "FORBIDDEN", "You can only admit patients to your own ward");
    if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) throw new HttpError(400, "INVALID", "Age must be 0-120");
    const bed = db.prepare("SELECT id FROM beds WHERE id = ? AND ward_id = ?").get(bedId, wardId);
    if (!bed) throw new HttpError(400, "INVALID", "Select a bed in this ward");
    if (db.prepare("SELECT 1 FROM patients WHERE bed_id = ? AND discharged_at IS NULL").get(bedId)) throw new HttpError(409, "BED_OCCUPIED", "That bed is occupied");
    const doctor = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'doctor' AND active = 1").get(doctorId);
    if (!doctor) throw new HttpError(400, "INVALID", "Select an attending doctor");

    const accessCode = generateAccessCode();
    const now = Date.now();
    const id = transaction(db, () => {
      const seq = db.prepare("SELECT COUNT(*) + 1 AS n FROM patients").get().n;
      const mrn = `PT-${String(3000 + seq)}`;
      const result = db.prepare(`
        INSERT INTO patients (mrn, full_name, name_key, age, sex, diagnosis, ward_id, bed_id, admitted_at, access_code_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(mrn, name, normalizeName(name), age, sex, str(body.diagnosis, 200) || null, wardId, bedId, now, hashSecret(normalizeAccessCode(accessCode)));
      const pid = Number(result.lastInsertRowid);
      db.prepare("INSERT INTO care_team (patient_id, user_id, relation) VALUES (?, ?, 'attending')").run(pid, doctorId);
      return pid;
    });

    audit(db, actor(principal), "patient.admit", { type: "patient", id }, { wardId, bedId }, clientIp(req));
    monitoring.reloadDirectory();
    // The access code is shown ONCE so the nurse can hand it to the patient.
    return { ok: true, id, accessCode };
  });

  router.post("/api/patients/:id/discharge", async ({ req, principal, params }) => {
    require(principal, "patients.discharge");
    const id = requirePatientAccess(db, principal, params.id);
    const now = Date.now();
    transaction(db, () => {
      db.prepare("UPDATE device_assignments SET unassigned_at = ?, unassigned_by = ? WHERE patient_id = ? AND unassigned_at IS NULL").run(now, principal.userId, id);
      db.prepare("UPDATE patients SET discharged_at = ? WHERE id = ?").run(now, id);
    });
    destroySessionsForPatient(db, id);
    hub.closeWhere(p => p.role === "patient" && p.patientId === id);
    monitoring.alertEngine.closeAllForPatient(id, "Patient discharged");
    audit(db, actor(principal), "patient.discharge", { type: "patient", id }, null, clientIp(req));
    monitoring.reloadDirectory();
    return { ok: true };
  });

  router.post("/api/patients/:id/access-code", async ({ req, principal, params }) => {
    require(principal, "patients.admit");
    const id = requirePatientAccess(db, principal, params.id);
    const accessCode = generateAccessCode();
    db.prepare("UPDATE patients SET access_code_hash = ? WHERE id = ?").run(hashSecret(normalizeAccessCode(accessCode)), id);
    destroySessionsForPatient(db, id);
    audit(db, actor(principal), "patient.access_code_reset", { type: "patient", id }, null, clientIp(req));
    return { ok: true, accessCode };
  });

  // ---------------- ALERTS ----------------

  router.get("/api/alerts", ({ principal, query }) => {
    requireAuth(principal);
    const visible = visiblePatientIds(db, principal, { includeDischarged: principal.role !== "patient" });
    if (!visible.size) return [];
    const status = query.get("status") ?? "open";
    const ids = [...visible];
    const marks = ids.map(() => "?").join(",");

    if (status === "open") {
      return monitoring.alertEngine.getOpenAlerts().filter(a => visible.has(Number(a.patientId))).map(a => alertView(a, principal.role));
    }
    const { from, to } = range(query, 24, 24 * 30);
    const limit = Math.min(Number(query.get("limit")) || 300, 1000);
    return db.prepare(`SELECT * FROM alerts WHERE patient_id IN (${marks}) AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT ?`)
      .all(...ids, from, to, limit).map(alertRowToRecord).map(a => alertView(a, principal.role));
  });

  router.post("/api/alerts/:id/acknowledge", async ({ req, principal, params }) => {
    require(principal, "alerts.acknowledge");
    const alert = monitoring.alertEngine.getAlert(params.id);
    if (!alert || !canViewPatient(db, principal, alert.patientId)) throw new HttpError(404, "NOT_FOUND", "Alert not found");
    const result = monitoring.alertEngine.acknowledge(params.id, { id: principal.userId, name: principal.name });
    if (!result.ok) throw new HttpError(409, result.error, "This alert has already been acknowledged or closed");
    audit(db, actor(principal), "alert.acknowledge", { type: "alert", id: params.id }, { severity: alert.severity }, clientIp(req));
    return { ok: true, alert: alertView(result.alert, principal.role) };
  });

  router.post("/api/alerts/:id/resolve", async ({ req, principal, params }) => {
    require(principal, "alerts.resolve");
    const body = await readJson(req);
    const alert = monitoring.alertEngine.getAlert(params.id);
    if (!alert || !canViewPatient(db, principal, alert.patientId)) throw new HttpError(404, "NOT_FOUND", "Alert not found");
    if (alert.severity === "CRITICAL" && !can(principal, "alerts.resolveCritical")) {
      throw new HttpError(403, "FORBIDDEN", "Critical alerts are resolved by a doctor. Acknowledge it and escalate.");
    }
    const result = monitoring.alertEngine.resolve(params.id, { id: principal.userId, name: principal.name }, str(body.note, 500));
    if (!result.ok) {
      const message = result.error === "CONDITION_ACTIVE"
        ? "The condition is still active. It can be resolved once readings return to range."
        : "This alert is already closed";
      throw new HttpError(409, result.error, message);
    }
    audit(db, actor(principal), "alert.resolve", { type: "alert", id: params.id }, { note: str(body.note, 120) }, clientIp(req));
    return { ok: true, alert: alertView(result.alert, principal.role) };
  });

  // ---------------- DEVICES ----------------

  router.get("/api/devices", ({ principal }) => {
    require(principal, "devices.view");
    const visible = visiblePatientIds(db, principal);
    const live = new Map(monitoring.stateStore.getAllStates().map(s => [s.deviceId, s]));
    const detected = new Map(monitoring.stateStore.getUnassignedDevices().map(d => [d.deviceId, d]));

    const rows = db.prepare(`
      SELECT d.id, d.label, d.model, d.registered_at, d.last_seen_at, a.patient_id
      FROM devices d LEFT JOIN device_assignments a ON a.device_id = d.id AND a.unassigned_at IS NULL
      WHERE d.active = 1 ORDER BY CAST(d.id AS INTEGER), d.id
    `).all();

    const devices = [];
    for (const r of rows) {
      // Nurses/doctors see free devices and devices on their own patients.
      if (r.patient_id && !visible.has(r.patient_id)) continue;
      const entry = r.patient_id ? monitoring.directory.get(r.patient_id) : null;
      const state = live.get(r.id);
      const seen = detected.get(r.id);
      devices.push({
        id: r.id, label: r.label, model: r.model, registered: true, registeredAt: r.registered_at,
        lastSeen: state?.lastSeen ?? seen?.lastSeen ?? r.last_seen_at ?? null,
        status: state ? state.deviceStatus : (seen && Date.now() - seen.lastSeen < config.devices.offlineAfterMs ? "online" : "idle"),
        patient: entry ? { id: entry.id, name: entry.name, mrn: entry.mrn, ward: entry.ward, wardId: entry.wardId, bed: entry.bed } : null
      });
    }
    if (principal.role === "nurse") {
      for (const d of detected.values()) {
        if (rows.some(r => r.id === d.deviceId)) continue;
        devices.push({ id: d.deviceId, label: null, registered: false, lastSeen: d.lastSeen, firstSeen: d.firstSeen, status: "unregistered", patient: null });
      }
    }
    return devices;
  });

  router.post("/api/devices", async ({ req, principal }) => {
    require(principal, "devices.manage");
    const body = await readJson(req);
    const id = str(body.id, 64);
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw new HttpError(400, "INVALID", "Device ID may contain letters, digits and _ . : - only");
    if (db.prepare("SELECT 1 FROM devices WHERE id = ?").get(id)) throw new HttpError(409, "EXISTS", "This device is already registered");
    db.prepare("INSERT INTO devices (id, label, model, registered_at, registered_by) VALUES (?, ?, ?, ?, ?)")
      .run(id, str(body.label, 60) || `Band ${id}`, str(body.model, 60) || "ESP32 wearable", Date.now(), principal.userId);
    audit(db, actor(principal), "device.register", { type: "device", id }, null, clientIp(req));
    return { ok: true };
  });

  router.post("/api/devices/:id/assign", async ({ req, principal, params }) => {
    require(principal, "devices.manage");
    const body = await readJson(req);
    const patientId = requirePatientAccess(db, principal, body.patientId);
    const device = db.prepare("SELECT id FROM devices WHERE id = ? AND active = 1").get(params.id);
    if (!device) throw new HttpError(404, "NOT_FOUND", "Register the device first");
    if (db.prepare("SELECT 1 FROM device_assignments WHERE device_id = ? AND unassigned_at IS NULL").get(params.id)) {
      throw new HttpError(409, "DEVICE_IN_USE", "This device is already assigned. Unassign it first.");
    }
    if (db.prepare("SELECT 1 FROM device_assignments WHERE patient_id = ? AND unassigned_at IS NULL").get(patientId)) {
      throw new HttpError(409, "PATIENT_HAS_DEVICE", "This patient already has a device. Unassign it first.");
    }
    db.prepare("INSERT INTO device_assignments (device_id, patient_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)")
      .run(params.id, patientId, Date.now(), principal.userId);
    audit(db, actor(principal), "device.assign", { type: "device", id: params.id }, { patientId }, clientIp(req));
    monitoring.reloadDirectory();
    return { ok: true };
  });

  router.post("/api/devices/:id/unassign", async ({ req, principal, params }) => {
    require(principal, "devices.manage");
    const row = db.prepare("SELECT patient_id FROM device_assignments WHERE device_id = ? AND unassigned_at IS NULL").get(params.id);
    if (!row) throw new HttpError(404, "NOT_FOUND", "Device is not assigned");
    requirePatientAccess(db, principal, row.patient_id);
    db.prepare("UPDATE device_assignments SET unassigned_at = ?, unassigned_by = ? WHERE device_id = ? AND unassigned_at IS NULL")
      .run(Date.now(), principal.userId, params.id);
    monitoring.alertEngine.closeAllForPatient(row.patient_id, "Device unassigned");
    audit(db, actor(principal), "device.unassign", { type: "device", id: params.id }, { patientId: row.patient_id }, clientIp(req));
    monitoring.reloadDirectory();
    return { ok: true };
  });

  // ---------------- REPORTS ----------------

  router.get("/api/reports/patient/:id", async ({ res, principal, params, query }) => {
    require(principal, "reports.patient");
    const id = requirePatientAccess(db, principal, params.id, { includeDischarged: true });
    const entry = patientRecord(db, monitoring, id);
    const { from, to } = range(query, 24, 24 * 30);
    const { readings, sampling } = reportReadings(db, id, from, to);
    const alerts = alertsForPatient(db, id, from, to, 2000).reverse();

    const bytes = await buildPatientReport({
      patient: entry, readings, sampling, alerts, from, to,
      generatedAt: Date.now(), generatedBy: `${principal.name} (${principal.role})`
    }, { deflate });

    const filename = reportFilename("Patient", entry.mrn);
    db.prepare("INSERT INTO reports (ts, user_id, scope, target_id, from_ts, to_ts, row_count, filename) VALUES (?, ?, 'patient', ?, ?, ?, ?, ?)")
      .run(Date.now(), principal.userId, String(id), from, to, readings.length, filename);
    audit(db, actor(principal), "report.patient", { type: "patient", id }, { from, to });
    sendFile(res, 200, bytes, XLSX_MIME, filename);
  });

  router.get("/api/reports/ward/:wardId", async ({ res, principal, params, query }) => {
    require(principal, "reports.ward");
    const wardId = params.wardId;
    const ward = db.prepare("SELECT id, name FROM wards WHERE id = ?").get(wardId);
    const allowed = principal.role === "nurse" ? nurseCoversWard(principal, wardId) : visibleWardIds(db, principal).includes(wardId);
    if (!ward || !allowed) throw new HttpError(404, "NOT_FOUND", "Ward not found");

    const { from, to } = range(query, 24, 24 * 7);
    const visible = visiblePatientIds(db, principal);
    const entries = [...monitoring.directory.values()].filter(e => e.wardId === wardId && visible.has(e.id))
      .sort((a, b) => String(a.bed).localeCompare(String(b.bed)));

    const patients = entries.map(e => patientView(e, monitoring.getState(e.id), { role: principal.role }));
    const readingsByPatient = {};
    let sampling = "1min";
    for (const e of entries) {
      const r = reportReadings(db, e.id, from, to);
      readingsByPatient[e.id] = r.readings;
      sampling = r.sampling;
    }
    const alerts = entries.flatMap(e => alertsForPatient(db, e.id, from, to, 1000)).sort((a, b) => a.createdAt - b.createdAt);

    const bytes = await buildWardReport({
      ward, patients, readingsByPatient, alerts, from, to, sampling,
      generatedAt: Date.now(), generatedBy: `${principal.name} (${principal.role})`,
      scopeNote: principal.role === "doctor" ? "Only patients under this doctor's care in this ward" : "All patients admitted to this ward"
    }, { deflate });

    const filename = reportFilename("Ward", ward.id);
    db.prepare("INSERT INTO reports (ts, user_id, scope, target_id, from_ts, to_ts, row_count, filename) VALUES (?, ?, 'ward', ?, ?, ?, ?, ?)")
      .run(Date.now(), principal.userId, ward.id, from, to, patients.length, filename);
    audit(db, actor(principal), "report.ward", { type: "ward", id: ward.id }, { from, to });
    sendFile(res, 200, bytes, XLSX_MIME, filename);
  });
}
