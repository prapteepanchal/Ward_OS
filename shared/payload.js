// ============================================================
// WardOS - Telemetry payload validation
// File: shared/payload.js
//
// Validates and normalises MQTT payloads BEFORE they reach the
// state store. Payload contract (unchanged from the hardware /
// cleaning pipeline):
//
//   {"device_id":1,"seq":1042,"hr":"78","spo2":"97","temp":"36.8",
//    "emergency":"OK","cleaned":true,"anomaly_detected":false,
//    "source_path":"ML"}
//
//   Sensor removed:
//   {"device_id":1,"seq":1043,"hr":"REMOVED","spo2":"REMOVED",
//    "temp":"N/A","emergency":"REMOVED","cleaned":true,
//    "anomaly_detected":false}
//
// Both `anomaly_detected` and `anomalyDetected` are accepted.
// Optional extras: `ts` (epoch ms or ISO), `sim` (true when the
// sample came from the WardOS simulator, never from hardware).
// ============================================================

import { config } from "./config.js";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MISSING_TOKENS = new Set(["REMOVED", "N/A", "NA", "--", ""]);

export function isRemovedToken(value) {
  return typeof value === "string" && value.trim().toUpperCase() === "REMOVED";
}

/**
 * Parse a vital value. Returns:
 *   { value: number|null, removed: boolean, invalid: boolean }
 */
export function parseVitalValue(value, key) {
  if (value === null || value === undefined) {
    return { value: null, removed: false, invalid: false };
  }

  if (typeof value === "string") {
    const token = value.trim().toUpperCase();
    if (token === "REMOVED") return { value: null, removed: true, invalid: false };
    if (MISSING_TOKENS.has(token)) return { value: null, removed: false, invalid: false };
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return { value: null, removed: false, invalid: true };
  }

  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    return { value: null, removed: false, invalid: true };
  }

  const range = config.validRanges?.[key];

  if (range && (parsed < range[0] || parsed > range[1])) {
    return { value: null, removed: false, invalid: true };
  }

  return { value: parsed, removed: false, invalid: false };
}

function parseTimestamp(ts, now) {
  if (ts === undefined || ts === null || ts === "") return now;

  let ms = typeof ts === "number" ? ts : Date.parse(ts);

  // Accept epoch seconds from microcontrollers.
  if (Number.isFinite(ms) && ms < 1e12) ms *= 1000;

  // Reject device clocks that are wildly off (unsynced RTC):
  // fall back to the receive time instead.
  if (!Number.isFinite(ms) || Math.abs(ms - now) > 24 * 3600 * 1000) {
    return now;
  }

  return ms;
}

/**
 * Validate an incoming telemetry payload.
 * @returns {{ ok: boolean, errors: string[], payload?: object }}
 */
export function validatePayload(input, { now = Date.now() } = {}) {
  const errors = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["Payload is not a JSON object"] };
  }

  const rawId = input.device_id ?? input.deviceId;

  if (rawId === undefined || rawId === null || String(rawId).trim() === "") {
    return { ok: false, errors: ["Missing device_id"] };
  }

  const deviceId = String(rawId).trim();

  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return { ok: false, errors: [`Invalid device_id "${deviceId.slice(0, 40)}"`] };
  }

  let seq = null;

  if (input.seq !== undefined && input.seq !== null && input.seq !== "") {
    const parsedSeq = Number(input.seq);
    if (Number.isInteger(parsedSeq) && parsedSeq >= 0) {
      seq = parsedSeq;
    } else {
      errors.push("Invalid seq (ignored)");
    }
  }

  const vitals = {};
  let removed = false;
  let anyVital = false;

  for (const key of ["hr", "spo2", "temp"]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;

    const parsed = parseVitalValue(input[key], key);

    if (parsed.invalid) {
      errors.push(`Invalid ${key} value "${String(input[key]).slice(0, 20)}" (discarded)`);
      continue;
    }

    if (parsed.removed) removed = true;
    if (parsed.value !== null) anyVital = true;

    // Keep the original token for REMOVED so StateStore's
    // existing removed-detection keeps working.
    vitals[key] = parsed.removed ? "REMOVED" : parsed.value;
  }

  const emergencyRaw = input.emergency;
  let emergency;

  if (emergencyRaw !== undefined && emergencyRaw !== null) {
    emergency = String(emergencyRaw).trim().toUpperCase();
    if (!["OK", "EMERGENCY", "REMOVED"].includes(emergency)) {
      errors.push(`Unknown emergency value "${emergency.slice(0, 20)}" (treated as OK)`);
      emergency = "OK";
    }
    if (emergency === "REMOVED") removed = true;
  }

  const hasAnomalyFlag =
    Object.prototype.hasOwnProperty.call(input, "anomaly_detected") ||
    Object.prototype.hasOwnProperty.call(input, "anomalyDetected");

  const anomaly =
    input.anomaly_detected === true ||
    input.anomalyDetected === true ||
    input.anomaly_detected === "true" ||
    input.anomalyDetected === "true";

  if (!anyVital && !removed && emergency === undefined) {
    return { ok: false, errors: [...errors, "Payload carries no usable vitals"] };
  }

  const payload = {
    device_id: deviceId,
    seq,
    ...vitals,
    ts: parseTimestamp(input.ts ?? input.timestamp, now),
    cleaned: input.cleaned === true || input.cleaned === "true",
    source_path: input.source_path !== undefined && input.source_path !== null
      ? String(input.source_path).trim().toUpperCase().slice(0, 32)
      : undefined,
    sim: input.sim === true
  };

  if (emergency !== undefined) payload.emergency = emergency;
  if (hasAnomalyFlag) payload.anomaly_detected = anomaly;
  if (removed && payload.hr === undefined) payload.hr = "REMOVED";

  return { ok: true, errors, payload };
}
