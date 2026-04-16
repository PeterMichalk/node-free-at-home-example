import * as https from 'https';

export interface PowerfoxCurrentData {
  Watt: number;
  Timestamp: number;
  A_Plus: number;
  A_Minus?: number;
  A_Plus_HT?: number;
  A_Plus_NT?: number;
}

export class PowerfoxClient {
  private readonly baseUrl = 'https://backend.powerfox.energy/api/2.0';
  private readonly auth: string;

  constructor(email: string, password: string) {
    this.auth = Buffer.from(`${email}:${password}`).toString('base64');
  }

  getCurrentData(): Promise<PowerfoxCurrentData> {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}/my/main/current?unit=kwh`;
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
                resolve(JSON.parse(data) as PowerfoxCurrentData);
              } catch {
                reject(new Error(`Failed to parse powerfox response: ${data}`));
              }
            } else {
              reject(new Error(`Powerfox API error HTTP ${res.statusCode}: ${data}`));
            }
          });
        })
        .on('error', reject);
    });
  }
}
