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
    setCurrentExcessPower: jest.Mock;
    setExportedEnergyToday: jest.Mock;
    setAutoKeepAlive: jest.Mock;
  };
  let mockCreateDevice: jest.Mock;
  let mockGetCurrentData: jest.Mock;
  let mockGetDeviceId: jest.Mock;
  let mockSetApplicationState: jest.Mock;
  let triggerConfigChanged: (config: Partial<{ email: string; password: string; pollIntervalSeconds: number; prosumerMode: boolean }>) => void;
  let triggerAppStateChanged: (state: any) => void;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.resetModules();

    mockMeter = {
      setCurrentPowerConsumed: jest.fn().mockResolvedValue(undefined),
      setCurrentExcessPower: jest.fn().mockResolvedValue(undefined),
      setExportedEnergyToday: jest.fn().mockResolvedValue(undefined),
      setAutoKeepAlive: jest.fn(),
    };
    mockCreateDevice = jest.fn().mockResolvedValue(mockMeter);
    mockGetCurrentData = jest.fn();
    mockGetDeviceId = jest.fn().mockResolvedValue('abc123def456');
    mockSetApplicationState = jest.fn().mockResolvedValue(undefined);

    jest.doMock('@busch-jaeger/free-at-home', () => ({
      FreeAtHome: jest.fn(() => ({
        activateSignalHandling: jest.fn(),
        createEnergyTwoWayMeterV2Device: mockCreateDevice,
      })),
      AddOn: {
        readMetaData: jest.fn(() => ({ id: 'test-addon' })),
        AddOn: jest.fn(() => ({
          on: jest.fn((event: string, listener: (data: any) => void) => {
            if (event === 'configurationChanged') {
              triggerConfigChanged = (items) =>
                listener({ default: { items } });
            }
            if (event === 'applicationStateChanged') {
              triggerAppStateChanged = (state) => listener(state);
            }
          }),
          connectToConfiguration: jest.fn(),
          connectToApplicationState: jest.fn(),
          setApplicationState: mockSetApplicationState,
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
  async function start(config: Partial<{ email: string; password: string; pollIntervalSeconds: number; prosumerMode: boolean }>) {
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
  // Keepalive
  // ---------------------------------------------------------------------------

  it('enables auto-keepalive on the meter channel after creation', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setAutoKeepAlive).toHaveBeenCalledWith(true);
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

  it('keeps existing polling running when getDeviceId fails on reconfiguration', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 42, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    // First startup succeeds
    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    const callsAfterStart = mockGetCurrentData.mock.calls.length;

    // Reconfiguration with broken API – getDeviceId fails
    mockGetDeviceId.mockRejectedValueOnce(new Error('HTTP 403'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    triggerConfigChanged({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    await flush();
    consoleSpy.mockRestore();

    // Old interval timer must still be running
    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockGetCurrentData.mock.calls.length).toBeGreaterThan(callsAfterStart);
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
  // Meter data mapping – default mode
  // ---------------------------------------------------------------------------

  it('passes current power (Watt) signed to the meter in default mode', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 1337, Timestamp: 0, A_Plus: 50, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setCurrentPowerConsumed).toHaveBeenCalledWith('1337');
    expect(mockMeter.setCurrentExcessPower).not.toHaveBeenCalled();
  });

  it('passes negative Watt unchanged in default mode', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: -200, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setCurrentPowerConsumed).toHaveBeenCalledWith('-200');
    expect(mockMeter.setCurrentExcessPower).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Prosumer mode
  // ---------------------------------------------------------------------------

  it('in prosumer mode splits negative Watt into consumed=0 and excess=|Watt|', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: -200, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30, prosumerMode: true });

    expect(mockMeter.setCurrentPowerConsumed).toHaveBeenCalledWith('0');
    expect(mockMeter.setCurrentExcessPower).toHaveBeenCalledWith('200');
  });

  it('in prosumer mode uses positive Watt for consumed and excess=0', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 150, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30, prosumerMode: true });

    expect(mockMeter.setCurrentPowerConsumed).toHaveBeenCalledWith('150');
    expect(mockMeter.setCurrentExcessPower).toHaveBeenCalledWith('0');
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

  it('uses 0 for export when A_Minus is absent', async () => {
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 101 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockMeter.setExportedEnergyToday).toHaveBeenLastCalledWith('0');
  });

  // ---------------------------------------------------------------------------
  // Baseline persistence
  // ---------------------------------------------------------------------------

  it('saves baseline to application state when initialising on a new day', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 100, A_Minus: 10 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockSetApplicationState).toHaveBeenCalledWith(
      expect.objectContaining({
        default: expect.objectContaining({
          items: expect.objectContaining({
            baseline: expect.objectContaining({ exportKwh: 10, importKwh: 100 }),
          }),
        }),
      })
    );
  });

  it('saves updated baseline to application state at midnight', async () => {
    const getDate = jest.spyOn(Date.prototype, 'getDate').mockReturnValue(15);
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100, A_Minus: 10 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    getDate.mockReturnValue(16);
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 102, A_Minus: 10.5 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockSetApplicationState).toHaveBeenLastCalledWith({
      default: { items: { baseline: { exportKwh: 10.5, importKwh: 102, day: 16 } } },
    });

    getDate.mockRestore();
  });

  it('restores baseline from saved application state for the current day', async () => {
    const getDate = jest.spyOn(Date.prototype, 'getDate').mockReturnValue(15);

    // Application state fires before config (simulates addon startup sequence)
    triggerAppStateChanged({ default: { items: { baseline: { exportKwh: 50.0, importKwh: 200.0, day: 15 } } } });

    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 210, A_Minus: 50.25 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    // exportedTodayWh = (50.25 - 50.0) * 1000 = 250 Wh
    expect(mockMeter.setExportedEnergyToday).toHaveBeenLastCalledWith('250');

    getDate.mockRestore();
  });

  it('ignores saved baseline from a previous day', async () => {
    const getDate = jest.spyOn(Date.prototype, 'getDate').mockReturnValue(16);

    // Saved baseline is from day 15 – should be ignored
    triggerAppStateChanged({ default: { items: { baseline: { exportKwh: 50.0, importKwh: 200.0, day: 15 } } } });

    // Current reading becomes the new baseline
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 210, A_Minus: 55.0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    // exportedTodayWh = (55.0 - 55.0) * 1000 = 0 (current reading IS the baseline)
    expect(mockMeter.setExportedEnergyToday).toHaveBeenLastCalledWith('0');

    getDate.mockRestore();
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

  // ---------------------------------------------------------------------------
  // Daily baseline reset
  // ---------------------------------------------------------------------------

  it('resets the daily baseline at midnight (day change)', async () => {
    const getDate = jest.spyOn(Date.prototype, 'getDate');
    getDate.mockReturnValue(15);

    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 100.0, A_Minus: 50.0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    getDate.mockReturnValue(16);

    // New baseline = current reading → today = 0 Wh exported
    mockGetCurrentData.mockResolvedValueOnce({ Watt: 0, Timestamp: 0, A_Plus: 102.0, A_Minus: 50.0 });

    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockMeter.setExportedEnergyToday).toHaveBeenLastCalledWith('0');

    getDate.mockRestore();
  });
});
