// ============================================================
// WardOS - Shared configuration
// File: shared/config.js
//
// Used by BOTH the backend (Node) and the browser dashboards.
// Nothing secret belongs in this file: it is served to browsers.
// Server-only values (ports, database path, session secrets)
// live in server/config.js and environment variables.
// ============================================================

export const config = {

  // ----------------------------------------------------------
  // MQTT - unchanged topics and broker defaults from the
  // original project. The backend is now the only MQTT
  // subscriber; browsers receive filtered data from the
  // backend so a patient can never subscribe to other
  // patients' vitals.
  // ----------------------------------------------------------
  mqtt: {
    broker: "localhost",
    wsPort: 9001,
    wsPath: "/mqtt",            // ws://localhost:9001/mqtt
    cleanTopic: "wardos/cleaned/vitals",
    rawTopic: "wearable/data",
    keepAlive: 30,
    reconnectDelay: 5000,
    // Clean telemetry silent longer than this => RAW MODE.
    // (Original behaviour: 10 s, checked every 2 s.)
    rawModeSilenceMs: 10000,
    rawModeCheckMs: 2000
  },

  // ----------------------------------------------------------
  // Monitoring thresholds.
  //
  // These are DEMONSTRATION monitoring thresholds, not clinical
  // decision rules. They raise monitoring alerts for staff
  // review and never constitute a diagnosis.
  //
  //  - "warning*" values come from the project brief:
  //      HR < 50 or > 120 BPM, Temp > 38.0 C, SpO2 < 92 %
  //  - "critical*" values are the original project's tiers:
  //      HR < 40 or > 140 BPM, SpO2 < 90 %, Temp > 39.0 / < 35.0 C
  //
  // min/max describe the normal reference band used for
  // chart shading only.
  // ----------------------------------------------------------
  thresholds: {
    hr: {
      min: 60,
      max: 100,
      warningLow: 50,
      warningHigh: 120,
      criticalLow: 40,
      criticalHigh: 140
    },
    spo2: {
      min: 95,
      max: 100,
      warningLow: 92,
      criticalLow: 90
    },
    temp: {
      min: 36.1,
      max: 37.5,
      warningHigh: 38.0,
      criticalLow: 35.0,
      criticalHigh: 39.0
    }
  },

  // Physiologically impossible values are rejected as invalid
  // payloads rather than shown as readings.
  validRanges: {
    hr: [0, 300],
    spo2: [0, 100],
    temp: [25, 45]
  },

  // ----------------------------------------------------------
  // Device timing
  // ----------------------------------------------------------
  devices: {
    // No telemetry for this long => device OFFLINE
    // (original dashboard value: 6 s).
    offlineAfterMs: 6000,
    // Raise a "device offline" alert only after a longer gap,
    // so a brief Wi-Fi hiccup doesn't page staff.
    offlineAlertAfterMs: 30000,
    // Raw-topic readings only replace cleaned readings when
    // cleaned data for that device is older than this.
    cleanPriorityMs: 10000
  },

  // ----------------------------------------------------------
  // Alert lifecycle timing.
  //
  // The original engine's TTLs (CRITICAL 30 s, ANOMALY 10 s,
  // other 15 s) are kept, but repurposed as the "clear grace"
  // period: a condition must stay clear for this long before
  // an alert closes automatically. This prevents flapping
  // values from creating a new alert on every sample, and it
  // no longer silently expires an unacknowledged critical
  // alert while the patient is still abnormal.
  // ----------------------------------------------------------
  alerts: {
    clearGraceMs: {
      CRITICAL: 30000,
      ANOMALY: 10000,
      DEFAULT: 15000
    },
    // Repeat the critical chime while unacknowledged critical
    // alerts exist (browser only). 0 disables reminders.
    criticalReminderMs: 60000
  }
};

export default config;
