// ============================================================
// WardOS - Demo data seeding
// Only runs when WARDOS_DEMO=1, outside production, and only
// into an empty database.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, serverConfig } from "./config.js";
import { transaction } from "./db.js";
import { hashSecret, normalizeName } from "./auth.js";

export function isEmpty(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0;
}

export function seedDemo(db, file = path.join(ROOT_DIR, "server/seed/demo_seed.json")) {
  if (serverConfig.production) throw new Error("Refusing to load demo seed in production.");

  const seed = JSON.parse(fs.readFileSync(file, "utf8"));
  const now = Date.now();

  transaction(db, () => {
    const userIds = {};
    const bedIds = {};

    for (const ward of seed.wards) {
      db.prepare("INSERT INTO wards (id, name, floor) VALUES (?, ?, ?)").run(ward.id, ward.name, ward.floor ?? null);
      for (const label of ward.beds) {
        const result = db.prepare("INSERT INTO beds (ward_id, label) VALUES (?, ?)").run(ward.id, label);
        bedIds[`${ward.id}:${label}`] = Number(result.lastInsertRowid);
      }
    }

    for (const user of seed.users) {
      const result = db.prepare(`
        INSERT INTO users (username, display_name, role, title, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(user.username, user.displayName, user.role, user.title ?? null, hashSecret(user.password), now);
      userIds[user.username] = Number(result.lastInsertRowid);
      for (const wardId of user.wards ?? []) {
        db.prepare("INSERT INTO user_wards (user_id, ward_id) VALUES (?, ?)").run(userIds[user.username], wardId);
      }
    }

    for (const p of seed.patients) {
      // Spread admissions over the last few days for a realistic list.
      const admittedAt = now - (1 + (p.mrn.charCodeAt(p.mrn.length - 1) % 5)) * 86400000;
      const result = db.prepare(`
        INSERT INTO patients (mrn, full_name, name_key, age, sex, diagnosis, ward_id, bed_id, admitted_at, access_code_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(p.mrn, p.name, normalizeName(p.name), p.age, p.sex, p.diagnosis ?? null, p.ward,
        bedIds[`${p.ward}:${p.bed}`], admittedAt, hashSecret(p.accessCode.replace(/[^A-Z0-9]/gi, "").toUpperCase()));
      const patientId = Number(result.lastInsertRowid);

      p.doctors.forEach((username, index) => {
        db.prepare("INSERT INTO care_team (patient_id, user_id, relation) VALUES (?, ?, ?)")
          .run(patientId, userIds[username], index === 0 ? "attending" : "consulting");
      });

      if (p.device) {
        db.prepare("INSERT INTO devices (id, label, model, registered_at) VALUES (?, ?, ?, ?)")
          .run(p.device, `Band ${p.device.padStart(2, "0")}`, "ESP32 wearable", admittedAt);
        db.prepare("INSERT INTO device_assignments (device_id, patient_id, assigned_at) VALUES (?, ?, ?)")
          .run(p.device, patientId, admittedAt);
      }
    }

    for (const device of seed.spareDevices ?? []) {
      db.prepare("INSERT INTO devices (id, label, model, registered_at) VALUES (?, ?, ?, ?)")
        .run(device.id, device.label, "ESP32 wearable", now);
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo', '1')").run();
  });

  console.log(`[WardOS] Demo data loaded: ${seed.users.length} staff, ${seed.patients.length} patients. Credentials: server/seed/demo_seed.json`);
}
