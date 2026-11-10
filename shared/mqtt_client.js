// ============================================================
// WardOS - MQTT Client Manager
// File: shared/mqtt_client.js
//
// The ONLY module that talks to the MQTT broker. It now runs in
// the backend (server/index.js) so that browsers never hold a
// broker connection that could read every patient's vitals.
//
// Preserved behaviour from the original implementation:
//  - Connect over WebSocket: ws://localhost:9001/mqtt (config)
//  - Subscribe to cleaned + raw topics on connect
//  - Queue messages in the socket callback; drain every 50 ms
//    (max 50 messages per tick) outside the callback
//  - Manual reconnect with exponential backoff (cap 30 s)
//  - RAW MODE when clean telemetry is silent > 10 s
//    (checked every 2 s)
//  - Status values: OFFLINE | CONNECTING | CONNECTED | RAW MODE
//  - "mqtt-status" events
//
// Added:
//  - Works in Node and the browser (library + URL injected)
//  - Stale-socket guard: late events from an old client can't
//    overwrite the state of a newer connection
//  - Message statistics (received, invalid, per-topic last seen)
//  - Timers can be stopped (no leaks in tests / shutdown)
// ============================================================

import { config } from "./config.js";

export class MqttClientManager {

  constructor({
    mqttLib = (typeof window !== "undefined" ? window.mqtt : null),
    url = `ws://${config.mqtt.broker}:${config.mqtt.wsPort}${config.mqtt.wsPath ?? "/mqtt"}`,
    clientOptions = {},
    processor = null,
    autoStartTimers = true
  } = {}) {
    this.mqttLib = mqttLib;
    this.url = url;
    this.clientOptions = clientOptions;
    this.processor = processor;

    // Connection
    this.client = null;
    this.status = "OFFLINE";
    this.connecting = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.stopped = false;
    this.lastError = null;
    this.connectedSince = null;

    // Message processing
    this.messageQueue = [];
    this.maxMessagesPerTick = 50;
    this.maxQueueLength = 5000;

    // Telemetry monitoring
    this.lastCleanMessageTime = Date.now();
    this.isRawMode = false;
    this.stats = { received: 0, invalid: 0, dropped: 0, lastMessageAt: null, topics: {} };

    this.events = new EventTarget();
    this.queueTimer = null;
    this.rawModeTimer = null;

    if (autoStartTimers) this.startTimers();
  }

  startTimers() {
    if (this.queueTimer) return;

    // Never process inside the WebSocket callback: heavy work
    // there stalls MQTT ping/pong and causes disconnects.
    this.queueTimer = setInterval(() => this.processQueue(), 50);

    this.rawModeTimer = setInterval(() => this.checkRawMode(), config.mqtt.rawModeCheckMs ?? 2000);

    this.queueTimer.unref?.();
    this.rawModeTimer.unref?.();
  }

  stopTimers() {
    clearInterval(this.queueTimer);
    clearInterval(this.rawModeTimer);
    this.queueTimer = null;
    this.rawModeTimer = null;
  }

  setProcessor(processor) {
    this.processor = processor;
  }

  // ==========================================================
  // STATUS
  // ==========================================================

