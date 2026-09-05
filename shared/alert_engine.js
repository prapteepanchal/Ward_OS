// shared/alert_engine.js

export class AlertEngine {
  constructor() {
    this.alerts = [];
    this.listeners = [];
  }

  subscribe(callback) {
    this.listeners.push(callback);
  }

  notify(alert) {
    this.listeners.forEach(cb => cb(alert));
  }

  addAlert(alert) {
    // deduplication key
    const key = `${alert.deviceId}-${alert.type}`;
    
    const existing = this.alerts.find(a => a.key === key && !a.expired);
    if (existing) {
      return; // Deduplicated
    }

    const newAlert = {
      ...alert,
      key,
      id: Date.now().toString() + Math.random().toString(36).substring(2, 5),
      timestamp: Date.now(),
      expired: false
    };

    this.alerts.push(newAlert);
    this.notify(newAlert);

    // Expiration logic based on type
    const ttl = alert.type === 'CRITICAL' ? 30000 : (alert.type === 'ANOMALY' ? 10000 : 15000);
    
    setTimeout(() => {
      const idx = this.alerts.findIndex(a => a.id === newAlert.id);
      if (idx !== -1) {
        this.alerts[idx].expired = true;
      }
    }, ttl);
  }
}

export const alertEngine = new AlertEngine();
