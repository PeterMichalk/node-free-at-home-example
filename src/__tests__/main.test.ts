/**
 * Tests for the polling & energy-calculation logic in main.ts.
 *
 * Strategy: each test re-imports main.ts via jest.resetModules() +
 * jest.doMock() so that module-level side effects (FreeAtHome / AddOn
 * construction) always use fresh mocks and internal state starts clean.
 */

describe('main – polling & energy calculation', () => {
  let mockMeter: {
    setCurrentPowerConsumed: jest.Mock;
    setTotalEnergyImported: jest.Mock;
    setTotalEnergyExported: jest.Mock;
    setImportedEnergyToday: jest.Mock;
    setExportedEnergyToday: jest.Mock;
  };
  let mockCreateDevice: jest.Mock;
  let mockGetCurrentData: jest.Mock;
  let mockGetDeviceId: jest.Mock;
  let triggerConfigChanged: (config: Partial<{ email: string; password: string; pollIntervalSeconds: number }>) => void;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.resetModules();

    mockMeter = {
      setCurrentPowerConsumed: jest.fn().mockResolvedValue(undefined),
      setTotalEnergyImported: jest.fn().mockResolvedValue(undefined),
      setTotalEnergyExported: jest.fn().mockResolvedValue(undefined),
      setImportedEnergyToday: jest.fn().mockResolvedValue(undefined),
      setExportedEnergyToday: jest.fn().mockResolvedValue(undefined),
    };
    mockCreateDevice = jest.fn().mockResolvedValue(mockMeter);
    mockGetCurrentData = jest.fn();
    mockGetDeviceId = jest.fn().mockResolvedValue('abc123def456');

    jest.doMock('@busch-jaeger/free-at-home', () => ({
      FreeAtHome: jest.fn(() => ({
        activateSignalHandling: jest.fn(),
        createEnergyTwoWayMeterV2Device: mockCreateDevice,
      })),
      AddOn: {
        readMetaData: jest.fn(() => ({ id: 'test-addon' })),
        AddOn: jest.fn(() => ({
          on: jest.fn((event: string, listener: (cfg: any) => void) => {
            if (event === 'configurationChanged') {
              triggerConfigChanged = (items) =>
                listener({ default: { items } });
            }
          }),
          connectToConfiguration: jest.fn(),
        })),
      },
    }));

    jest.doMock('../powerfoxClient', () => ({
      PowerfoxClient: jest.fn(() => ({
        getDeviceId: mockGetDeviceId,
        getCurrentData: mockGetCurrentData,
      })),
    }));

    // Importing main.ts triggers module-level code and wires up listeners
    require('../main');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Flush all pending microtasks (resolved promises) */
  async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Device discovery
  // ---------------------------------------------------------------------------

  it('discovers the device ID via getDeviceId() before polling', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    expect(mockGetDeviceId).toHaveBeenCalledTimes(1);
  });

  it('polls using the discovered device ID', async () => {
    mockGetDeviceId.mockResolvedValue('mymeter001');
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    expect(mockGetCurrentData).toHaveBeenCalledWith('mymeter001');
  });

  it('stops and logs an error when device discovery fails (e.g. wrong credentials)', async () => {
    mockGetDeviceId.mockRejectedValue(new Error('HTTP 403: Request error: Forbidden'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    triggerConfigChanged({ email: 'u@x.de', password: 'wrong', pollIntervalSeconds: 30 });
    await flush();

    expect(mockGetCurrentData).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Gerät-Erkennung fehlgeschlagen'),
    );
    consoleSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Configuration handling
  // ---------------------------------------------------------------------------

  it('creates the energy meter device when credentials are provided', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    expect(mockCreateDevice).toHaveBeenCalledWith('powerfox-main', 'Powerfox Stromzähler');
  });

  it('does not start polling when email is missing', async () => {
    triggerConfigChanged({ password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    expect(mockGetDeviceId).not.toHaveBeenCalled();
  });

  it('does not start polling when password is missing', async () => {
    triggerConfigChanged({ email: 'u@x.de', pollIntervalSeconds: 30 });
    await flush();

    expect(mockGetDeviceId).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Meter data mapping
  // ---------------------------------------------------------------------------

  it('passes current power (Watt) to the meter', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 1337, Timestamp: 0, A_Plus: 50, A_Minus: 0 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    expect(mockMeter.setCurrentPowerConsumed).toHaveBeenCalledWith('1337');
  });

  it('passes total import and export energy to the meter', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 1500.5, A_Minus: 200.25 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    expect(mockMeter.setTotalEnergyImported).toHaveBeenCalledWith('1500.5');
    expect(mockMeter.setTotalEnergyExported).toHaveBeenCalledWith('200.25');
  });

  it('uses 0 for export when A_Minus is absent (one-way meter)', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 100 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    expect(mockMeter.setTotalEnergyExported).toHaveBeenCalledWith('0');
  });

  // ---------------------------------------------------------------------------
  // Today energy calculation
  // ---------------------------------------------------------------------------

  it('calculates today energy in Wh from kWh delta between polls', async () => {
    // Poll 1 – establishes daily baseline
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100.0, A_Minus: 10.0 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    // Poll 2 – +0.5 kWh imported, +0.25 kWh exported (use binary fractions to avoid float drift)
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100.5, A_Minus: 10.25 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockMeter.setImportedEnergyToday).toHaveBeenLastCalledWith('500');   // 0.5 × 1000
    expect(mockMeter.setExportedEnergyToday).toHaveBeenLastCalledWith('250');   // 0.25 × 1000
  });

  it('clamps today energy to 0 when reading drops (e.g. after meter reset)', async () => {
    // Poll 1 – baseline with high value
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 9999.0, A_Minus: 0 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    // Poll 2 – A_Plus lower than baseline (meter was reset)
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 1.0, A_Minus: 0 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockMeter.setImportedEnergyToday).toHaveBeenLastCalledWith('0');
  });

  it('resets the daily baseline at midnight (day change)', async () => {
    const getDate = jest.spyOn(Date.prototype, 'getDate');
    getDate.mockReturnValue(15);

    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100.0, A_Minus: 0 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    // Simulate day change
    getDate.mockReturnValue(16);

    // New baseline = current reading → today = 0 Wh
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 102.0, A_Minus: 0 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockMeter.setImportedEnergyToday).toHaveBeenLastCalledWith('0');

    getDate.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Polling interval
  // ---------------------------------------------------------------------------

  it('uses 30 s as default when pollIntervalSeconds is not set', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    triggerConfigChanged({ email: 'u@x.de', password: 'pw' }); // no interval
    await flush();

    const callsAfterInit = mockGetCurrentData.mock.calls.length;

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockGetCurrentData.mock.calls.length).toBe(callsAfterInit + 1);
  });

  it('does not call meter methods when the API returns an error', async () => {
    mockGetCurrentData.mockRejectedValue(new Error('Network error'));

    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();

    expect(mockMeter.setCurrentPowerConsumed).not.toHaveBeenCalled();
  });
});
