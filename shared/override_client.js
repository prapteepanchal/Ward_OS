// shared/override_client.js

export class OverrideClient {
  static async acknowledge(deviceId, seq) {
    console.log(`[Override] Acknowledged device ${deviceId} seq ${seq}`);
    return Promise.resolve({ status: 'success' });
  }

  static async requestDoctor(deviceId, seq) {
    console.log(`[Override] Requested doctor for device ${deviceId} seq ${seq}`);
    return Promise.resolve({ status: 'success' });
  }

  static async callCodeBlue(deviceId, seq) {
    console.log(`[Override] Called CODE BLUE for device ${deviceId} seq ${seq}`);
    return Promise.resolve({ status: 'success' });
  }

  static async addNote(deviceId, note) {
    console.log(`[Override] Note added for device ${deviceId}: ${note}`);
    return Promise.resolve({ status: 'success' });
  }
}
