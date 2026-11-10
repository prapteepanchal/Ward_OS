// ============================================================
// WardOS - Monitoring pipeline (backend)
//
//   MQTT -> MqttClientManager queue -> validatePayload
//        -> dedupe -> StateStore (status + alert conditions)
//        -> AlertEngine -> SQLite persistence -> live stream
//
// Also runs the device monitor (offline detection) and the
// broker link-loss handling.
// ============================================================

import { config } from "../shared/config.js";
import { validatePayload } from "../shared/payload.js";
import { StateStore } from "../shared/state_store.js";
import { AlertEngine } from "../shared/alert_engine.js";
import { loadDirectory, alertRowToRecord } from "./directory.js";
import { transaction } from "./db.js";

export class MonitoringService {
  constructor({ db, mqtt = null, retentionDays = 30, now = () => Date.now() }) {
    this.db = db;
    this.mqtt = mqtt;
    this.now = now;
    this.retentionDays = retentionDays;
    this.alertEngine = new AlertEngine({ now });
    this.stateStore = new StateStore({ alertEngine: this.alertEngine, now });
    this.directory = new Map();
    this.readingBuffer = [];
    this.recentSeqs = new Map();       // `${device}|${kind}` -> Set(seq)
    this.deviceLastSeen = new Map();   // deviceId -> ts (flushed to DB)
    this.invalidLog = [];              // recent invalid payloads (for diagnostics)
    this.listeners = new Set();
    this.timers = [];
    this.startedAt = now();
    this.brokerEverConnected = false;

    this.alertEngine.subscribe((alert, event) => this.persistAlert(alert, event));

    this.insertReading = db.prepare(`
      INSERT INTO readings (patient_id, device_id, ts, received_at, seq, kind, hr, spo2, temp, emergency, removed, anomaly, source_path, status, sim)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertAlertStmt = db.prepare(`
      INSERT INTO alerts (id, patient_id, mrn, patient_name, device_id, ward_id, ward, bed, condition_key, type, severity, vital, value, unit, threshold,
        message, note, source, sim, status, condition_active, condition_cleared_at, created_at, last_updated, acknowledged_at, acknowledged_by,
        acknowledged_by_name, resolved_at, resolved_by, resolved_by_name, resolution_note, expired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        value = excluded.value, message = excluded.message, note = excluded.note, status = excluded.status,
        condition_active = excluded.condition_active, condition_cleared_at = excluded.condition_cleared_at,
        last_updated = excluded.last_updated, acknowledged_at = excluded.acknowledged_at, acknowledged_by = excluded.acknowledged_by,
        acknowledged_by_name = excluded.acknowledged_by_name, resolved_at = excluded.resolved_at, resolved_by = excluded.resolved_by,
        resolved_by_name = excluded.resolved_by_name, resolution_note = excluded.resolution_note, expired_at = excluded.expired_at
    `);
  }

  // ------------------------------------------------------------
  // EVENTS for the live stream
  //   ("patient", patientId) ("alert", alert, event)
  //   ("system") ("directory")
  // ------------------------------------------------------------

  on(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emit(...args) {
    for (const callback of this.listeners) {
      try { callback(...args); } catch (error) { console.error("[WardOS] listener error", error); }
    }
  }

  // ------------------------------------------------------------
  // START / STOP
  // ------------------------------------------------------------

  start() {
    this.reloadDirectory();
    this.restoreAlerts();

    // Until the broker connects, device state is unknown.
    this.stateStore.setLinkLost(true);

    this.stateStore.subscribe((deviceId, state) => {
      if (deviceId === null) this.emit("patients");
      else if (state?.patientId) this.emit("patient", state.patientId);
    });

    if (this.mqtt) {
      this.mqtt.setProcessor((topic, payload, receivedAt) => this.ingest(topic, payload, receivedAt));
      this.mqtt.onStatus(info => this.onBrokerStatus(info));
    }

    this.timers.push(setInterval(() => this.flushReadings(), 1000));
    this.timers.push(setInterval(() => this.checkDevices(), 1000));
    this.timers.push(setInterval(() => this.flushDeviceLastSeen(), 15000));
    this.timers.push(setInterval(() => this.purgeOldReadings(), 6 * 3600 * 1000));
    for (const timer of this.timers) timer.unref?.();
    this.purgeOldReadings();
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.flushReadings();
    this.flushDeviceLastSeen();
    this.alertEngine.clearAll();
  }

  reloadDirectory() {
    this.directory = loadDirectory(this.db);
    this.stateStore.syncWithRegistry();
    this.emit("directory");
  }

  restoreAlerts() {
    const rows = this.db.prepare("SELECT * FROM alerts WHERE status IN ('NEW','ACKNOWLEDGED')").all();
    const records = rows.map(alertRowToRecord);
    // Conditions must be re-confirmed by fresh telemetry after a
    // restart; mark them cleared so they close normally if they
    // don't recur (critical ones still need acknowledgement).
    for (const record of records) {
      if (record.conditionActive) {
        record.conditionActive = false;
        record.conditionClearedAt = this.now();
      }
    }
    this.alertEngine.restore(records);

    // Re-seed condition tracking so recurring conditions dedupe
    // onto the restored alert instead of creating a new one.
    console.log(`[WardOS] Restored ${records.length} open alert(s) from database`);
  }

  // ------------------------------------------------------------
  // BROKER STATUS
  // ------------------------------------------------------------

  onBrokerStatus(info) {
    const linkUp = info.status === "CONNECTED" || info.status === "RAW MODE";
    if (linkUp) this.brokerEverConnected = true;
    this.stateStore.setLinkLost(!linkUp);
    this.emit("system");
  }

  // ------------------------------------------------------------
  // INGEST
  // ------------------------------------------------------------

  ingest(topic, input, receivedAt = this.now()) {
    if (topic !== config.mqtt.cleanTopic && topic !== config.mqtt.rawTopic) return true;

    const result = validatePayload(input, { now: receivedAt });
    if (!result.ok) {
      this.recordInvalid(topic, result.errors);
      return false;
    }
    if (result.errors.length) this.recordInvalid(topic, result.errors, result.payload.device_id);

    const payload = { ...result.payload, topic };
    const kind = topic === config.mqtt.cleanTopic ? "clean" : "raw";

    // Duplicate suppression (QoS re-delivery, bridged brokers...).
    if (payload.seq !== null) {
      const key = `${payload.device_id}|${kind}`;
      let seen = this.recentSeqs.get(key);
      if (!seen) this.recentSeqs.set(key, (seen = new Set()));
      if (seen.has(payload.seq)) return true;
      seen.add(payload.seq);
      if (seen.size > 64) seen.delete(seen.values().next().value);
    }

    this.deviceLastSeen.set(payload.device_id, receivedAt);

    const state = this.stateStore.updateState(payload);
    const assignedPatient = state?.patientId ?? this.stateStore.getState(payload.device_id)?.patientId;

    if (!assignedPatient) {
      this.emit("unassigned", payload.device_id);
      return true;
    }

    const removed = payload.hr === "REMOVED" || payload.emergency === "REMOVED";
    this.readingBuffer.push([
      assignedPatient,
      payload.device_id,
      payload.ts,
      receivedAt,
      payload.seq,
      kind,
      removed ? null : numberOrNull(payload.hr),
      removed ? null : numberOrNull(payload.spo2),
      removed ? null : numberOrNull(payload.temp),
      payload.emergency ?? null,
      removed ? 1 : 0,
      payload.anomaly_detected ? 1 : 0,
      payload.source_path ?? (kind === "raw" ? "RAW" : null),
      state?.status ?? null,
      payload.sim ? 1 : 0
    ]);

    if (this.readingBuffer.length >= 500) this.flushReadings();
    return true;
  }

  recordInvalid(topic, errors, deviceId = null) {
    this.invalidLog.push({ at: this.now(), topic, deviceId, errors });
    if (this.invalidLog.length > 50) this.invalidLog.shift();
  }

  flushReadings() {
    if (!this.readingBuffer.length) return;
    const batch = this.readingBuffer.splice(0);
    try {
      transaction(this.db, () => {
        for (const row of batch) this.insertReading.run(...row);
      });
    } catch (error) {
      console.error("[WardOS] Failed to persist readings:", error.message);
    }
  }

  flushDeviceLastSeen() {
    if (!this.deviceLastSeen.size) return;
    const entries = [...this.deviceLastSeen];
    this.deviceLastSeen.clear();
    const stmt = this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?");
    try {
      transaction(this.db, () => { for (const [id, ts] of entries) stmt.run(ts, id); });
    } catch (error) {
      console.error("[WardOS] Failed to update device last-seen:", error.message);
    }
  }

  purgeOldReadings() {
    if (!this.retentionDays) return;
    const cutoff = this.now() - this.retentionDays * 86400000;
    const result = this.db.prepare("DELETE FROM readings WHERE ts < ?").run(cutoff);
    if (result.changes) console.log(`[WardOS] Purged ${result.changes} readings older than ${this.retentionDays} days`);
  }

  // ------------------------------------------------------------
  // DEVICE MONITOR (offline detection)
  // ------------------------------------------------------------

  checkDevices() {
    if (this.stateStore.linkLost) return;
    const now = this.now();
    const { offlineAfterMs, offlineAlertAfterMs } = config.devices;

    for (const state of this.stateStore.getAllStates()) {
      if ((state.deviceStatus === "online" || state.deviceStatus === "removed") &&
          state.lastSeen && now - state.lastSeen > offlineAfterMs) {
        this.stateStore.markOffline(state.deviceId);
      }

      const silentFor =
        state.deviceStatus === "offline" ? now - (state.lastSeen ?? now) :
        state.deviceStatus === "no-data" ? now - (state.awaitingSince ?? now) : 0;

      if (silentFor > offlineAlertAfterMs) this.stateStore.raiseOfflineAlert(state.deviceId);
    }
  }

  // ------------------------------------------------------------
  // ALERT PERSISTENCE
  // ------------------------------------------------------------

  persistAlert(a, event) {
    try {
      this.upsertAlertStmt.run(
        a.id, a.patientId, a.mrn, a.patientName, a.deviceId, a.wardId, a.ward, a.bed, a.conditionKey, a.type, a.severity,
        a.vital, numberOrNull(a.value), a.unit, numberOrNull(a.threshold), a.message, a.note, a.source, a.sim ? 1 : 0,
        a.status, a.conditionActive ? 1 : 0, a.conditionClearedAt, a.createdAt, a.lastUpdated, a.acknowledgedAt,
        typeof a.acknowledgedBy === "number" ? a.acknowledgedBy : null, a.acknowledgedByName, a.resolvedAt,
        a.resolvedBy !== null && a.resolvedBy !== undefined ? String(a.resolvedBy) : null, a.resolvedByName, a.resolutionNote, a.expiredAt
      );
    } catch (error) {
      console.error("[WardOS] Failed to persist alert:", error.message);
    }
    this.emit("alert", a, event);
  }

  // ------------------------------------------------------------
  // QUERIES
  // ------------------------------------------------------------

  getState(patientId) {
    return this.stateStore.getStateByPatient(patientId);
  }

  systemStatus() {
    const broker = this.mqtt ? this.mqtt.getConnectionInfo() : { status: "DISABLED" };
    const states = this.stateStore.getAllStates();
    return {
      now: this.now(),
      startedAt: this.startedAt,
      broker: {
        status: broker.status,
        url: broker.url,
        rawMode: broker.rawMode ?? false,
        lastError: broker.lastError ?? null,
        connectedSince: broker.connectedSince ?? null,
        nextReconnectAt: broker.nextReconnectAt ?? null,
        everConnected: this.brokerEverConnected,
        stats: broker.stats ?? null
      },
      devices: {
        assigned: states.length,
        online: states.filter(s => s.deviceStatus === "online").length,
        unassignedDetected: this.stateStore.getUnassignedDevices().length
      },
      simulation: states.some(s => s.sim && s.deviceStatus === "online")
    };
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
