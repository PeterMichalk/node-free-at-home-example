import * as https from 'https';
import { EventEmitter } from 'events';
import { PowerfoxClient } from '../powerfoxClient';

jest.mock('https');

const mockHttpsGet = https.get as jest.MockedFunction<typeof https.get>;

function mockResponse(statusCode: number, body: string) {
  mockHttpsGet.mockImplementation((_url: any, _options: any, callback: any) => {
    const res = new EventEmitter() as any;
    res.statusCode = statusCode;
    const req = { on: jest.fn().mockReturnThis() };
    // Call callback synchronously — listeners are registered inside it before we emit
    callback(res);
    res.emit('data', body);
    res.emit('end');
    return req as any;
  });
}

function mockNetworkError(message: string) {
  mockHttpsGet.mockImplementation(() => {
    const req = new EventEmitter() as any;
    req.end = jest.fn();
    // Must be async: `.on('error', ...)` is chained after https.get() returns
    process.nextTick(() => req.emit('error', new Error(message)));
    return req;
  });
}

beforeEach(() => mockHttpsGet.mockReset());

// ---------------------------------------------------------------------------
// getDeviceId
// ---------------------------------------------------------------------------

describe('PowerfoxClient.getDeviceId()', () => {
  it('returns the DeviceId of the first device', async () => {
    const devices = [{ DeviceId: '60007A47C6BE', AccountAssociatedSince: 0, MainDevice: true, Prosumer: false, Division: 0 }];
    mockResponse(200, JSON.stringify(devices));

    const id = await new PowerfoxClient('u@x.de', 'pw').getDeviceId();

    expect(id).toBe('60007A47C6BE');
    expect(mockHttpsGet).toHaveBeenCalledWith(
      expect.stringContaining('/my/all/devices'),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('returns the first device when multiple are registered', async () => {
    const devices = [
      { DeviceId: 'AAA111BBB222', AccountAssociatedSince: 0, MainDevice: true, Prosumer: false, Division: 0 },
      { DeviceId: 'CCC333DDD444', AccountAssociatedSince: 0, MainDevice: false, Prosumer: false, Division: 0 },
    ];
    mockResponse(200, JSON.stringify(devices));

    const id = await new PowerfoxClient('u@x.de', 'pw').getDeviceId();
    expect(id).toBe('AAA111BBB222');
  });

  it('rejects when no devices are found', async () => {
    mockResponse(200, JSON.stringify([]));
    await expect(new PowerfoxClient('u@x.de', 'pw').getDeviceId()).rejects.toThrow(
      'Keine powerfox Geräte',
    );
  });

  it('rejects with HTTP 403 (wrong credentials)', async () => {
    mockResponse(403, 'Request error: Forbidden');
    await expect(new PowerfoxClient('u@x.de', 'wrong').getDeviceId()).rejects.toThrow('403');
  });

  it('rejects when device list is empty', async () => {
    mockResponse(200, JSON.stringify([]));
    await expect(new PowerfoxClient('u@x.de', 'pw').getDeviceId()).rejects.toThrow(
      'Keine powerfox Geräte',
    );
  });
});

// ---------------------------------------------------------------------------
// getCurrentData – Authorization & URL
// ---------------------------------------------------------------------------

describe('PowerfoxClient – Authorization', () => {
  it('sends correct Basic Auth header', async () => {
    mockResponse(200, JSON.stringify({ Watt: 0, Timestamp: 0, A_Plus: 0 }));
    await new PowerfoxClient('user@example.com', 'secret').getCurrentData('abc123');

    const expectedAuth = `Basic ${Buffer.from('user@example.com:secret').toString('base64')}`;
    expect(mockHttpsGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: expectedAuth } }),
      expect.any(Function),
    );
  });

  it('calls the device-specific endpoint with unit=kwh', async () => {
    mockResponse(200, JSON.stringify({ Watt: 0, Timestamp: 0, A_Plus: 0 }));
    await new PowerfoxClient('u@x.de', 'p').getCurrentData('abc123def456');

    expect(mockHttpsGet).toHaveBeenCalledWith(
      'https://backend.powerfox.energy/api/2.0/my/abc123def456/current?unit=kwh',
      expect.anything(),
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// getCurrentData – Successful responses
// ---------------------------------------------------------------------------

describe('PowerfoxClient – Successful responses', () => {
  it('parses a response with all fields', async () => {
    const data = { Watt: 1234, Timestamp: 1700000000, A_Plus: 12345.678, A_Minus: 1.5, A_Plus_HT: 6000, A_Plus_NT: 6345.678 };
    mockResponse(200, JSON.stringify(data));

    const result = await new PowerfoxClient('u@x.de', 'p').getCurrentData('abc');
    expect(result).toEqual(data);
  });

  it('parses a response without optional fields (one-way meter)', async () => {
    const data = { Watt: 500, Timestamp: 1700000000, A_Plus: 999.0 };
    mockResponse(200, JSON.stringify(data));

    const result = await new PowerfoxClient('u@x.de', 'p').getCurrentData('abc');
    expect(result.Watt).toBe(500);
    expect(result.A_Minus).toBeUndefined();
  });

  it('handles negative Watt (feed-in)', async () => {
    mockResponse(200, JSON.stringify({ Watt: -800, Timestamp: 0, A_Plus: 100, A_Minus: 50 }));
    const result = await new PowerfoxClient('u@x.de', 'p').getCurrentData('abc');
    expect(result.Watt).toBe(-800);
  });
});

// ---------------------------------------------------------------------------
// getCurrentData – Error handling
// ---------------------------------------------------------------------------

describe('PowerfoxClient – Error handling', () => {
  it('rejects with HTTP 401 (wrong credentials)', async () => {
    mockResponse(401, 'Unauthorized');
    await expect(new PowerfoxClient('u@x.de', 'wrong').getCurrentData('abc')).rejects.toThrow('401');
  });

  it('rejects with HTTP 403 and includes the response body', async () => {
    mockResponse(403, 'Request error: Forbidden');
    await expect(new PowerfoxClient('u@x.de', 'p').getCurrentData('abc'))
      .rejects.toThrow('HTTP 403: Request error: Forbidden');
  });

  it('rejects with HTTP 500 (server error)', async () => {
    mockResponse(500, 'Internal Server Error');
    await expect(new PowerfoxClient('u@x.de', 'p').getCurrentData('abc')).rejects.toThrow('500');
  });

  it('rejects when response body is not valid JSON', async () => {
    mockResponse(200, 'not-valid-json');
    await expect(new PowerfoxClient('u@x.de', 'p').getCurrentData('abc'))
      .rejects.toThrow('Ungültige JSON-Antwort');
  });

  it('rejects on network error (e.g. ECONNREFUSED)', async () => {
    mockNetworkError('ECONNREFUSED');
    await expect(new PowerfoxClient('u@x.de', 'p').getCurrentData('abc')).rejects.toThrow('ECONNREFUSED');
  });
});
