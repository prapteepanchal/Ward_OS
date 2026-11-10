// ============================================================
// WardOS - Live stream (Server-Sent Events)
//
// Each browser holds ONE EventSource to /api/stream. Every
// event is filtered against that session's visible patients,
// so a patient only ever receives their own data.
//
// Events:
//   snapshot  full state for this user (on connect / on change)
//   patient   one patient's live state (coalesced, max 2/s)
//   alert     alert created / updated / acknowledged / closed
//   system    broker + server status
// ============================================================

import { visiblePatientIds } from "./access.js";
import { patientView, alertView } from "./directory.js";

const HEARTBEAT_MS = 15000;
const FLUSH_MS = 500;

export class LiveHub {
  constructor({ db, monitoring }) {
    this.db = db;
    this.monitoring = monitoring;
    this.clients = new Set();
    this.pendingPatients = new Set();
    this.pendingAll = false;
    this.lastSystem = "";

    monitoring.on((type, ...args) => this.onEvent(type, ...args));

    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.flushTimer.unref?.();
    this.heartbeatTimer.unref?.();
  }

  stop() {
    clearInterval(this.flushTimer);
    clearInterval(this.heartbeatTimer);
    for (const client of this.clients) client.res.end();
    this.clients.clear();
  }

  // ------------------------------------------------------------

  attach(req, res, principal) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");

    const client = { res, principal, visible: visiblePatientIds(this.db, principal) };
    this.clients.add(client);
    this.sendSnapshot(client);

    req.on("close", () => this.clients.delete(client));
  }

  send(client, event, data) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  buildSnapshot(principal, visible) {
    const patients = [];
    for (const id of visible) {
      const entry = this.monitoring.directory.get(id);
      if (!entry) continue;
      patients.push(patientView(entry, this.monitoring.getState(id), { role: principal.role }));
    }
    const alerts = this.monitoring.alertEngine.getOpenAlerts()
      .filter(a => visible.has(Number(a.patientId)))
      .map(a => alertView(a, principal.role));

    return {
      serverTime: Date.now(),
      system: principal.role === "patient" ? this.patientSystem() : this.monitoring.systemStatus(),
      patients,
      alerts
    };
  }

  sendSnapshot(client) {
    this.send(client, "snapshot", this.buildSnapshot(client.principal, client.visible));
  }

  /** Patients see only whether their monitoring is live. */
  patientSystem() {
    const s = this.monitoring.systemStatus();
    return { now: s.now, broker: { status: s.broker.status }, simulation: s.simulation };
  }

  // ------------------------------------------------------------

  onEvent(type, ...args) {
    if (type === "patient") {
      this.pendingPatients.add(Number(args[0]));
    } else if (type === "patients") {
      this.pendingAll = true;
    } else if (type === "alert") {
      const [alert, event] = args;
      for (const client of this.clients) {
        if (!client.visible.has(Number(alert.patientId))) continue;
        this.send(client, "alert", { event, alert: alertView(alert, client.principal.role) });
      }
    } else if (type === "system") {
      this.broadcastSystem();
    } else if (type === "directory") {
      this.refreshVisibility();
    }
  }

  broadcastSystem() {
    const status = this.monitoring.systemStatus();
    for (const client of this.clients) {
      this.send(client, "system", client.principal.role === "patient" ? this.patientSystem() : status);
    }
  }

  /** Admissions, discharges, device moves: rebuild scopes. */
  refreshVisibility() {
    for (const client of this.clients) {
      client.visible = visiblePatientIds(this.db, client.principal);
      this.sendSnapshot(client);
    }
  }

  /** A session ended (logout / discharge): drop its streams. */
  closeWhere(predicate) {
    for (const client of [...this.clients]) {
      if (predicate(client.principal)) {
        this.send(client, "session-ended", {});
        client.res.end();
        this.clients.delete(client);
      }
    }
  }

  flush() {
    if (!this.clients.size) {
      this.pendingPatients.clear();
      this.pendingAll = false;
      return;
    }

    const ids = this.pendingAll
      ? [...this.monitoring.directory.keys()]
      : [...this.pendingPatients];
    this.pendingPatients.clear();
    this.pendingAll = false;
    if (!ids.length) return;

    for (const client of this.clients) {
      const updates = [];
      for (const id of ids) {
        if (!client.visible.has(id)) continue;
        const entry = this.monitoring.directory.get(id);
        if (!entry) continue;
        updates.push(patientView(entry, this.monitoring.getState(id), { role: client.principal.role }));
      }
      if (updates.length) this.send(client, "patients", updates);
    }
  }

  heartbeat() {
    // System status doubles as the heartbeat (keeps proxies open
    // and lets the browser detect a silent dead connection).
    this.broadcastSystem();
  }
}
