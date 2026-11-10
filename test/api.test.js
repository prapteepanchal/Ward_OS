// WardOS API + access-control tests (in-memory DB, demo seed, no broker)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.WARDOS_DEMO = "1";
process.env.PATIENT_NAME_LOGIN = "1";

const { openDatabase } = await import("../server/db.js");
const { seedDemo } = await import("../server/seed.js");
const { createServer } = await import("../server/index.js");
const { config } = await import("../shared/config.js");

let server, monitoring, base;

before(async () => {
  const db = openDatabase(":memory:");
  seedDemo(db);
  ({ server, monitoring } = createServer({ db }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  monitoring.stateStore.setLinkLost(false);
});
after(() => server.close());

async function login(path, body) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-WardOS-Request": "1" }, body: JSON.stringify(body) });
  return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
const get = (path, cookie) => fetch(base + path, { headers: { cookie } });

test("bad password rejected, wrong role rejected", async () => {
  assert.equal((await login("/api/auth/login", { role: "nurse", username: "nurse.icu", password: "nope" })).status, 401);
  assert.equal((await login("/api/auth/login", { role: "doctor", username: "nurse.icu", password: "Demo-ICU-Nurse-2026" })).status, 403);
});

test("unauthenticated API access is refused", async () => {
  assert.equal((await fetch(base + "/api/patients")).status, 401);
});

test("CSRF header required for state changes", async () => {
  const res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
});

test("server source and database are never served", async () => {
  for (const p of ["/server/auth.js", "/data/wardos.db", "/package.json", "/.env", "/server/seed/demo_seed.json"]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test("nurse sees only own ward; doctor only own patients", async () => {
  const nurse = await login("/api/auth/login", { role: "nurse", username: "nurse.icu", password: "Demo-ICU-Nurse-2026" });
  const np = await (await get("/api/patients", nurse.cookie)).json();
  assert.ok(np.length === 10 && np.every(p => p.wardId === "ICU"));
  assert.equal((await get("/api/patients/11", nurse.cookie)).status, 404, "W3B patient hidden from ICU nurse");

  const doc = await login("/api/auth/login", { role: "doctor", username: "dr.iyer", password: "Demo-Doctor-Iyer-26" });
  const dp = await (await get("/api/patients", doc.cookie)).json();
  assert.deepEqual(dp.map(p => p.mrn).sort(), ["PT-1003", "PT-1007", "PT-1008", "PT-1009", "PT-1010", "PT-2002", "PT-2003"]);
});

test("patient sees only themself, cannot export or read notes", async () => {
  const p = await login("/api/auth/patient-login", { name: "jane smith" });
  assert.equal(p.status, 200);
  const list = await (await get("/api/patients", p.cookie)).json();
  assert.deepEqual(list.map(x => x.name), ["Jane Smith"]);
  assert.equal((await get("/api/patients/1", p.cookie)).status, 404);
  assert.equal((await get(`/api/reports/patient/${list[0].id}`, p.cookie)).status, 403);
  assert.equal((await get(`/api/patients/${list[0].id}/notes`, p.cookie)).status, 403);
  assert.equal((await login("/api/auth/patient-login", { name: "Jane Smith", accessCode: "WRONG1" })).status, 401);
  assert.equal((await login("/api/auth/patient-login", { name: "Jane Smith", accessCode: "JS2-P8Q" })).status, 200);
});

test("telemetry -> alert -> nurse-scoped alert list -> xlsx report", async () => {
  monitoring.ingest(config.mqtt.cleanTopic, { device_id: 4, seq: 1, hr: "80", spo2: "86", temp: "37", emergency: "OK" });
  const nurse = await login("/api/auth/login", { role: "nurse", username: "nurse.icu", password: "Demo-ICU-Nurse-2026" });
  const alerts = await (await get("/api/alerts", nurse.cookie)).json();
  const a = alerts.find(x => x.mrn === "PT-1004" && x.severity === "CRITICAL");
  assert.ok(a, "critical SpO2 alert visible to ICU nurse");

  const other = await login("/api/auth/login", { role: "nurse", username: "nurse.ward3b", password: "Demo-W3B-Nurse-2026" });
  assert.equal((await (await get("/api/alerts", other.cookie)).json()).length, 0, "W3B nurse can't see ICU alerts");

  // Nurse can acknowledge but not resolve a critical alert
  const ack = await fetch(`${base}/api/alerts/${a.id}/acknowledge`, { method: "POST", headers: { cookie: nurse.cookie, "X-WardOS-Request": "1" } });
  assert.equal(ack.status, 200);
  const res = await fetch(`${base}/api/alerts/${a.id}/resolve`, { method: "POST", headers: { cookie: nurse.cookie, "X-WardOS-Request": "1", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);

  monitoring.flushReadings();
  const report = await get("/api/reports/patient/4?hours=1", nurse.cookie);
  assert.equal(report.status, 200);
  const bytes = new Uint8Array(await report.arrayBuffer());
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);    // ZIP "PK"
});
