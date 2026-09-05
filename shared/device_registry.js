// shared/device_registry.js

const mockRegistry = {
  1: { bed: '01', patientName: 'John Doe', ward: 'ICU', age: 45, id: 'PT-1001' },
  2: { bed: '02', patientName: 'Jane Smith', ward: 'ICU', age: 62, id: 'PT-1002' },
  3: { bed: '03', patientName: 'Robert Johnson', ward: 'ICU', age: 78, id: 'PT-1003' },
  4: { bed: '04', patientName: 'Emily Davis', ward: 'ICU', age: 31, id: 'PT-1004' },
  5: { bed: '05', patientName: 'Michael Wilson', ward: 'ICU', age: 55, id: 'PT-1005' },
  6: { bed: '06', patientName: 'Sarah Brown', ward: 'ICU', age: 41, id: 'PT-1006' },
  7: { bed: '07', patientName: 'David Miller', ward: 'ICU', age: 67, id: 'PT-1007' },
  8: { bed: '08', patientName: 'Jessica Moore', ward: 'ICU', age: 29, id: 'PT-1008' },
  9: { bed: '09', patientName: 'William Taylor', ward: 'ICU', age: 82, id: 'PT-1009' },
  10: { bed: '10', patientName: 'Ashley Anderson', ward: 'ICU', age: 50, id: 'PT-1010' }
};

export class DeviceRegistry {
  static getDeviceInfo(deviceId) {
    return mockRegistry[deviceId] || { bed: '??', patientName: 'Unknown', ward: 'Unknown', age: 0, id: 'UNKNOWN' };
  }

  static getAllDevices() {
    return Object.keys(mockRegistry).map(id => ({ deviceId: parseInt(id), ...mockRegistry[id] }));
  }
}
