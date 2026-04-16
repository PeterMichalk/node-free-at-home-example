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

describe('PowerfoxClient – Authorization', () => {
  it('sends correct Basic Auth header', async () => {
    mockResponse(200, JSON.stringify({ Watt: 0, Timestamp: 0, A_Plus: 0 }));
    await new PowerfoxClient('user@example.com', 'secret').getCurrentData();

    const expectedAuth = `Basic ${Buffer.from('user@example.com:secret').toString('base64')}`;
    expect(mockHttpsGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Authorization: expectedAuth } }),
      expect.any(Function),
    );
  });

  it('calls the correct endpoint URL with unit=kwh', async () => {
    mockResponse(200, JSON.stringify({ Watt: 0, Timestamp: 0, A_Plus: 0 }));
    await new PowerfoxClient('u@x.de', 'p').getCurrentData();

    expect(mockHttpsGet).toHaveBeenCalledWith(
      'https://backend.powerfox.energy/api/2.0/my/main/current?unit=kwh',
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe('PowerfoxClient – Successful responses', () => {
  it('parses a response with all fields', async () => {
    const data = { Watt: 1234, Timestamp: 1700000000, A_Plus: 12345.678, A_Minus: 1.5, A_Plus_HT: 6000, A_Plus_NT: 6345.678 };
    mockResponse(200, JSON.stringify(data));

    const result = await new PowerfoxClient('u@x.de', 'p').getCurrentData();

    expect(result).toEqual(data);
  });

  it('parses a response without optional fields (one-way meter)', async () => {
    const data = { Watt: 500, Timestamp: 1700000000, A_Plus: 999.0 };
    mockResponse(200, JSON.stringify(data));

    const result = await new PowerfoxClient('u@x.de', 'p').getCurrentData();

    expect(result.Watt).toBe(500);
    expect(result.A_Plus).toBe(999.0);
    expect(result.A_Minus).toBeUndefined();
    expect(result.A_Plus_HT).toBeUndefined();
  });

  it('handles negative Watt (feed-in)', async () => {
    mockResponse(200, JSON.stringify({ Watt: -800, Timestamp: 0, A_Plus: 100, A_Minus: 50 }));

    const result = await new PowerfoxClient('u@x.de', 'p').getCurrentData();

    expect(result.Watt).toBe(-800);
  });
});

describe('PowerfoxClient – Error handling', () => {
  it('rejects with HTTP 401 (wrong credentials)', async () => {
    mockResponse(401, 'Unauthorized');

    await expect(new PowerfoxClient('u@x.de', 'wrong').getCurrentData())
      .rejects.toThrow('401');
  });

  it('rejects with HTTP 500 (server error)', async () => {
    mockResponse(500, 'Internal Server Error');

    await expect(new PowerfoxClient('u@x.de', 'p').getCurrentData())
      .rejects.toThrow('500');
  });

  it('rejects when response body is not valid JSON', async () => {
    mockResponse(200, 'not-valid-json');

    await expect(new PowerfoxClient('u@x.de', 'p').getCurrentData())
      .rejects.toThrow('Failed to parse powerfox response');
  });

  it('rejects on network error (e.g. ECONNREFUSED)', async () => {
    mockNetworkError('ECONNREFUSED');

    await expect(new PowerfoxClient('u@x.de', 'p').getCurrentData())
      .rejects.toThrow('ECONNREFUSED');
  });
});
