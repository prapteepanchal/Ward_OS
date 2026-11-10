// ============================================================
// WardOS - Database (SQLite via Node's built-in node:sqlite)
// One local file database: works fully offline, no server,
// no native build step.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS wards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  floor TEXT
);

CREATE TABLE IF NOT EXISTS beds (
  id INTEGER PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards(id),
  label TEXT NOT NULL,
  UNIQUE (ward_id, label)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('nurse','doctor')),
  title TEXT,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_wards (
  user_id INTEGER NOT NULL REFERENCES users(id),
  ward_id TEXT NOT NULL REFERENCES wards(id),
  PRIMARY KEY (user_id, ward_id)
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  mrn TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  age INTEGER,
  sex TEXT,
  diagnosis TEXT,
  ward_id TEXT NOT NULL REFERENCES wards(id),
  bed_id INTEGER REFERENCES beds(id),
  admitted_at INTEGER NOT NULL,
  discharged_at INTEGER,
  access_code_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_patients_ward ON patients(ward_id, discharged_at);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_patients_active_bed ON patients(bed_id) WHERE discharged_at IS NULL AND bed_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS care_team (
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  relation TEXT NOT NULL DEFAULT 'attending',
  PRIMARY KEY (patient_id, user_id)
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  label TEXT,
  model TEXT,
  registered_at INTEGER NOT NULL,
  registered_by INTEGER REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS device_assignments (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  assigned_at INTEGER NOT NULL,
  assigned_by INTEGER REFERENCES users(id),
  unassigned_at INTEGER,
  unassigned_by INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_assign_device ON device_assignments(device_id) WHERE unassigned_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_assign_patient ON device_assignments(patient_id) WHERE unassigned_at IS NULL;

CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  seq INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('clean','raw')),
  hr REAL,
  spo2 REAL,
  temp REAL,
  emergency TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  anomaly INTEGER NOT NULL DEFAULT 0,
  source_path TEXT,
  status TEXT,
  sim INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_readings_patient_ts ON readings(patient_id, ts);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  patient_id INTEGER NOT NULL,
  mrn TEXT,
  patient_name TEXT,
  device_id TEXT,
  ward_id TEXT,
  ward TEXT,
  bed TEXT,
  condition_key TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  vital TEXT,
  value REAL,
  unit TEXT,
  threshold REAL,
  message TEXT,
  note TEXT,
  source TEXT,
  sim INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  condition_active INTEGER NOT NULL DEFAULT 1,
  condition_cleared_at INTEGER,
  created_at INTEGER NOT NULL,
  last_updated INTEGER NOT NULL,
  acknowledged_at INTEGER,
  acknowledged_by INTEGER,
  acknowledged_by_name TEXT,
  resolved_at INTEGER,
  resolved_by TEXT,
  resolved_by_name TEXT,
  resolution_note TEXT,
  expired_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_patient ON alerts(patient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_ward ON alerts(ward_id, created_at);

CREATE TABLE IF NOT EXISTS clinical_notes (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  user_id INTEGER REFERENCES users(id),
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('NOTE','DOCTOR_REQUEST','CODE_BLUE')),
  text TEXT,
  device_id TEXT,
  seq INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_patient ON clinical_notes(patient_id, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  patient_id INTEGER REFERENCES patients(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_role TEXT,
  actor_user_id INTEGER,
  actor_patient_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  scope TEXT NOT NULL,
  target_id TEXT NOT NULL,
  from_ts INTEGER,
  to_ts INTEGER,
  row_count INTEGER,
  filename TEXT
);
`;

export function openDatabase(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  db.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')");
  return db;
}

/** Run fn inside a transaction. */
export function transaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function audit(db, actor, action, target = {}, detail = null, ip = null) {
  db.prepare(`
    INSERT INTO audit_log (ts, actor_role, actor_user_id, actor_patient_id, actor_name, action, target_type, target_id, detail, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    actor?.role ?? "system",
    actor?.userId ?? null,
    actor?.patientId ?? null,
    actor?.name ?? "WardOS",
    action,
    target.type ?? null,
    target.id !== undefined && target.id !== null ? String(target.id) : null,
    detail ? JSON.stringify(detail) : null,
    ip
  );
}
