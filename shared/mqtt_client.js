// shared/mqtt_client.js
import { config } from './config.js';
import { stateStore } from './state_store.js';
import { historyStore } from './history_store.js';

export class MqttClientManager {
  constructor() {
    this.client = null;
    this.status = 'OFFLINE';
    this.messageQueue = [];
    this.lastCleanMessageTime = Date.now();
    this.isRawMode = false;
    
    // Check queue every 50ms to prevent blocking the WebSocket event loop
    setInterval(() => this.processQueue(), 50);
    
    // Check for RAW mode (clean topic silent > 10s)
    setInterval(() => this.checkRawMode(), 2000);
  }

  updateStatus(newStatus) {
    if (this.status !== newStatus) {
      this.status = newStatus;
      window.dispatchEvent(new CustomEvent('mqtt-status', { detail: newStatus }));
    }
  }

  connect() {
    if (this.client) return;
    
    this.updateStatus('CONNECTING');
    
    const url = `ws://${config.mqtt.broker}:${config.mqtt.wsPort}/mqtt`;
    
    // We check if mqtt is available globally (from lib/mqtt.min.js)
    if (typeof mqtt === 'undefined') {
      console.warn("MQTT.js not loaded. Simulation mode recommended.");
      this.updateStatus('OFFLINE');
      return;
    }

    this.client = mqtt.connect(url, {
      reconnectPeriod: 0, // Manual reconnect required
      keepalive: config.mqtt.keepAlive
    });

    this.client.on('connect', () => {
      this.updateStatus('CONNECTED');
      this.client.subscribe(config.mqtt.cleanTopic);
      this.client.subscribe(config.mqtt.rawTopic);
    });

    this.client.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        this.messageQueue.push({ topic, payload });
      } catch (e) {
        console.error("Failed to parse MQTT message", e);
      }
    });

    this.client.on('close', () => {
      this.updateStatus('OFFLINE');
      this.client = null;
      setTimeout(() => this.connect(), config.mqtt.reconnectDelay);
    });
    
    this.client.on('error', (err) => {
      console.error("MQTT Error:", err);
      if (this.client) {
         this.client.end();
      }
    });
  }

  processQueue() {
    if (this.messageQueue.length === 0) return;
    
    // Process up to 50 messages per tick
    const batch = this.messageQueue.splice(0, 50);
    
    for (const { topic, payload } of batch) {
      if (topic === config.mqtt.cleanTopic) {
        this.lastCleanMessageTime = Date.now();
        if (this.isRawMode) {
          this.isRawMode = false;
          this.updateStatus('CONNECTED');
        }
      }

      payload.topic = topic; // embed topic for state store
      stateStore.updateState(payload);
      historyStore.addSample(payload.device_id, payload, topic);
    }
  }
  
  checkRawMode() {
    if (this.status === 'OFFLINE' || this.status === 'CONNECTING') return;
    
    const timeSinceLastClean = Date.now() - this.lastCleanMessageTime;
    if (timeSinceLastClean > 10000 && !this.isRawMode) {
      this.isRawMode = true;
      this.updateStatus('RAW MODE');
    }
  }

  // Exposed for simulation
  handleSimulatedMessage(topic, payload) {
    this.messageQueue.push({ topic, payload });
  }
}

export const mqttClient = new MqttClientManager();
