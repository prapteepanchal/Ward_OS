// ============================================================
// WardOS - Wearable telemetry simulator (DEVELOPMENT ONLY)
//
// Replaces the old in-browser simulation (shared/simulation.js),
// which fabricated readings inside the dashboard. This publishes
// over real MQTT using the exact hardware payload contract, plus
// "sim": true so every dashboard and report labels the data as
// SIMULATED. Real devices never send that flag.
// ============================================================

import mqtt from "mqtt";
import { config } from "../shared/config.js";

const URL = process.env.MQTT_URL || `ws://${config.mqtt.broker}:${config.mqtt.wsPort}${config.mqtt.wsPath}`;
const CYCLE = 180; // seconds per scenario loop

// Per-device scenario (device IDs match the demo seed).
const DEVICES = {
  1: { hr: 76, spo2: 98, temp: 36.7 },
  2: { hr: 84, spo2: 96, temp: 37.2 },
  3: { hr: 92, spo2: 95, temp: 37.0, scenario: "tachy" },        // HR climbs into warning
  4: { hr: 104, spo2: 94, temp: 38.2, scenario: "desat" },       // SpO2 crash + emergency (critical)
  5: { hr: 70, spo2: 96, temp: 36.6, scenario: "anomaly" },      // ML anomaly flag
  6: { hr: 72, spo2: 99, temp: 36.6, scenario: "removed" },      // band taken off
  7: { hr: 68, spo2: 97, temp: 36.9, scenario: "dropout" },      // goes silent (offline)
  8: { hr: 88, spo2: 95, temp: 37.0 },
  9: { hr: 96, spo2: 94, temp: 38.4, scenario: "fever" },        // fever spike
  10: { hr: 80, spo2: 97, temp: 36.8 },
  11: { hr: 82, spo2: 98, temp: 37.9 },
  12: { hr: 58, spo2: 97, temp: 36.5, scenario: "brady" },       // slow HR (warning)
  13: { hr: 74, spo2: 96, temp: 36.9 },
  99: { hr: 75, spo2: 97, temp: 36.8 }                           // unregistered band
};

const seq = {};
const drift = {};

function jitter(scale) {
  return (Math.random() * 2 - 1) * scale;
}

function wave(t, start, length, peak) {
  // Smooth ramp up/down inside [start, start+length]
  if (t < start || t > start + length) return 0;
  const x = (t - start) / length;
  return Math.sin(Math.PI * x) * peak;
}

function reading(id, base, t) {
  drift[id] = (drift[id] ?? 0) * 0.9 + jitter(0.6);
  let hr = base.hr + drift[id] + jitter(1.5);
  let spo2 = base.spo2 + jitter(0.6);
  let temp = base.temp + jitter(0.05);
  let emergency = "OK";
  let anomaly = false;
  let removed = false;
  let silent = false;
  const phase = (t + id * 13) % CYCLE;

  switch (base.scenario) {
    case "tachy": hr += wave(phase, 20, 70, 40); break;                       // up to ~132
    case "desat":
      spo2 -= wave(phase, 40, 60, 10);                                        // down to ~84
      hr += wave(phase, 40, 60, 38);
      if (phase > 60 && phase < 85) emergency = "EMERGENCY";
      break;
    case "anomaly": anomaly = phase > 100 && phase < 112; if (anomaly) hr += 45; break;
    case "removed": removed = phase > 120 && phase < 150; break;
    case "dropout": silent = phase > 30 && phase < 80; break;
    case "fever": temp += wave(phase, 10, 120, 1.0); break;                    // ~39.4 at peak
    case "brady": hr -= wave(phase, 60, 60, 13); break;                       // ~45
  }

  if (silent) return null;
  seq[id] = (seq[id] ?? 1000) + 1;

  if (removed) {
    return { device_id: Number(id), seq: seq[id], hr: "REMOVED", spo2: "REMOVED", temp: "N/A", emergency: "REMOVED", cleaned: true, anomaly_detected: false, sim: true };
  }

  return {
    device_id: Number(id),
    seq: seq[id],
    hr: String(Math.round(hr)),
    spo2: String(Math.max(70, Math.min(100, Math.round(spo2)))),
    temp: temp.toFixed(1),
    emergency,
    cleaned: true,
    anomaly_detected: anomaly,
    source_path: anomaly ? "ANOMALY_REPLACED" : Math.random() > 0.9 ? "STAT" : "ML",
    sim: true
  };
}

export function startSimulator({ url = URL } = {}) {
  const client = mqtt.connect(url, { clientId: `wardos-sim-${Math.random().toString(36).slice(2, 7)}`, reconnectPeriod: 3000 });
  let t = 0;
  let timer = null;

  client.on("connect", () => {
    console.log(`[Simulator] Publishing SIMULATED telemetry for ${Object.keys(DEVICES).length} bands to ${url}`);
    if (timer) return;
    timer = setInterval(() => {
      t += 1;
      for (const [id, base] of Object.entries(DEVICES)) {
        const clean = reading(Number(id), base, t);
        if (!clean) continue;
        // Raw frame from the band (noisier), then the cleaned frame
        // from the processing pipeline - as on the real system.
        const raw = { ...clean, cleaned: false, source_path: "RAW" };
        if (clean.hr !== "REMOVED") raw.hr = String(Number(clean.hr) + Math.round(jitter(4)));
        delete raw.anomaly_detected;
        client.publish(config.mqtt.rawTopic, JSON.stringify(raw));
        client.publish(config.mqtt.cleanTopic, JSON.stringify(clean));
      }
    }, 1000);
  });

  client.on("error", error => console.warn(`[Simulator] ${error.message}`));
  client.on("close", () => console.warn("[Simulator] Broker connection closed, retrying..."));

  return { stop: () => { clearInterval(timer); client.end(true); } };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tools/simulator.js")) {
  startSimulator();
}
