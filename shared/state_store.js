// ============================================================
// WardOS - State Store
// File: shared/state_store.js
//
// Live per-device state + status derivation. Runs on the
// backend (authoritative). Dashboards receive the resulting
// patient states over the live stream.
//
// TWO SEPARATE STATUSES
//
//  deviceStatus  - is the wearable delivering data?
//      "online"     telemetry received recently
//      "offline"    no telemetry for config.devices.offlineAfterMs
//      "removed"    band reports the sensor was taken off
//      "no-data"    assigned but never heard from since start-up
//      "link-lost"  the backend lost the MQTT broker, so device
//                   state is UNKNOWN (not the device's fault)
//
//  status (overall, what the ward sees) - priority order:
//      1. "removed"   sensor removed
//      2. "offline"   device offline / no data / broker link lost
//      3. "critical"  device EMERGENCY or a critical threshold
//      4. "warning"   ML anomaly flag or a warning threshold
//      5. "ok"        stable
//
//  deriveStatus() keeps the original clinical ordering
//  (removed > emergency/critical > anomaly > warning > ok);
//  connectivity is layered on top in overallStatus().
// ============================================================

import { config } from "./config.js";
import { DeviceRegistry } from "./device_registry.js";
import { alertEngine as defaultAlertEngine } from "./alert_engine.js";
import { parseVitalValue } from "./payload.js";

const VITAL_KEYS = ["hr", "spo2", "temp"];

export class StateStore {
  constructor({ alertEngine = defaultAlertEngine, now = () => Date.now() } = {}) {
    this.alertEngine = alertEngine;
    this.now = now;
    this.beds = new Map();            // deviceId -> state (assigned devices)
    this.unassigned = new Map();      // deviceId -> { deviceId, lastSeen, seq }
    this.listeners = [];
    this.activeConditions = new Map(); // deviceId -> Map(conditionKey -> patientId)
    this.linkLost = false;
  }

  // ------------------------------------------------------------
  // SUBSCRIPTIONS
  // ------------------------------------------------------------

