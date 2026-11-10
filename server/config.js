// ============================================================
// WardOS - Server configuration (server-only, never served)
// Values come from environment variables or a local .env file.
// See .env.example.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as shared } from "../shared/config.js";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT_DIR, ".env");
if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile);
}

const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const production = env.NODE_ENV === "production";
const demo = bool(env.WARDOS_DEMO, false);

export const serverConfig = {
  production,
  demo,
  host: env.HOST || "127.0.0.1",
  port: int(env.PORT, 8080),
  dbPath: path.resolve(ROOT_DIR, env.DB_PATH || "data/wardos.db"),

  mqtt: {
    url: env.MQTT_URL || `ws://${shared.mqtt.broker}:${shared.mqtt.wsPort}${shared.mqtt.wsPath}`,
    username: env.MQTT_USERNAME || undefined,
    password: env.MQTT_PASSWORD || undefined
  },

  auth: {
    staffSessionHours: int(env.STAFF_SESSION_HOURS, 12),
    patientSessionHours: int(env.PATIENT_SESSION_HOURS, 24),
    // Name-only patient sign-in is a DEMONSTRATION convenience.
    // It is refused in production regardless of this flag.
    patientNameOnlyLogin: !production && bool(env.PATIENT_NAME_LOGIN, demo),
    secureCookies: bool(env.SECURE_COOKIES, production)
  },

  readingRetentionDays: int(env.READING_RETENTION_DAYS, 30)
};
