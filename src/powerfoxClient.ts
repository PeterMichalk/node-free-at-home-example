import * as https from 'https';

export interface PowerfoxCurrentData {
  Watt: number;
  Timestamp: number;
  A_Plus: number;
  A_Minus?: number;
  A_Plus_HT?: number;
  A_Plus_NT?: number;
}

export interface PowerfoxDevice {
  poweroptiId: string;
  name?: string;
  mode?: string;
}

export class PowerfoxClient {
  private readonly baseUrl = 'https://backend.powerfox.energy/api/2.0';
  private readonly auth: string;

  constructor(email: string, password: string) {
    this.auth = Buffer.from(`${email}:${password}`).toString('base64');
  }

  async getDeviceId(): Promise<string> {
    const devices = await this.get<PowerfoxDevice[]>('/my/all/devices');
    if (!Array.isArray(devices) || devices.length === 0) {
      throw new Error('Keine powerfox Geräte im Account gefunden');
    }
    return devices[0].poweroptiId;
  }

  getCurrentData(deviceId: string): Promise<PowerfoxCurrentData> {
    return this.get<PowerfoxCurrentData>(`/my/${deviceId}/current?unit=kwh`);
  }

  private get<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}${path}`;
      const options = {
        headers: {
          Authorization: `Basic ${this.auth}`,
        },
      };

      https
        .get(url, options, (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(data) as T);
              } catch {
                reject(new Error(`Ungültige JSON-Antwort: ${data}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data.trim()}`));
            }
          });
        })
        .on('error', reject);
    });
  }
}
