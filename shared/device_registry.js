// ============================================================
// WardOS - Device registry
// File: shared/device_registry.js
//
// Maps a wearable device ID to the patient / ward / bed it is
// currently assigned to.
//
// Previously this was a hardcoded mock. It is now an in-memory
// cache that the backend fills from the database
// (devices + device_assignments tables) and refreshes whenever
// a device is registered, assigned or unassigned.
//
// The static API (getDeviceInfo / getAllDevices) is kept so
// existing callers such as StateStore keep working.
// ============================================================

const registry = new Map();      // deviceId -> assignment info
const listeners = new Set();

function key(deviceId) {
  return String(deviceId);
}

export class DeviceRegistry {

  /**
   * Replace the whole registry.
   * @param {Array<{deviceId, patientId, mrn, patientName, ward, wardId, bed, age, label}>} entries
   */
  static load(entries = []) {
    registry.clear();
    for (const entry of entries) {
      registry.set(key(entry.deviceId), { ...entry, deviceId: key(entry.deviceId) });
    }
    DeviceRegistry.emit();
  }

  static set(entry) {
    registry.set(key(entry.deviceId), { ...entry, deviceId: key(entry.deviceId) });
    DeviceRegistry.emit();
  }

  static remove(deviceId) {
    registry.delete(key(deviceId));
    DeviceRegistry.emit();
  }

  /**
   * Returns the assignment for a device, or null when the
   * device is unknown / not assigned to a patient.
   * `id` is kept as an alias of the patient MRN for backwards
   * compatibility with the original mock registry.
   */
  static getDeviceInfo(deviceId) {
    const entry = registry.get(key(deviceId));
    if (!entry || !entry.patientId) return null;
    return { ...entry, id: entry.mrn };
  }

  static isAssigned(deviceId) {
    return !!registry.get(key(deviceId))?.patientId;
  }

  static getAllDevices() {
    return Array.from(registry.values()).map(entry => ({ ...entry, id: entry.mrn }));
  }

  static findByPatient(patientId) {
    for (const entry of registry.values()) {
      if (String(entry.patientId) === String(patientId)) return { ...entry, id: entry.mrn };
    }
    return null;
  }

  static subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  static emit() {
    for (const callback of listeners) {
      try { callback(); } catch (error) { console.error("[WardOS DeviceRegistry] listener error", error); }
    }
  }
}

export default DeviceRegistry;
