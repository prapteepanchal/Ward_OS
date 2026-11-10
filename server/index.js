// ============================================================
// WardOS - Local server entry point
//
//   npm start          (uses .env / environment variables)
//   npm run demo       (local broker + simulator + server)
// ============================================================

import http from "node:http";
import mqtt from "mqtt";
import { serverConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { isEmpty, seedDemo } from "./seed.js";
import { loadSession, purgeExpiredSessions, SESSION_COOKIE } from "./auth.js";
import { Router, HttpError, parseCookies, sendJson, serveStatic } from "./http.js";
import { registerRoutes } from "./routes.js";
import { MonitoringService } from "./pipeline.js";
import { LiveHub } from "./realtime.js";
import { MqttClientManager } from "../shared/mqtt_client.js";

export function createServer({ db, mqttManager = null } = {}) {
  const monitoring = new MonitoringService({ db, mqtt: mqttManager, retentionDays: serverConfig.readingRetentionDays });
  monitoring.start();
  const hub = new LiveHub({ db, monitoring });
  const router = new Router();
  registerRoutes(router, { db, monitoring, hub });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    try {
      if (!pathname.startsWith("/api/")) {
        if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, pathname)) return;
        throw new HttpError(404, "NOT_FOUND", "Not found");
      }

      const match = router.match(req.method, pathname);
      if (!match) throw new HttpError(404, "NOT_FOUND", "Unknown API endpoint");
      if (match.methodMismatch) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");

      // CSRF: state-changing calls must come from WardOS pages
      // (custom header + SameSite=Strict session cookie).
      if (req.method !== "GET") {
        if (req.headers["x-wardos-request"] !== "1") throw new HttpError(403, "CSRF", "Request rejected");
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "CSRF", "Cross-origin request rejected");
      }

      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const principal = loadSession(db, token);

      const result = await match.route.handler({ req, res, url, query: url.searchParams, params: match.params, principal, token });
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message, ...error.extra });
      } else {
        console.error("[WardOS] Unhandled error:", error);
        sendJson(res, 500, { error: "SERVER_ERROR", message: "Unexpected server error" });
      }
    }
  });

  const sessionTimer = setInterval(() => purgeExpiredSessions(db), 3600000);
  sessionTimer.unref();

  server.on("close", () => {
    clearInterval(sessionTimer);
    hub.stop();
    monitoring.stop();
  });

  return { server, monitoring, hub };
}

// ------------------------------------------------------------
// CLI start
// ------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

if (isMain) {
  const db = openDatabase(serverConfig.dbPath);

  if (isEmpty(db)) {
    if (serverConfig.demo) {
      seedDemo(db);
    } else {
      console.warn("[WardOS] Database has no users. Start with WARDOS_DEMO=1 (npm run demo) to load demonstration data.");
    }
  }

  const mqttManager = new MqttClientManager({
    mqttLib: mqtt,
    url: serverConfig.mqtt.url,
    clientOptions: { username: serverConfig.mqtt.username, password: serverConfig.mqtt.password }
  });

  const { server } = createServer({ db, mqttManager });
  mqttManager.connect();

  server.listen(serverConfig.port, serverConfig.host, () => {
    console.log(`[WardOS] Server ready on http://${serverConfig.host === "0.0.0.0" ? "localhost" : serverConfig.host}:${serverConfig.port}`);
    console.log(`[WardOS] MQTT broker: ${serverConfig.mqtt.url}`);
    if (serverConfig.auth.patientNameOnlyLogin) console.log("[WardOS] DEMO: name-only patient sign-in is enabled.");
  });

  const shutdown = () => {
    console.log("[WardOS] Shutting down...");
    mqttManager.disconnect();
    mqttManager.stopTimers();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
