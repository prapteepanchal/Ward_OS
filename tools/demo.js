// ============================================================
// WardOS - One-command demo:
//   local MQTT broker + telemetry simulator + WardOS server
//   (demo data, name-only patient sign-in enabled)
// ============================================================

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBroker } from "./broker.js";
import { startSimulator } from "./simulator.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let broker = null;
try {
  broker = await startBroker({ quiet: true });
} catch (error) {
  console.warn(`[Demo] Could not start the built-in broker (${error.message}). Assuming a broker (e.g. Mosquitto) is already running on 1883/9001.`);
}

const server = spawn(process.execPath, [path.join(root, "server/index.js")], {
  cwd: root,
  stdio: "inherit",
  env: { WARDOS_DEMO: "1", PATIENT_NAME_LOGIN: "1", ...process.env }
});

const simulator = startSimulator();

const stop = async () => {
  simulator.stop();
  server.kill();
  if (broker) await broker.close();
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", code => {
  console.log(`[Demo] Server exited (${code}).`);
  stop();
});