  subscribe(callback) {
    if (typeof callback !== "function") {
      console.warn("[WardOS StateStore] Invalid subscriber.");
      return () => {};
    }
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(listener => listener !== callback);
    };
  }

  notify(deviceId) {
    for (const callback of this.listeners) {
      try {
        callback(deviceId, deviceId === null ? null : this.getState(deviceId));
      } catch (error) {
        console.error("[WardOS StateStore] Listener error:", error);
      }
    }
  }

  // ------------------------------------------------------------
  // HELPERS
  // ------------------------------------------------------------

  parseVital(value, key) {
    return parseVitalValue(value, key).value;
  }

  hasValue(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  isEmergency(value) {
    return String(value ?? "").trim().toUpperCase() === "EMERGENCY";
  }

  // ------------------------------------------------------------
  // THRESHOLD EVALUATION
  // ------------------------------------------------------------

  getCriticalVitals(vitals = {}) {
    const result = [];
    const t = config.thresholds;
    const hr = this.parseVital(vitals.hr, "hr");
    const spo2 = this.parseVital(vitals.spo2, "spo2");
    const temp = this.parseVital(vitals.temp, "temp");

    if (hr !== null) {
      if (hr > t.hr.criticalHigh) result.push(item("Heart Rate", "hr", hr, "BPM", "HIGH", t.hr.criticalHigh, `Heart rate critically high: ${hr} BPM`));
      if (hr < t.hr.criticalLow) result.push(item("Heart Rate", "hr", hr, "BPM", "LOW", t.hr.criticalLow, `Heart rate critically low: ${hr} BPM`));
    }
    if (spo2 !== null && spo2 < t.spo2.criticalLow) {
      result.push(item("SpO2", "spo2", spo2, "%", "LOW", t.spo2.criticalLow, `Oxygen saturation critically low: ${spo2}%`));
    }
    if (temp !== null) {
      if (temp > t.temp.criticalHigh) result.push(item("Temperature", "temp", temp, "°C", "HIGH", t.temp.criticalHigh, `Temperature critically high: ${temp.toFixed(1)}°C`));
      if (temp < t.temp.criticalLow) result.push(item("Temperature", "temp", temp, "°C", "LOW", t.temp.criticalLow, `Temperature critically low: ${temp.toFixed(1)}°C`));
    }
    return result;
  }

  getWarningVitals(vitals = {}) {
    const result = [];
    const t = config.thresholds;
    const hr = this.parseVital(vitals.hr, "hr");
    const spo2 = this.parseVital(vitals.spo2, "spo2");
    const temp = this.parseVital(vitals.temp, "temp");

    if (hr !== null) {
      if (t.hr.warningHigh !== undefined && hr > t.hr.warningHigh && hr <= t.hr.criticalHigh) {
        result.push(item("Heart Rate", "hr", hr, "BPM", "HIGH", t.hr.warningHigh, `Heart rate high: ${hr} BPM`));
      }
      if (t.hr.warningLow !== undefined && hr < t.hr.warningLow && hr >= t.hr.criticalLow) {
        result.push(item("Heart Rate", "hr", hr, "BPM", "LOW", t.hr.warningLow, `Heart rate low: ${hr} BPM`));
      }
    }
    if (spo2 !== null && t.spo2.warningLow !== undefined && spo2 < t.spo2.warningLow && spo2 >= t.spo2.criticalLow) {
      result.push(item("SpO2", "spo2", spo2, "%", "LOW", t.spo2.warningLow, `Oxygen saturation low: ${spo2}%`));
    }
    if (temp !== null) {
      if (t.temp.warningHigh !== undefined && temp > t.temp.warningHigh && temp <= t.temp.criticalHigh) {
        result.push(item("Temperature", "temp", temp, "°C", "HIGH", t.temp.warningHigh, `Temperature elevated: ${temp.toFixed(1)}°C`));
      }
      if (t.temp.warningLow !== undefined && temp < t.temp.warningLow && temp >= t.temp.criticalLow) {
        result.push(item("Temperature", "temp", temp, "°C", "LOW", t.temp.warningLow, `Temperature low: ${temp.toFixed(1)}°C`));
      }
    }
    return result;
  }

  // ------------------------------------------------------------
  // STATUS DERIVATION (clinical) - original ordering preserved:
  // removed > emergency / critical > anomaly > warning > ok
  // ------------------------------------------------------------

  deriveStatus(payload = {}) {
    if (typeof payload.hr === "string" && payload.hr.trim().toUpperCase() === "REMOVED") return "removed";
    if (payload.removed === true) return "removed";
    if (this.isEmergency(payload.emergency)) return "critical";
    if (this.getCriticalVitals(payload).length > 0) return "critical";
    if (payload.anomaly_detected === true || payload.anomalyDetected === true) return "warning";
    if (this.getWarningVitals(payload).length > 0) return "warning";
    return "ok";
  }

  /** Overall status = connectivity layered over clinical status. */
  overallStatus(state) {
    if (state.deviceStatus === "removed") return "removed";
    if (["offline", "no-data", "link-lost"].includes(state.deviceStatus)) return "offline";
    return state.clinicalStatus;
  }

  // ------------------------------------------------------------
  // STATE SHAPE
  // ------------------------------------------------------------

  createInitialState(deviceId, info) {
    return {
      deviceId: String(deviceId),
      patientId: info.patientId,
      mrn: info.mrn ?? info.id ?? null,
      patientName: info.patientName ?? "Unknown patient",
      age: info.age ?? null,
      ward: info.ward ?? null,
      wardId: info.wardId ?? null,
      bed: info.bed ?? null,
      lastSeen: null,          // receive time of last telemetry (any topic)
      lastReadingAt: null,     // timestamp of the reading shown
      lastCleanAt: null,
      vitals: { hr: null, spo2: null, temp: null, emergency: "OK" },
      mlMeta: { cleaned: null, anomalyDetected: false, sourcePath: "NONE" },
      flags: { critical: [], warning: [] },
      seq: null,
      sim: false,
      clinicalStatus: "ok",
      deviceStatus: this.linkLost ? "link-lost" : "no-data",
      awaitingSince: this.now(),
      status: "offline"
    };
  }

  /** Make sure every assigned device has a state entry. */
  syncWithRegistry() {
    const seen = new Set();

    for (const entry of DeviceRegistry.getAllDevices()) {
      if (!entry.patientId) continue;
      const deviceId = String(entry.deviceId);
      seen.add(deviceId);
      const existing = this.beds.get(deviceId);

      if (existing && String(existing.patientId) === String(entry.patientId)) {
        Object.assign(existing, {
          mrn: entry.mrn, patientName: entry.patientName, age: entry.age ?? null,
          ward: entry.ward, wardId: entry.wardId, bed: entry.bed
        });
        continue;
      }

      // New assignment (or device moved to another patient):
      // never carry the previous patient's readings over.
      if (existing) this.clearConditions(deviceId);
      const state = this.createInitialState(deviceId, entry);
      this.beds.set(deviceId, state);
      this.unassigned.delete(deviceId);
      this.notify(deviceId);
    }

    for (const deviceId of [...this.beds.keys()]) {
      if (!seen.has(deviceId)) this.removeDevice(deviceId);
    }
  }

  // ------------------------------------------------------------
  // ALERT CONDITION TRACKING
  // One alert per condition; conditions that disappear are
  // reported as cleared so the engine can close them.
  // ------------------------------------------------------------

  buildConditions(state, criticalVitals, warningVitals, emergency, anomaly) {
    const conditions = [];
    const caveat = anomaly
      ? "Sensor anomaly flagged on this reading - verify the patient physically before acting."
      : null;

    for (const v of criticalVitals) {
      conditions.push({
        conditionKey: `critical:${v.key}:${v.direction}`, type: "VITAL_CRITICAL", severity: "CRITICAL",
        vital: v.vital, value: v.value, unit: v.unit, threshold: v.threshold,
        source: "VITAL_THRESHOLD", text: v.message, note: caveat
      });
    }

    if (emergency) {
      conditions.push({
        conditionKey: "device:emergency", type: "EMERGENCY", severity: "CRITICAL",
        vital: "Emergency", source: "DEVICE_EMERGENCY",
        text: "Emergency signal raised by the wearable", note: caveat
      });
    }

    if (anomaly) {
      conditions.push({
        conditionKey: "ml:anomaly", type: "ANOMALY", severity: "WARNING",
        vital: "Anomaly", source: "ML_ANOMALY",
        text: "Signal-quality anomaly flagged by the cleaning pipeline (not a clinical finding)"
      });
    }

    for (const v of warningVitals) {
      if (criticalVitals.some(c => c.key === v.key)) continue;
      conditions.push({
        conditionKey: `warning:${v.key}:${v.direction}`, type: "VITAL_WARNING", severity: "WARNING",
        vital: v.vital, value: v.value, unit: v.unit, threshold: v.threshold,
        source: "VITAL_THRESHOLD", text: v.message
      });
    }

    return conditions;
  }

  applyConditions(deviceId, state, conditions) {
    if (!state.patientId) return;

    const previous = this.activeConditions.get(deviceId) ?? new Map();
    const current = new Map();

    for (const c of conditions) {
      current.set(c.conditionKey, state.patientId);
      this.alertEngine.raise({
        ...c,
        patientId: state.patientId,
        mrn: state.mrn,
        patientName: state.patientName,
        deviceId,
        ward: state.ward,
        wardId: state.wardId,
        bed: state.bed,
        sim: state.sim,
        message: `${c.text}. ${state.patientName}, ${state.ward ?? "ward ?"} bed ${state.bed ?? "?"}.`
      });
    }

    for (const [conditionKey, patientId] of previous) {
      // Offline conditions are owned by markOffline / the monitor.
      if (conditionKey === "device:offline") {
        current.set(conditionKey, patientId);
        continue;
      }
      if (!current.has(conditionKey)) this.alertEngine.clearCondition(patientId, conditionKey);
    }

    this.activeConditions.set(deviceId, current);
  }

  clearConditions(deviceId) {
    const previous = this.activeConditions.get(deviceId);
    if (previous) {
      for (const [conditionKey, patientId] of previous) {
        this.alertEngine.clearCondition(patientId, conditionKey);
      }
    }
    this.activeConditions.delete(deviceId);
  }

  // ------------------------------------------------------------
  // UPDATE STATE (expects a payload from validatePayload)
  // ------------------------------------------------------------

  updateState(payload = {}) {
    const rawDeviceId = payload.device_id ?? payload.deviceId;
    if (rawDeviceId === null || rawDeviceId === undefined || String(rawDeviceId).trim() === "") {
      console.warn("[WardOS StateStore] Received payload without device ID");
      return null;
    }

    const deviceId = String(rawDeviceId);
    const now = this.now();
    let state = this.beds.get(deviceId);

    if (!state) {
      const info = DeviceRegistry.getDeviceInfo(deviceId);
      if (!info) {
        // Unknown / unassigned device: track that it exists so staff
        // can register it, but never attach readings to a patient.
        const entry = this.unassigned.get(deviceId) ?? { deviceId, firstSeen: now };
        entry.lastSeen = now;
        entry.seq = payload.seq ?? null;
        this.unassigned.set(deviceId, entry);
        return null;
      }
      state = this.createInitialState(deviceId, info);
      this.beds.set(deviceId, state);
    }

    const topic = payload.topic;
    const sourcePath = String(payload.source_path ?? payload.sourcePath ?? "").toUpperCase();
    const isClean =
      topic === config.mqtt.cleanTopic ||
      (topic === undefined && (payload.cleaned === true || ["ML", "STAT", "CLEAN", "CLEANED", "ANOMALY_REPLACED"].includes(sourcePath)));

    state.lastSeen = now;
    state.sim = payload.sim === true;

    // Cleaned telemetry always wins. Raw readings only drive the
    // display when cleaned data for this device has gone stale.
    if (!isClean && state.lastCleanAt && now - state.lastCleanAt < config.devices.cleanPriorityMs) {
      if (state.deviceStatus !== "online" && state.deviceStatus !== "removed") {
        state.deviceStatus = "online";
        state.status = this.overallStatus(state);
        this.notify(deviceId);
      }
      return state;
    }

    if (isClean) state.lastCleanAt = now;

    const removed =
      (typeof payload.hr === "string" && payload.hr.toUpperCase() === "REMOVED") ||
      String(payload.emergency ?? "").toUpperCase() === "REMOVED";

    const vitals = { ...state.vitals };

    if (removed) {
      // Never show the last real reading as if it were current.
      vitals.hr = null;
      vitals.spo2 = null;
      vitals.temp = null;
      vitals.emergency = "REMOVED";
    } else {
      for (const key of VITAL_KEYS) {
        if (this.hasValue(payload, key)) vitals[key] = this.parseVital(payload[key], key);
      }
      if (this.hasValue(payload, "emergency") && payload.emergency !== undefined) {
        vitals.emergency = payload.emergency;
      } else if (vitals.emergency === "REMOVED") {
        vitals.emergency = "OK";
      }
    }

    const anomaly = this.hasValue(payload, "anomaly_detected")
      ? payload.anomaly_detected === true
      : this.hasValue(payload, "anomalyDetected")
        ? payload.anomalyDetected === true
        : state.mlMeta.anomalyDetected === true && !removed;

    const effective = { ...vitals, removed, anomaly_detected: anomaly };
    const criticalVitals = removed ? [] : this.getCriticalVitals(vitals);
    const warningVitals = removed ? [] : this.getWarningVitals(vitals);
    const emergency = !removed && this.isEmergency(vitals.emergency);

    state.vitals = vitals;
    state.lastReadingAt = payload.ts ?? now;
    state.clinicalStatus = this.deriveStatus(effective);
    state.deviceStatus = removed ? "removed" : "online";
    state.status = this.overallStatus(state);
    state.flags = {
      critical: criticalVitals.map(v => v.key),
      warning: warningVitals.map(v => v.key)
    };
    state.mlMeta = {
      cleaned: isClean ? (payload.cleaned ?? true) : false,
      anomalyDetected: anomaly,
      sourcePath: sourcePath || (isClean ? "ML" : "RAW")
    };
    if (payload.seq !== undefined && payload.seq !== null) state.seq = payload.seq;

    // Device reported again: the offline condition is over.
    const conditions = this.buildConditions(state, criticalVitals, warningVitals, emergency, anomaly);
    if (removed) {
      conditions.push({
        conditionKey: "device:removed", type: "DEVICE_REMOVED", severity: "WARNING",
        vital: "Device", source: "DEVICE_STATUS",
        text: "Wearable sensor removed - patient is not being monitored"
      });
    }

    const prev = this.activeConditions.get(deviceId);
    if (prev?.has("device:offline")) {
      this.alertEngine.clearCondition(prev.get("device:offline"), "device:offline");
      prev.delete("device:offline");
    }

    this.applyConditions(deviceId, state, conditions);
    this.notify(deviceId);
    return state;
  }

  // ------------------------------------------------------------
  // GETTERS
  // ------------------------------------------------------------

  getState(deviceId) {
    return this.beds.get(String(deviceId)) ?? null;
  }

  getStateByPatient(patientId) {
    for (const state of this.beds.values()) {
      if (String(state.patientId) === String(patientId)) return state;
    }
    return null;
  }

  getAllStates() {
    return Array.from(this.beds.values());
  }

  getUnassignedDevices() {
    return Array.from(this.unassigned.values());
  }

  getCriticalStates() {
    return this.getAllStates().filter(state => state.status === "critical");
  }

  getWarningStates() {
    return this.getAllStates().filter(state => state.status === "warning");
  }

  // ------------------------------------------------------------
  // CONNECTIVITY: OFFLINE / LINK LOST / REMOVE / CLEAR
  // ------------------------------------------------------------

  /** Called by the device monitor when telemetry has gone quiet. */
  markOffline(deviceId) {
    const state = this.getState(deviceId);
    if (!state || this.linkLost) return;
    if (state.deviceStatus === "offline" || state.deviceStatus === "no-data") return;
    if (state.deviceStatus === "removed") {
      // Removed band that also stops talking: removed takes priority
      // for display, but the device is now also silent.
      state.silentWhileRemoved = true;
    }

    state.deviceStatus = "offline";
    state.status = this.overallStatus(state);

    // Vital conditions can no longer be evaluated - clear them so
    // nothing claims the patient is still abnormal on stale data.
    const previous = this.activeConditions.get(String(deviceId));
    if (previous) {
      for (const [conditionKey, patientId] of [...previous]) {
        if (conditionKey === "device:offline") continue;
        this.alertEngine.clearCondition(patientId, conditionKey);
        previous.delete(conditionKey);
      }
    }
    this.notify(String(deviceId));
  }

  /** Raise the "device offline" alert after a sustained gap. */
  raiseOfflineAlert(deviceId) {
    const state = this.getState(deviceId);
    if (!state || this.linkLost || !state.patientId) return;
    const key = String(deviceId);
    const conditions = this.activeConditions.get(key) ?? new Map();
    if (conditions.has("device:offline")) return;
    conditions.set("device:offline", state.patientId);
    this.activeConditions.set(key, conditions);

    this.alertEngine.raise({
      conditionKey: "device:offline", type: "DEVICE_OFFLINE", severity: "WARNING",
      vital: "Device", source: "DEVICE_STATUS",
      patientId: state.patientId, mrn: state.mrn, patientName: state.patientName,
      deviceId: key, ward: state.ward, wardId: state.wardId, bed: state.bed, sim: state.sim,
      message: `Wearable ${key} stopped reporting - ${state.patientName}, ${state.ward ?? "ward ?"} bed ${state.bed ?? "?"} is not being monitored.`
    });
  }

  /**
   * Broker connection lost / restored. While the link is down
   * every device is in an UNKNOWN state; no device-offline alerts
   * are raised because the devices are not at fault.
   */
  setLinkLost(lost) {
    if (this.linkLost === lost) return;
    this.linkLost = lost;

    for (const [deviceId, state] of this.beds) {
      if (lost) {
        state.deviceStatus = "link-lost";
        // Readings can't be evaluated while blind: clear vital
        // conditions (open alerts stay open until handled).
        const previous = this.activeConditions.get(deviceId);
        if (previous) {
          for (const [conditionKey, patientId] of [...previous]) {
            this.alertEngine.clearCondition(patientId, conditionKey);
            previous.delete(conditionKey);
          }
        }
      } else {
        // Never declare a device online without fresh telemetry.
        // The monitor raises "not reporting" if nothing arrives
        // within the offline-alert window from now.
        state.deviceStatus = "no-data";
        state.awaitingSince = this.now();
      }
      state.status = this.overallStatus(state);
    }
    this.notify(null);
  }

  removeDevice(deviceId) {
    const key = String(deviceId);
    if (!this.beds.has(key)) return;
    this.clearConditions(key);
    this.beds.delete(key);
    this.notify(key);
  }

  clear() {
    this.beds.clear();
    this.unassigned.clear();
    this.activeConditions.clear();
    this.notify(null);
  }
}

function item(vital, key, value, unit, direction, threshold, message) {
  return { vital, key, value, unit, direction, threshold, message };
}

export const stateStore = new StateStore();
