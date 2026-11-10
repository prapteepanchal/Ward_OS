// WardOS core tests:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePayload } from "../shared/payload.js";
import { AlertEngine } from "../shared/alert_engine.js";
import { StateStore } from "../shared/state_store.js";
import { DeviceRegistry } from "../shared/device_registry.js";
import { config } from "../shared/config.js";

// ---------------------------------------------------------------- payloads

test("valid payload is normalised", () => {
  const r = validatePayload({ device_id: 1, seq: 5, hr: "78", spo2: "97", temp: "36.8", emergency: "OK", cleaned: true, anomaly_detected: false, source_path: "ML" });
  assert.equal(r.ok, true);
  assert.equal(r.payload.device_id, "1");
  assert.equal(r.payload.hr, 78);
  assert.equal(r.payload.temp, 36.8);
});

test("invalid payloads are rejected", () => {
  assert.equal(validatePayload(null).ok, false);
  assert.equal(validatePayload({ hr: 70 }).ok, false);                       // no device
  assert.equal(validatePayload({ device_id: "bad id!", hr: 70 }).ok, false);  // bad id
  assert.equal(validatePayload({ device_id: 1 }).ok, false);                  // no vitals
  const r = validatePayload({ device_id: 1, hr: "900", spo2: 97 });           // impossible HR dropped
  assert.equal(r.ok, true);
  assert.equal(r.payload.hr, undefined);
});

test("sensor-removed payload is recognised", () => {
  const r = validatePayload({ device_id: 1, hr: "REMOVED", spo2: "REMOVED", temp: "N/A", emergency: "REMOVED" });
  assert.equal(r.payload.hr, "REMOVED");
  assert.equal(r.payload.temp, null);
});

// ---------------------------------------------------------------- state + alerts

function setup() {
  let now = 1_000_000;
  const clock = () => now;
  const engine = new AlertEngine({ now: clock });
  const store = new StateStore({ alertEngine: engine, now: clock });
  DeviceRegistry.load([{ deviceId: "1", patientId: 10, mrn: "PT-1", patientName: "Test Patient", ward: "ICU", wardId: "ICU", bed: "01" }]);
  store.syncWithRegistry();
  const send = p => store.updateState({ ...validatePayload({ device_id: 1, ...p }, { now }).payload, topic: config.mqtt.cleanTopic });
  return { engine, store, send, advance: ms => { now += ms; } };
}

test("status priority: removed > critical > warning > ok", () => {
  const { store, send } = setup();
  assert.equal(send({ hr: 75, spo2: 98, temp: 36.8 }).status, "ok");
  assert.equal(send({ hr: 125, spo2: 98, temp: 36.8 }).status, "warning");
  assert.equal(send({ hr: 75, spo2: 88, temp: 36.8 }).status, "critical");
  assert.equal(send({ hr: 75, spo2: 98, temp: 36.8, emergency: "EMERGENCY" }).status, "critical");
  const removed = send({ hr: "REMOVED", spo2: "REMOVED", temp: "N/A", emergency: "REMOVED" });
  assert.equal(removed.status, "removed");
  assert.equal(removed.vitals.hr, null, "no stale value shown after removal");
  assert.equal(store.getState(1).deviceStatus, "removed");
});

test("missing values are never zero", () => {
  const { send } = setup();
  const s = send({ hr: 80 });
  assert.equal(s.vitals.spo2, null);
});

test("one alert per condition (dedup)", () => {
  const { engine, send } = setup();
  for (let i = 0; i < 20; i++) send({ hr: 75, spo2: 87, temp: 36.8 });
  const open = engine.getOpenAlerts().filter(a => a.conditionKey === "critical:spo2:LOW");
  assert.equal(open.length, 1);
});

test("critical alert never expires unacknowledged; warning does", async () => {
  const { engine, send, advance } = setup();
  send({ hr: 125, spo2: 87, temp: 36.8 });                 // critical SpO2 + warning HR
  send({ hr: 75, spo2: 98, temp: 36.8 });                  // both clear
  advance(60000);
  for (const a of engine.alerts) engine.autoClose(a.id);
  const crit = engine.alerts.find(a => a.severity === "CRITICAL");
  const warn = engine.alerts.find(a => a.severity === "WARNING");
  assert.equal(crit.status, "NEW", "critical waits for a human");
  assert.equal(warn.status, "EXPIRED");
});

test("resolve refused while condition active; allowed after it clears", () => {
  const { engine, send } = setup();
  send({ hr: 75, spo2: 87, temp: 36.8 });
  const id = engine.getOpenAlerts()[0].id;
  assert.equal(engine.acknowledge(id, { id: 1, name: "Nurse" }).ok, true);
  assert.equal(engine.getAlert(id).status, "ACKNOWLEDGED", "ack does not erase");
  assert.equal(engine.resolve(id, { id: 2, name: "Doctor" }).error, "CONDITION_ACTIVE");
  send({ hr: 75, spo2: 97, temp: 36.8 });
  assert.equal(engine.resolve(id, { id: 2, name: "Doctor" }, "Probe refitted").ok, true);
  assert.equal(engine.getAlert(id).status, "RESOLVED");
});

test("anomaly with critical adds verify-physically caveat", () => {
  const { engine, send } = setup();
  send({ hr: 150, spo2: 97, temp: 36.8, anomaly_detected: true });
  const crit = engine.getOpenAlerts().find(a => a.severity === "CRITICAL");
  assert.match(crit.note, /verify/i);
});

test("broker link loss is not device offline", () => {
  const { store, engine, send } = setup();
  send({ hr: 75, spo2: 98, temp: 36.8 });
  store.setLinkLost(true);
  assert.equal(store.getState(1).deviceStatus, "link-lost");
  store.raiseOfflineAlert("1");
  assert.equal(engine.getOpenAlerts().length, 0, "no device-offline alert while blind");
});

test("unassigned device readings never reach a patient", () => {
  const { store, engine } = setup();
  const r = store.updateState({ ...validatePayload({ device_id: 99, hr: 150, spo2: 80 }).payload, topic: config.mqtt.cleanTopic });
  assert.equal(r, null);
  assert.equal(store.getUnassignedDevices()[0].deviceId, "99");
  assert.equal(engine.getOpenAlerts().length, 0);
});
