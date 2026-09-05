export const config = {
  mqtt: {
    broker: 'localhost',
    wsPort: 9001,
    cleanTopic: 'wardos/cleaned/vitals',
    rawTopic: 'wearable/data',
    keepAlive: 30,
    reconnectDelay: 5000
  },
  thresholds: {
    hr: {
      min: 60,
      max: 100,
      criticalLow: 40,
      criticalHigh: 140,
      warningHigh: 130
    },
    spo2: {
      min: 95,
      max: 100,
      criticalLow: 90,
      criticalHigh: 100,
      warningLow: 92
    },
    temp: {
      min: 36.1,
      max: 37.5,
      criticalLow: 35.0,
      criticalHigh: 39.0,
      warningHigh: 38.5
    }
  }
};
