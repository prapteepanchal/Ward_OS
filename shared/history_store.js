// shared/history_store.js

export class HistoryStore {
  constructor(maxSize = 300) {
    this.maxSize = maxSize;
    this.history = new Map();
  }

  addSample(deviceId, payload, topic) {
    if (!this.history.has(deviceId)) {
      this.history.set(deviceId, { clean: [], raw: [] });
    }

    const deviceHistory = this.history.get(deviceId);
    const targetBuffer = topic.includes('clean') ? deviceHistory.clean : deviceHistory.raw;

    const sample = {
      timestamp: Date.now(),
      hr: payload.hr,
      spo2: payload.spo2,
      temp: payload.temp,
      anomalyDetected: payload.anomaly_detected || payload.anomalyDetected || false,
      sourcePath: payload.source_path || 'UNKNOWN'
    };

    targetBuffer.push(sample);

    if (targetBuffer.length > this.maxSize) {
      targetBuffer.shift();
    }
  }

  getHistory(deviceId) {
    return this.history.get(deviceId) || { clean: [], raw: [] };
  }
}

export const historyStore = new HistoryStore();
