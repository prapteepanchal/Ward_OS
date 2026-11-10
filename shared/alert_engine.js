// ============================================================
// WardOS - Central Clinical Alert Engine
// File: shared/alert_engine.js
//
// Runs on the backend (authoritative). The browser receives
// alert records over the live stream; it never creates alerts.
//
// LIFECYCLE
//
//   NEW ──acknowledge──► ACKNOWLEDGED ──resolve──► RESOLVED
//    │                        │
//    │                        └─ condition clear for grace period
//    │                           ──► RESOLVED (by system)
//    └─ (WARNING / ANOMALY / INFO only) condition clear for grace
//       period without anyone acknowledging ──► EXPIRED
//
//  * A CRITICAL alert NEVER expires. It stays NEW (visible,
//    counted, chiming) until a staff member acknowledges it,
//    even if the readings have since returned to normal.
//  * Acknowledging never erases an alert; it records who saw it.
//  * Resolving means "the condition is over". It is refused
//    while the condition is still active - the next reading
//    would only raise the same alert again.
//  * Deduplication: one open alert per patient + condition
//    (e.g. "critical:spo2:LOW"). Repeated samples update the
//    open alert instead of creating new ones.
//  * The original TTLs (CRITICAL 30 s, ANOMALY 10 s, other 15 s)
//    are used as the "clear grace" period, see shared/config.js.
// ============================================================

import { config } from "./config.js";

export const ALERT_STATUS = Object.freeze({
  NEW: "NEW",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  RESOLVED: "RESOLVED",
  EXPIRED: "EXPIRED"
});

const OPEN = new Set([ALERT_STATUS.NEW, ALERT_STATUS.ACKNOWLEDGED]);
const MAX_CLOSED_IN_MEMORY = 300;

function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

