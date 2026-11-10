// ============================================================
// WardOS - Authentication & sessions
//
//  - Staff (nurse / doctor): username + password (scrypt hash)
//  - Patient: name + personal access code. Name-only sign-in is
//    available ONLY when PATIENT_NAME_LOGIN is enabled in a
//    non-production (demo) environment.
//  - Sessions: random token in an HttpOnly, SameSite=Strict
//    cookie; only its SHA-256 hash is stored in the database.
//  - Role and scope are always read from the server-side
//    session, never from anything the browser sends.
// ============================================================

import crypto from "node:crypto";
import { serverConfig } from "./config.js";

export const SESSION_COOKIE = "wardos_sid";
const SCRYPT_N = 16384;

// ---------------------------------------------------------------
// Password / access-code hashing
// ---------------------------------------------------------------

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, 32, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifySecret(secret, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [scheme, n, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(String(secret), Buffer.from(saltB64, "base64"), expected.length, { N: Number(n) });
  return crypto.timingSafeEqual(expected, actual);
}

// Burn comparable time when the user doesn't exist (no username probing).
const DUMMY_HASH = hashSecret(crypto.randomBytes(8).toString("hex"));
export function verifyDummy(secret) {
  verifySecret(secret, DUMMY_HASH);
  return false;
}

export function normalizeName(name) {
  return String(name ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Human-friendly access code, e.g. "7KQ-4MX" (no 0/O/1/I). */
export function generateAccessCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(6);
  const chars = [...bytes].map(b => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 3)}-${chars.slice(3)}`;
}

export function normalizeAccessCode(code) {
  return String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ---------------------------------------------------------------
// Login throttling (in memory, per IP + identifier)
// ---------------------------------------------------------------

const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 8;

export function isThrottled(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

export function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

export function clearFailures(key) {
  attempts.delete(key);
}

// ---------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createSession(db, { role, userId = null, patientId = null, ip = null, userAgent = null }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const hours = role === "patient" ? serverConfig.auth.patientSessionHours : serverConfig.auth.staffSessionHours;
  const expiresAt = now + hours * 3600 * 1000;

  db.prepare(`
    INSERT INTO sessions (token_hash, role, user_id, patient_id, created_at, expires_at, last_seen_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(hashToken(token), role, userId, patientId, now, expiresAt, now, ip, String(userAgent ?? "").slice(0, 200));

  return { token, expiresAt };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function destroySessionsForPatient(db, patientId) {
  db.prepare("DELETE FROM sessions WHERE patient_id = ?").run(patientId);
}

/**
 * Resolve a session token into a principal:
 *  { role, userId, patientId, name, username, wardIds[] }
 */
export function loadSession(db, token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token));
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at < now) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
    return null;
  }

  // Throttle last-seen writes to once a minute.
  if (now - row.last_seen_at > 60000) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, row.token_hash);
  }

  if (row.role === "patient") {
    const patient = db.prepare("SELECT id, full_name, discharged_at FROM patients WHERE id = ?").get(row.patient_id);
    if (!patient || patient.discharged_at) return null;
    return { role: "patient", userId: null, patientId: patient.id, name: patient.full_name, wardIds: [], expiresAt: row.expires_at };
  }

  const user = db.prepare("SELECT id, username, display_name, role, title, active FROM users WHERE id = ?").get(row.user_id);
  if (!user || !user.active || user.role !== row.role) return null;

  const wardIds = db.prepare("SELECT ward_id FROM user_wards WHERE user_id = ?").all(user.id).map(r => r.ward_id);

  return {
    role: user.role,
    userId: user.id,
    patientId: null,
    username: user.username,
    name: user.display_name,
    title: user.title,
    wardIds,
    expiresAt: row.expires_at
  };
}

export function purgeExpiredSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

export function sessionCookie(token, expiresAt) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Expires=${new Date(expiresAt).toUTCString()}`
  ];
  if (serverConfig.auth.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
