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
    const devices = await this.get<unknown[]>('/my/all/devices');
    if (!Array.isArray(devices) || devices.length === 0) {
      throw new Error('Keine powerfox Geräte im Account gefunden');
    }

    const device = devices[0] as Record<string, unknown>;
    console.log(`[powerfox] Erstes Gerät: ${JSON.stringify(device)}`);

    // Try all known field name variants first
    const knownFields = ['poweroptiId', 'powerOptiId', 'id', 'deviceId', 'serial', 'uid', 'mac', 'hardwareId'];
    for (const field of knownFields) {
      const val = device[field];
      if (typeof val === 'string' && val.length > 0) {
        console.log(`[powerfox] Geräte-ID (Feld "${field}"): ${val}`);
        return val;
      }
    }

    // Fallback: find any string field that looks like a 12-char hex device ID (e.g. 60007A47C6BE)
    const hexId = /^[0-9A-Fa-f]{12}$/;
    for (const [key, val] of Object.entries(device)) {
      if (typeof val === 'string' && hexId.test(val)) {
        console.log(`[powerfox] Geräte-ID (Feld "${key}" per Mustererkennung): ${val}`);
        return val;
      }
    }

    throw new Error(
      `Kein Geräte-ID-Feld gefunden. Gerät: ${JSON.stringify(device)}`
    );
  }

  getCurrentData(deviceId: string): Promise<PowerfoxCurrentData> {
    return this.get<PowerfoxCurrentData>(`/my/${deviceId}/current?unit=kwh`);
  }

  private get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return new Promise((resolve, reject) => {
      const options = {
        headers: {
          Authorization: `Basic ${this.auth}`,
        },
      };

      console.log(`[powerfox] --> GET ${url}`);

      https
        .get(url, options, (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            const body = data.trim();
            console.log(`[powerfox] <-- ${res.statusCode} ${url} | Body: ${body.substring(0, 200)}`);
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(body) as T);
              } catch {
                reject(new Error(`Ungültige JSON-Antwort: ${body}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            }
          });
        })
        .on('error', (err: NodeJS.ErrnoException) => {
          console.error(
            `[powerfox] Netzwerkfehler ${url} | ` +
            `code=${err.code ?? '?'} syscall=${err.syscall ?? '?'} message=${err.message}`
          );
          reject(err);
        });
    });
  }
}
