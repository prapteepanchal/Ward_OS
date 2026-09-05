// shared/state_store.js
import { config } from './config.js';
import { DeviceRegistry } from './device_registry.js';
import { alertEngine } from './alert_engine.js';

class StateStore {
  constructor() {
    this.beds = new Map();
    this.listeners = [];
  }

  subscribe(callback) {
    this.listeners.push(callback);
  }

  notify(deviceId) {
    this.listeners.forEach(cb => cb(deviceId));
  }

  deriveStatus(payload) {
    // 1. HR === REMOVED -> removed
    if (payload.hr === 'REMOVED') return 'removed';
    
    // 2. anomalyDetected === true -> warning
    if (payload.anomaly_detected === true || payload.anomalyDetected === true) return 'warning'; 
    
    // 3. emergency === EMERGENCY -> critical
    if (payload.emergency === 'EMERGENCY') return 'critical';
    
    // 4. threshold breach -> warning
    const hr = parseFloat(payload.hr);
    const spo2 = parseFloat(payload.spo2);
    const temp = parseFloat(payload.temp);
    const t = config.thresholds;
    
    if (hr > t.hr.warningHigh || hr < t.hr.min || 
        spo2 < t.spo2.warningLow || 
        temp > t.temp.warningHigh || temp < t.temp.min) {
      return 'warning';
    }

    // 5. otherwise -> ok
    return 'ok';
  }

  updateState(payload) {
    const deviceId = payload.device_id;
    const isClean = payload.topic === config.mqtt.cleanTopic;
    
    let currentState = this.beds.get(deviceId);
    
    if (!currentState) {
      const deviceInfo = DeviceRegistry.getDeviceInfo(deviceId);
      currentState = {
        deviceId,
        ward: deviceInfo.ward,
        bed: deviceInfo.bed,
        patientName: deviceInfo.patientName,
        id: deviceInfo.id,
        age: deviceInfo.age,
        lastSeen: Date.now(),
        vitals: { hr: '--', spo2: '--', temp: '--', emergency: 'OK' },
        mlMeta: { cleaned: true, anomalyDetected: false, sourcePath: 'ML' },
        seq: 0,
        status: 'offline'
      };
    }

    // priority: clean data > raw data
    // if we get raw data, only update if it's newer and we haven't seen clean data in a while (handled by mqtt client raw mode usually)
    
    const anomaly = payload.anomaly_detected || payload.anomalyDetected || false;
    const status = this.deriveStatus(payload);

    currentState.lastSeen = Date.now();
    currentState.vitals = {
      hr: payload.hr,
      spo2: payload.spo2,
      temp: payload.temp,
      emergency: payload.emergency
    };
    currentState.mlMeta = {
      cleaned: payload.cleaned ?? isClean,
      anomalyDetected: anomaly,
      sourcePath: payload.source_path || (isClean ? 'ML' : 'RAW')
    };
    currentState.seq = payload.seq;
    currentState.status = status;

    this.beds.set(deviceId, currentState);
    this.notify(deviceId);

    // Emit alerts
    if (status === 'critical') {
      alertEngine.addAlert({
        type: 'CRITICAL',
        deviceId,
        bed: currentState.bed,
        patientName: currentState.patientName,
        vitals: currentState.vitals,
        message: 'Verify patient immediately.'
      });
    } else if (anomaly) {
      alertEngine.addAlert({
        type: 'ANOMALY',
        deviceId,
        bed: currentState.bed,
        patientName: currentState.patientName,
        message: 'Reading flagged by anomaly detector.'
      });
    }
  }
  
  getState(deviceId) {
    return this.beds.get(deviceId);
  }

  getAllStates() {
    return Array.from(this.beds.values());
  }

  markOffline(deviceId) {
    const state = this.beds.get(deviceId);
    if (state && state.status !== 'offline') {
      state.status = 'offline';
      this.notify(deviceId);
    }
  }
}

export const stateStore = new StateStore();