export class AlertEngine {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.alerts = [];
    this.listeners = [];
    this.alertCounter = 0;
    this.clearTimers = new Map();
    this.idPrefix = "ALR";
  }

  // ------------------------------------------------------------
  // SUBSCRIPTIONS
  // callback(alert, event) where event is one of
  // CREATED | UPDATED | ACKNOWLEDGED | RESOLVED | EXPIRED
  // ------------------------------------------------------------

  subscribe(callback) {
    if (typeof callback !== "function") {
      console.warn("[WardOS Alert Engine] Invalid subscriber");
      return () => {};
    }
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(listener => listener !== callback);
    };
  }

  notify(alert, event) {
    const snapshot = this.toPublic(alert);
    for (const callback of [...this.listeners]) {
      try {
        callback(snapshot, event);
      } catch (error) {
        console.error("[WardOS Alert Engine] Listener error:", error);
      }
    }
  }

  // ------------------------------------------------------------
  // NORMALISATION (kept from the original engine)
  // ------------------------------------------------------------

  normalizeSeverity(value) {
    const severity = String(value || "WARNING").trim().toUpperCase();
    if (["CRITICAL", "EMERGENCY", "DANGER"].includes(severity)) return "CRITICAL";
    if (["INFO", "NORMAL"].includes(severity)) return "INFO";
    // ATTENTION was the original name for WARNING.
    return "WARNING";
  }

  normalizeVital(alert = {}) {
    const raw = String(alert.vital ?? alert.vitalType ?? alert.vital_type ?? "")
      .trim().toLowerCase().replace(/₂/g, "2");

    if (/\b(hr|heart.?rate|pulse)\b/.test(raw)) return "HR";
    if (/\b(spo2|oxygen|oxygen saturation)\b/.test(raw)) return "SPO2";
    if (/\b(temp|temperature)\b/.test(raw)) return "TEMP";
    if (/\banomaly\b/.test(raw)) return "ANOMALY";
    if (/\bemergency\b/.test(raw)) return "EMERGENCY";
    if (/\b(device|sensor)\b/.test(raw)) return "DEVICE";
    return "UNKNOWN";
  }

  graceFor(alert) {
    const grace = config.alerts?.clearGraceMs ?? {};
    if (alert.severity === "CRITICAL") return grace.CRITICAL ?? 30000;
    if (alert.type === "ANOMALY") return grace.ANOMALY ?? 10000;
    return grace.DEFAULT ?? 15000;
  }

  // ------------------------------------------------------------
  // PUBLIC SHAPE
  // Booleans are kept for code written against the old engine.
  // ------------------------------------------------------------

  toPublic(alert) {
    return {
      ...alert,
      acknowledged: alert.status === ALERT_STATUS.ACKNOWLEDGED || !!alert.acknowledgedAt,
      resolved: alert.status === ALERT_STATUS.RESOLVED,
      expired: alert.status === ALERT_STATUS.EXPIRED,
      open: OPEN.has(alert.status)
    };
  }

  // ------------------------------------------------------------
  // RAISE / DEDUPLICATE
  // ------------------------------------------------------------

  createKey(patientId, conditionKey) {
    return `${String(patientId).toLowerCase()}|${conditionKey}`;
  }

  findOpen(key) {
    return this.alerts.find(alert => alert.key === key && OPEN.has(alert.status)) || null;
  }

  /**
   * Raise (or refresh) an alert for an active condition.
   * Required: patientId, conditionKey. Everything else descriptive.
   */
  raise(data = {}) {
    if (data.patientId === undefined || data.patientId === null || !data.conditionKey) {
      console.warn("[WardOS Alert Engine] raise() needs patientId and conditionKey", data);
      return null;
    }

    const now = this.now();
    const key = this.createKey(data.patientId, data.conditionKey);
    const existing = this.findOpen(key);

    if (existing) {
      existing.lastUpdated = now;
      if (data.value !== undefined && data.value !== null) existing.value = data.value;
      if (data.message) existing.message = data.message;
      if (data.note !== undefined) existing.note = data.note;

      const wasCleared = !existing.conditionActive;
      existing.conditionActive = true;
      existing.conditionClearedAt = null;
      this.cancelClearTimer(existing.id);

      // Only notify listeners when something meaningful changed
      // (condition re-activated). Value refreshes are quiet so a
      // 1 Hz stream does not flood the UI with alert events.
      if (wasCleared) this.notify(existing, "UPDATED");
      return this.toPublic(existing);
    }

    this.alertCounter += 1;
    const severity = this.normalizeSeverity(data.severity);

    const alert = {
      id: data.id ?? `${this.idPrefix}-${now.toString(36).toUpperCase()}-${this.alertCounter}`,
      key,
      conditionKey: data.conditionKey,
      patientId: data.patientId,
      mrn: data.mrn ?? null,
      patientName: data.patientName ?? "Unknown patient",
      deviceId: data.deviceId ?? null,
      ward: data.ward ?? null,
      wardId: data.wardId ?? null,
      bed: data.bed ?? null,
      type: String(data.type || severity).toUpperCase(),
      severity,
      vital: this.normalizeVital(data),
      value: data.value ?? null,
      unit: data.unit ?? "",
      threshold: data.threshold ?? null,
      message: data.message ?? `${data.patientName ?? "Patient"}: monitoring alert`,
      note: data.note ?? null,
      source: data.source ?? "VITAL_MONITOR",
      sim: data.sim === true,
      status: ALERT_STATUS.NEW,
      conditionActive: true,
      conditionClearedAt: null,
      createdAt: now,
      lastUpdated: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
      acknowledgedByName: null,
      resolvedAt: null,
      resolvedBy: null,
      resolvedByName: null,
      resolutionNote: null,
      expiredAt: null
    };

    this.alerts.push(alert);
    this.notify(alert, "CREATED");
    return this.toPublic(alert);
  }

  /**
   * Backwards-compatible entry point used by the original
   * StateStore. Maps to raise().
   */
  addAlert(data = {}) {
    const conditionKey =
      data.conditionKey ??
      `${String(data.type || "ALERT").toLowerCase()}:${this.normalizeVital(data).toLowerCase()}`;
    return this.raise({ ...data, conditionKey, patientId: data.patientId ?? data.deviceId });
  }

  // ------------------------------------------------------------
  // CONDITION CLEARED
  // ------------------------------------------------------------

  clearCondition(patientId, conditionKey) {
    const alert = this.findOpen(this.createKey(patientId, conditionKey));
    if (!alert || !alert.conditionActive) return null;

    alert.conditionActive = false;
    alert.conditionClearedAt = this.now();
    alert.lastUpdated = alert.conditionClearedAt;
    this.notify(alert, "UPDATED");
    this.scheduleAutoClose(alert);
    return this.toPublic(alert);
  }

  /** Legacy helper: clear every open condition for a vital. */
  resolveCondition({ patientId, deviceId, vital } = {}) {
    const pid = patientId ?? deviceId;
    const target = this.normalizeVital({ vital });
    let count = 0;
    for (const alert of this.alerts) {
      if (String(alert.patientId) === String(pid) && OPEN.has(alert.status) &&
          (target === "UNKNOWN" || alert.vital === target)) {
        if (this.clearCondition(alert.patientId, alert.conditionKey)) count += 1;
      }
    }
    return count;
  }

  scheduleAutoClose(alert) {
    this.cancelClearTimer(alert.id);

    const remaining = Math.max(0, this.graceFor(alert) - (this.now() - (alert.conditionClearedAt ?? this.now())));

    const timer = unrefTimer(setTimeout(() => {
      this.clearTimers.delete(alert.id);
      this.autoClose(alert.id);
    }, remaining));

    this.clearTimers.set(alert.id, timer);
  }

  autoClose(alertId) {
    const alert = this.alerts.find(item => item.id === alertId);
    if (!alert || !OPEN.has(alert.status) || alert.conditionActive) return;

    const now = this.now();

    if (alert.status === ALERT_STATUS.ACKNOWLEDGED) {
      alert.status = ALERT_STATUS.RESOLVED;
      alert.resolvedAt = now;
      alert.resolvedBy = "system";
      alert.resolvedByName = "WardOS";
      alert.resolutionNote = "Condition cleared after acknowledgement";
      alert.lastUpdated = now;
      this.notify(alert, "RESOLVED");
      this.trimClosed();
      return;
    }

    // NEW + condition cleared
    if (alert.severity !== "CRITICAL") {
      alert.status = ALERT_STATUS.EXPIRED;
      alert.expiredAt = now;
      alert.lastUpdated = now;
      this.notify(alert, "EXPIRED");
      this.trimClosed();
    }
    // CRITICAL stays NEW until a person acknowledges it.
  }

  cancelClearTimer(alertId) {
    const timer = this.clearTimers.get(alertId);
    if (timer) {
      clearTimeout(timer);
      this.clearTimers.delete(alertId);
    }
  }

  // ------------------------------------------------------------
  // ACKNOWLEDGE / RESOLVE
  // ------------------------------------------------------------

  acknowledge(alertId, user = {}) {
    const alert = this.alerts.find(item => item.id === alertId);
    if (!alert) return { ok: false, error: "NOT_FOUND" };
    if (alert.status !== ALERT_STATUS.NEW) return { ok: false, error: "NOT_NEW", alert: this.toPublic(alert) };

    const now = this.now();
    alert.status = ALERT_STATUS.ACKNOWLEDGED;
    alert.acknowledgedAt = now;
    alert.acknowledgedBy = user.id ?? null;
    alert.acknowledgedByName = user.name ?? "Unknown user";
    alert.lastUpdated = now;
    this.notify(alert, "ACKNOWLEDGED");

    // Condition already gone: close once the grace period has passed.
    if (!alert.conditionActive) this.scheduleAutoClose(alert);

    return { ok: true, alert: this.toPublic(alert) };
  }

  resolve(alertId, user = {}, note = "") {
    const alert = this.alerts.find(item => item.id === alertId);
    if (!alert) return { ok: false, error: "NOT_FOUND" };
    if (!OPEN.has(alert.status)) return { ok: false, error: "NOT_OPEN", alert: this.toPublic(alert) };
    if (alert.conditionActive) return { ok: false, error: "CONDITION_ACTIVE", alert: this.toPublic(alert) };

    const now = this.now();
    if (!alert.acknowledgedAt) {
      alert.acknowledgedAt = now;
      alert.acknowledgedBy = user.id ?? null;
      alert.acknowledgedByName = user.name ?? "Unknown user";
    }
    alert.status = ALERT_STATUS.RESOLVED;
    alert.resolvedAt = now;
    alert.resolvedBy = user.id ?? null;
    alert.resolvedByName = user.name ?? "Unknown user";
    alert.resolutionNote = String(note || "").slice(0, 500) || null;
    alert.lastUpdated = now;
    this.cancelClearTimer(alert.id);
    this.notify(alert, "RESOLVED");
    this.trimClosed();
    return { ok: true, alert: this.toPublic(alert) };
  }

  /**
   * Close every open alert for a patient (e.g. on discharge or
   * when a device is unassigned). Recorded as a system action.
   */
  closeAllForPatient(patientId, reason = "Patient discharged") {
    const now = this.now();
    for (const alert of this.alerts) {
      if (String(alert.patientId) !== String(patientId) || !OPEN.has(alert.status)) continue;
      this.cancelClearTimer(alert.id);
      alert.conditionActive = false;
      alert.status = ALERT_STATUS.RESOLVED;
      alert.resolvedAt = now;
      alert.resolvedBy = "system";
      alert.resolvedByName = "WardOS";
      alert.resolutionNote = reason;
      alert.lastUpdated = now;
      this.notify(alert, "RESOLVED");
    }
    this.trimClosed();
  }

  // ------------------------------------------------------------
  // RESTORE (backend boot - reload open alerts from database)
  // ------------------------------------------------------------

  restore(records = []) {
    for (const record of records) {
      if (!OPEN.has(record.status)) continue;
      if (this.alerts.some(alert => alert.id === record.id)) continue;
      this.alerts.push({ ...record });
      if (!record.conditionActive) this.scheduleAutoClose(record);
    }
    this.alertCounter = Math.max(this.alertCounter, this.alerts.length);
  }

  // ------------------------------------------------------------
  // QUERIES
  // ------------------------------------------------------------

  getAlert(alertId) {
    const alert = this.alerts.find(item => item.id === alertId);
    return alert ? this.toPublic(alert) : null;
  }

  getOpenAlerts() {
    return this.alerts.filter(alert => OPEN.has(alert.status)).map(alert => this.toPublic(alert));
  }

  /** Unacknowledged open alerts (what needs a human now). */
  getActiveAlerts() {
    return this.alerts.filter(alert => alert.status === ALERT_STATUS.NEW).map(alert => this.toPublic(alert));
  }

  getCriticalAlerts() {
    return this.getActiveAlerts().filter(alert => alert.severity === "CRITICAL");
  }

  getPatientAlerts(patientId) {
    return this.alerts
      .filter(alert => String(alert.patientId) === String(patientId))
      .map(alert => this.toPublic(alert));
  }

  getWardAlerts(wardId) {
    return this.alerts
      .filter(alert => String(alert.wardId) === String(wardId))
      .map(alert => this.toPublic(alert));
  }

  getActiveCount() {
    return this.getActiveAlerts().length;
  }

  getCriticalCount() {
    return this.getCriticalAlerts().length;
  }

  // ------------------------------------------------------------
  // MEMORY HYGIENE
  // Closed alerts live in the database; only a small recent tail
  // is kept in memory.
  // ------------------------------------------------------------

  trimClosed() {
    const closed = this.alerts.filter(alert => !OPEN.has(alert.status));
    if (closed.length <= MAX_CLOSED_IN_MEMORY) return;
    const drop = new Set(closed.slice(0, closed.length - MAX_CLOSED_IN_MEMORY).map(alert => alert.id));
    this.alerts = this.alerts.filter(alert => !drop.has(alert.id));
  }

  cleanup() {
    this.trimClosed();
  }

  clearAll() {
    for (const timer of this.clearTimers.values()) clearTimeout(timer);
    this.clearTimers.clear();
    this.alerts = [];
  }
}

export const alertEngine = new AlertEngine();
