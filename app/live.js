// ============================================================
// WardOS - Live data client (browser)
//
// One EventSource to /api/stream. Keeps a client-side store of
// the patients/alerts this user is allowed to see, tracks four
// separate connectivity states, and mirrors the last snapshot
// into IndexedDB so the dashboard stays readable (clearly
// marked NOT LIVE) when the local server is unreachable.
// ============================================================

import { api } from "./api.js";

const DB_NAME = "wardos-cache";
const STORE = "snapshots";

// ------------------------------------------------------------
// IndexedDB (per-user cache, wiped on logout)
// ------------------------------------------------------------

function idb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cachePut(key, value) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* cache is best-effort */ }
}

export async function cacheGet(key) {
  try {
    const db = await idb();
    const value = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value ?? null;
  } catch {
    return null;
  }
}

export async function cacheClear() {
  try {
    const db = await idb();
    await new Promise(resolve => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    db.close();
  } catch { /* ignore */ }
}

// ------------------------------------------------------------
// Live store
// ------------------------------------------------------------

export class LiveStore {
  constructor(me) {
    this.me = me;
    this.cacheKey = `${me.role}:${me.userId ?? me.patientId}`;
    this.patients = new Map();
    this.alerts = new Map();          // open alerts
    this.system = null;
    this.listeners = new Set();
    this.history = new Map();         // patientId -> [{ts,hr,spo2,temp}] (live tail, 10 min)
    this.source = null;
    this.serverOnline = false;
    this.lastEventAt = 0;
    this.cachedAt = null;
    this.fromCache = false;
    this.ready = false;
    this.watchdog = null;
    this.saveTimer = null;
    this.networkOnline = navigator.onLine;

    this.onOnline = () => { this.networkOnline = true; this.emit("connection"); this.connect(); };
    this.onOffline = () => { this.networkOnline = false; this.emit("connection"); };
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
  }

  on(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emit(type, payload) {
    for (const cb of this.listeners) {
      try { cb(type, payload); } catch (error) { console.error("[WardOS] UI listener error", error); }
    }
  }

  async start() {
    // Show cached data instantly; the live snapshot replaces it.
    const cached = await cacheGet(this.cacheKey);
    if (cached && !this.ready) {
      this.applySnapshot(cached.snapshot, true);
      this.cachedAt = cached.savedAt;
    }
    this.connect();
    this.watchdog = setInterval(() => this.checkStale(), 5000);
  }

  stop() {
    clearInterval(this.watchdog);
    clearTimeout(this.saveTimer);
    this.source?.close();
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
  }

  connect() {
    if (this.source && this.source.readyState !== EventSource.CLOSED) return;
    const source = new EventSource("/api/stream");
    this.source = source;

    source.addEventListener("snapshot", e => {
      this.markAlive();
      this.applySnapshot(JSON.parse(e.data), false);
    });
    source.addEventListener("patients", e => {
      this.markAlive();
      for (const p of JSON.parse(e.data)) this.upsertPatient(p);
      this.emit("patients");
      this.scheduleSave();
    });
    source.addEventListener("alert", e => {
      this.markAlive();
      const { event, alert } = JSON.parse(e.data);
      if (alert.open) this.alerts.set(alert.id, alert);
      else this.alerts.delete(alert.id);
      this.emit("alert", { event, alert });
      this.scheduleSave();
    });
    source.addEventListener("system", e => {
      this.markAlive();
      this.system = JSON.parse(e.data);
      this.emit("system");
    });
    source.addEventListener("session-ended", () => {
      source.close();
      window.location.replace("/index.html?ended=1");
    });
    source.onerror = async () => {
      if (this.serverOnline) {
        this.serverOnline = false;
        this.emit("connection");
      }
      // EventSource can't see HTTP status: check whether the
      // session expired (redirect) or the server is just down.
      if (source.readyState === EventSource.CLOSED) {
        try { await api("/api/auth/me"); setTimeout(() => this.connect(), 3000); } catch { setTimeout(() => this.connect(), 5000); }
      }
    };
  }

  markAlive() {
    this.lastEventAt = Date.now();
    if (!this.serverOnline) {
      this.serverOnline = true;
      this.fromCache = false;
      this.emit("connection");
    }
  }

  checkStale() {
    // System heartbeat arrives every 15 s; 40 s of silence = dead link.
    if (this.serverOnline && Date.now() - this.lastEventAt > 40000) {
      this.serverOnline = false;
      this.emit("connection");
      this.source?.close();
      this.connect();
    }
  }

  applySnapshot(snapshot, fromCache) {
    this.patients.clear();
    for (const p of snapshot.patients ?? []) this.upsertPatient(p, true);
    this.alerts.clear();
    for (const a of snapshot.alerts ?? []) this.alerts.set(a.id, a);
    this.system = snapshot.system ?? null;
    this.fromCache = fromCache;
    if (!fromCache) {
      const first = !this.ready;
      this.ready = true;
      this.cachedAt = null;
      this.scheduleSave(0);
      if (first) this.backfillHistory();
    }
    this.emit("snapshot");
  }

  /** Seed the 10-minute sparkline tails from stored readings. */
  async backfillHistory() {
    const ids = [...this.patients.keys()];
    await Promise.all(ids.map(async id => {
      try {
        const data = await api(`/api/patients/${id}/vitals?hours=0.17&maxPoints=150`);
        const stored = data.points.filter(p => p.kind === "clean" && !p.removed).map(p => ({ ts: p.ts, hr: p.hr, spo2: p.spo2, temp: p.temp }));
        const live = this.history.get(id) ?? [];
        const firstLive = live[0]?.ts ?? Infinity;
        this.history.set(id, [...stored.filter(p => p.ts < firstLive), ...live]);
      } catch { /* offline: tails fill as data arrives */ }
    }));
    this.emit("patients");
  }

  upsertPatient(p, silent = false) {
    const prev = this.patients.get(p.id);
    this.patients.set(p.id, p);

    // Live tail for sparklines (only real, current readings).
    if (p.deviceStatus === "online" && p.lastReadingAt && (!prev || prev.lastReadingAt !== p.lastReadingAt)) {
      const tail = this.history.get(p.id) ?? [];
      tail.push({ ts: p.lastReadingAt, hr: p.vitals.hr, spo2: p.vitals.spo2, temp: p.vitals.temp });
      while (tail.length && tail[0].ts < Date.now() - 10 * 60000) tail.shift();
      this.history.set(p.id, tail);
    }
    if (!silent) this.emit("patient", p);
  }

  scheduleSave(delay = 10000) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      cachePut(this.cacheKey, {
        savedAt: Date.now(),
        snapshot: { patients: [...this.patients.values()], alerts: [...this.alerts.values()], system: this.system }
      });
    }, delay);
  }

  // ------------------------------------------------------------
  // Derived state
  // ------------------------------------------------------------

  get patientList() {
    return [...this.patients.values()];
  }

  get openAlerts() {
    return [...this.alerts.values()].sort((a, b) =>
      (a.status === "NEW" ? 0 : 1) - (b.status === "NEW" ? 0 : 1) ||
      (a.severity === "CRITICAL" ? 0 : 1) - (b.severity === "CRITICAL" ? 0 : 1) ||
      b.createdAt - a.createdAt);
  }

  get unacknowledged() {
    return this.openAlerts.filter(a => a.status === "NEW");
  }

  /** The four connectivity layers, kept distinct. */
  get connectivity() {
    const broker = this.system?.broker?.status ?? "UNKNOWN";
    return {
      network: this.networkOnline,
      server: this.serverOnline,
      broker: this.serverOnline ? broker : "UNKNOWN",
      rawMode: this.serverOnline && !!this.system?.broker?.rawMode,
      simulation: !!this.system?.simulation,
      cachedAt: this.fromCache ? this.cachedAt : null
    };
  }

  /** Cache detailed history for offline reports (best-effort). */
  async cacheHistory(patientId, points, alerts) {
    await cachePut(`${this.cacheKey}:history:${patientId}`, { savedAt: Date.now(), points, alerts });
  }

  async cachedHistory(patientId) {
    return cacheGet(`${this.cacheKey}:history:${patientId}`);
  }
}
