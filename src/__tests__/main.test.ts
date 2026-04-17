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

  /**
   * Trigger config, let setup (device creation + device ID discovery) complete,
   * then advance past the 3 s startup delay so the first poll runs.
   */
  async function start(config: Partial<{ email: string; password: string; pollIntervalSeconds: number }>) {
    triggerConfigChanged(config);
    await flush();                   // device creation + getDeviceId
    jest.advanceTimersByTime(3000);  // fire delayed first poll
    await flush();                   // let first poll complete
  }

  // ---------------------------------------------------------------------------
  // Device discovery
  // ---------------------------------------------------------------------------

  it('discovers the device ID via getDeviceId() before polling', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockGetDeviceId).toHaveBeenCalledTimes(1);
  });

  it('polls using the discovered device ID', async () => {
    mockGetDeviceId.mockResolvedValue('mymeter001');
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

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
  // Startup guard
  // ---------------------------------------------------------------------------

  it('ignores a second configurationChanged that arrives during startup', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    // Fire configurationChanged twice before setup has finished
    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();
    jest.advanceTimersByTime(3000);
    await flush();

    // Device must be created exactly once despite two events
    expect(mockCreateDevice).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Configuration handling
  // ---------------------------------------------------------------------------

  it('creates the energy meter device when credentials are provided', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

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

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setCurrentPowerConsumed).toHaveBeenCalledWith('1337');
  });

  // ---------------------------------------------------------------------------
  // Exported-energy-today calculation
  // ---------------------------------------------------------------------------

  it('calculates exported energy today in Wh from kWh delta between polls', async () => {
    // Poll 1 – establishes daily baseline
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100.0, A_Minus: 10.0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    // Poll 2 – +0.25 kWh exported (use binary fraction to avoid float drift)
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100.5, A_Minus: 10.25 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockMeter.setExportedEnergyToday).toHaveBeenLastCalledWith('250');   // 0.25 × 1000
  });

  it('clamps exported energy today to 0 when A_Minus drops (e.g. after meter reset)', async () => {
    // Poll 1 – baseline with non-zero export value
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 500.0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    // Poll 2 – A_Minus lower than baseline
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 1.0 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockMeter.setExportedEnergyToday).toHaveBeenLastCalledWith('0');
  });

  it('resets the daily baseline at midnight (day change)', async () => {
    const getDate = jest.spyOn(Date.prototype, 'getDate');
    getDate.mockReturnValue(15);

    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100.0, A_Minus: 50.0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    // Simulate day change
    getDate.mockReturnValue(16);

    // New baseline = current reading → today = 0 Wh exported
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 102.0, A_Minus: 50.0 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockMeter.setExportedEnergyToday).toHaveBeenLastCalledWith('0');

    getDate.mockRestore();
  });

  it('uses 0 for export when A_Minus is absent', async () => {
    // Poll 1 – no A_Minus field
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    // Poll 2 – still no A_Minus
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 101 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockMeter.setExportedEnergyToday).toHaveBeenLastCalledWith('0');
  });

  // ---------------------------------------------------------------------------
  // Polling interval
  // ---------------------------------------------------------------------------

  it('uses 30 s as default when pollIntervalSeconds is not set', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw' }); // no interval

    const callsAfterFirstPoll = mockGetCurrentData.mock.calls.length;

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockGetCurrentData.mock.calls.length).toBe(callsAfterFirstPoll + 1);
  });

  it('does not call meter methods when the API returns an error', async () => {
    mockGetCurrentData.mockRejectedValue(new Error('Network error'));

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setCurrentPowerConsumed).not.toHaveBeenCalled();
  });

  it('continues updating remaining datapoints when one setter rejects (transient error)', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 500, Timestamp: 0, A_Plus: 100, A_Minus: 10 });
    mockMeter.setCurrentPowerConsumed.mockRejectedValue(new Error('Request error: Forbidden'));

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setCurrentPowerConsumed).toHaveBeenCalledWith('500');
    expect(mockMeter.setExportedEnergyToday).toHaveBeenCalledWith('0');
  });
});
