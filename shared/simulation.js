// shared/simulation.js
import { config } from './config.js';
import { mqttClient } from './mqtt_client.js';

export function startSimulation() {
  console.log("Starting WardOS Simulation Mode...");
  
  // Fake device states
  const simStates = {
    1: { hr: 78, spo2: 97, temp: 36.8, mode: 'normal' },
    2: { hr: 82, spo2: 96, temp: 37.1, mode: 'normal' },
    3: { hr: 132, spo2: 94, temp: 37.8, mode: 'warning' }, // High HR warning
    4: { hr: 145, spo2: 88, temp: 36.5, mode: 'critical' }, // Emergency
    5: { hr: 65, spo2: 98, temp: 36.4, mode: 'anomaly' }, // ML Anomaly
    6: { hr: 72, spo2: 99, temp: 36.6, mode: 'removed' }, // Sensor removed
    7: { hr: 70, spo2: 95, temp: 36.9, mode: 'offline' }  // Offline (no updates)
  };

  let seqNum = 1000;

  setInterval(() => {
    Object.entries(simStates).forEach(([id, baseData]) => {
      const deviceId = parseInt(id);
      
      if (baseData.mode === 'offline') return; // Don't send data

      seqNum++;
      
      // Add slight jitter
      const jitter = () => (Math.random() * 2 - 1);
      
      let payload = {
        device_id: deviceId,
        seq: seqNum,
        hr: Math.round(baseData.hr + jitter()),
        spo2: Math.max(80, Math.min(100, Math.round(baseData.spo2 + jitter() * 0.5))),
        temp: (baseData.temp + jitter() * 0.1).toFixed(1),
        emergency: baseData.mode === 'critical' ? 'EMERGENCY' : 'OK',
        cleaned: true,
        anomaly_detected: baseData.mode === 'anomaly',
        source_path: baseData.mode === 'anomaly' ? 'ANOMALY_REPLACED' : 'ML'
      };

      if (baseData.mode === 'removed') {
        payload.hr = 'REMOVED';
        payload.spo2 = 'REMOVED';
        payload.temp = 'N/A';
        payload.emergency = 'REMOVED';
      }
      
      // 5% chance to drop a clean frame and send raw instead
      const sendRaw = Math.random() > 0.95;
      const topic = sendRaw ? config.mqtt.rawTopic : config.mqtt.cleanTopic;
      
      if (sendRaw) {
        payload.cleaned = false;
        payload.source_path = 'RAW';
      }
      
      mqttClient.handleSimulatedMessage(topic, payload);
    });
  }, 1000); // 1Hz update rate
}