  updateStatus(newStatus) {
    if (this.status === newStatus) return;
    this.status = newStatus;
    console.log(`[WardOS MQTT] ${newStatus}`);

    const detail = this.getConnectionInfo();
    this.events.dispatchEvent(new CustomEvent("mqtt-status", { detail }));

    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("mqtt-status", { detail: newStatus }));
    }
  }

  onStatus(callback) {
    const handler = event => callback(event.detail);
    this.events.addEventListener("mqtt-status", handler);
    return () => this.events.removeEventListener("mqtt-status", handler);
  }

  getStatus() {
    return this.status;
  }

  // ==========================================================
  // CONNECT
  // ==========================================================

  connect() {
    if (this.client || this.connecting) return;
    this.stopped = false;

    if (!this.mqttLib) {
      console.warn("[WardOS MQTT] MQTT library not available.");
      this.lastError = "MQTT library not loaded";
      this.updateStatus("OFFLINE");
      return;
    }

    console.log(`[WardOS MQTT] Connecting to ${this.url}`);
    this.connecting = true;
    this.updateStatus("CONNECTING");

    let client;

    try {
      client = this.mqttLib.connect(this.url, {
        reconnectPeriod: 0,               // manual reconnect
        connectTimeout: 8000,
        keepalive: config.mqtt.keepAlive,
        clean: true,
        clientId: `wardos-server-${Math.random().toString(36).slice(2, 8)}`,
        ...this.clientOptions
      });
    } catch (error) {
      console.error("[WardOS MQTT] Connection creation failed:", error.message);
      this.lastError = error.message;
      this.client = null;
      this.connecting = false;
      this.updateStatus("OFFLINE");
      this.scheduleReconnect();
      return;
    }

    this.client = client;
    const isActive = () => this.client === client;

    client.on("connect", () => {
      if (!isActive()) return;
      console.log("[WardOS MQTT] Broker connected");
      this.connecting = false;
      this.reconnectAttempts = 0;
      this.isRawMode = false;
      this.lastError = null;
      this.connectedSince = Date.now();
      this.lastCleanMessageTime = Date.now();
      this.updateStatus("CONNECTED");
      this.subscribe(config.mqtt.cleanTopic);
      this.subscribe(config.mqtt.rawTopic);
    });

    client.on("message", (topic, message) => {
      if (!isActive()) return;
      this.stats.received += 1;

      if (this.messageQueue.length >= this.maxQueueLength) {
        // Back-pressure: drop the oldest to keep the newest data.
        this.messageQueue.shift();
        this.stats.dropped += 1;
      }

      // Only buffer here. Parsing happens in processQueue().
      this.messageQueue.push({ topic, message, receivedAt: Date.now() });
    });

    client.on("close", () => {
      if (!isActive()) return;
      console.warn("[WardOS MQTT] Connection closed");
      // Null the reference BEFORE scheduling the reconnect.
      this.client = null;
      this.connecting = false;
      this.connectedSince = null;
      this.updateStatus("OFFLINE");
      try { client.removeAllListeners?.(); client.end?.(true); } catch { /* ignore */ }
      if (!this.stopped) this.scheduleReconnect();
    });

    client.on("error", error => {
      if (!isActive()) return;
      this.lastError = error?.message ?? String(error);
      console.error("[WardOS MQTT] MQTT error:", this.lastError);
      // The close event handles cleanup and reconnection.
    });

    client.on("offline", () => {
      if (!isActive()) return;
      this.updateStatus("OFFLINE");
    });
  }

  subscribe(topic) {
    if (!this.client) return;
    this.client.subscribe(topic, { qos: 0 }, error => {
      if (error) {
        console.error(`[WardOS MQTT] Failed to subscribe: ${topic}`, error.message);
        return;
      }
      console.log(`[WardOS MQTT] Subscribed: ${topic}`);
    });
  }

  // ==========================================================
  // MESSAGE QUEUE PROCESSOR
  // ==========================================================

  processQueue() {
    if (this.messageQueue.length === 0) return;

    const batch = this.messageQueue.splice(0, this.maxMessagesPerTick);

    for (const { topic, message, receivedAt } of batch) {
      let payload;

      try {
        payload = typeof message === "string" || message instanceof Uint8Array
          ? JSON.parse(message.toString())
          : message;
      } catch {
        this.stats.invalid += 1;
        console.warn(`[WardOS MQTT] Non-JSON payload on ${topic} discarded`);
        continue;
      }

      const topicStats = this.stats.topics[topic] ?? (this.stats.topics[topic] = { count: 0, lastAt: null });
      topicStats.count += 1;
      topicStats.lastAt = receivedAt;
      this.stats.lastMessageAt = receivedAt;

      if (topic === config.mqtt.cleanTopic) {
        this.lastCleanMessageTime = receivedAt;
        if (this.isRawMode) {
          this.isRawMode = false;
          this.updateStatus("CONNECTED");
        }
      }

      try {
        const accepted = this.processor ? this.processor(topic, payload, receivedAt) : true;
        if (accepted === false) this.stats.invalid += 1;
      } catch (error) {
        this.stats.invalid += 1;
        console.error("[WardOS MQTT] Error processing message:", error);
      }
    }
  }

  // ==========================================================
  // RAW MODE DETECTION (unchanged rule: >10 s, every 2 s)
  // ==========================================================

  checkRawMode() {
    if (this.status === "OFFLINE" || this.status === "CONNECTING") return;

    const silence = Date.now() - this.lastCleanMessageTime;

    if (silence > (config.mqtt.rawModeSilenceMs ?? 10000) && !this.isRawMode) {
      this.isRawMode = true;
      console.warn("[WardOS MQTT] Clean telemetry silent >10s. RAW MODE.");
      this.updateStatus("RAW MODE");
    }
  }

  // ==========================================================
  // RECONNECT (exponential backoff, max 30 s)
  // ==========================================================

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;

    this.reconnectAttempts += 1;
    const baseDelay = config.mqtt.reconnectDelay || 3000;
    const delay = Math.min(baseDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)), 30000);

    this.nextReconnectAt = Date.now() + delay;
    console.log(`[WardOS MQTT] Reconnecting in ${delay / 1000}s...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextReconnectAt = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  disconnect() {
    console.log("[WardOS MQTT] Manual disconnect");
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connecting = false;
    this.reconnectAttempts = 0;
    const client = this.client;
    this.client = null;

    if (client) {
      try { client.end(true); } catch (error) { console.error("[WardOS MQTT] Disconnect error:", error); }
    }
    this.updateStatus("OFFLINE");
  }

  // Test / tooling hook: inject a message through the same pipeline.
  injectMessage(topic, payload) {
    this.messageQueue.push({ topic, message: payload, receivedAt: Date.now() });
  }

  getConnectionInfo() {
    return {
      status: this.status,
      url: this.url,
      connected: !!this.client && !this.connecting,
      rawMode: this.isRawMode,
      queuedMessages: this.messageQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      nextReconnectAt: this.nextReconnectAt ?? null,
      lastError: this.lastError,
      connectedSince: this.connectedSince,
      stats: {
        received: this.stats.received,
        invalid: this.stats.invalid,
        dropped: this.stats.dropped,
        lastMessageAt: this.stats.lastMessageAt,
        topics: { ...this.stats.topics }
      }
    };
  }
}
