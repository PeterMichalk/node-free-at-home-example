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
    setImportedEnergyToday: jest.Mock;
    setExportedEnergyToday: jest.Mock;
    setAutoKeepAlive: jest.Mock;
  };
  let mockCreateDevice: jest.Mock;
  let mockGetCurrentData: jest.Mock;
  let mockGetReport: jest.Mock;
  let mockGetDeviceId: jest.Mock;
  let triggerConfigChanged: (config: Partial<{ email: string; password: string; pollIntervalSeconds: number; prosumerMode: boolean }>) => void;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.resetModules();

    mockMeter = {
      setCurrentPowerConsumed: jest.fn().mockResolvedValue(undefined),
      setCurrentExcessPower: jest.fn().mockResolvedValue(undefined),
      setImportedEnergyToday: jest.fn().mockResolvedValue(undefined),
      setExportedEnergyToday: jest.fn().mockResolvedValue(undefined),
      setAutoKeepAlive: jest.fn(),
    };
    mockCreateDevice = jest.fn().mockResolvedValue(mockMeter);
    mockGetCurrentData = jest.fn();
    mockGetReport = jest.fn().mockResolvedValue([]);
    mockGetDeviceId = jest.fn().mockResolvedValue('abc123def456');

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
          }),
          connectToConfiguration: jest.fn(),
        })),
      },
    }));

    jest.doMock('../powerfoxClient', () => ({
      PowerfoxClient: jest.fn(() => ({
        getDeviceId: mockGetDeviceId,
        getCurrentData: mockGetCurrentData,
        getReport: mockGetReport,
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
    expect(mockGetReport).toHaveBeenCalledWith('mymeter001', expect.any(Date));
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
  // Energy today from Report API
  // ---------------------------------------------------------------------------

  it('sums hourly report entries to calculate imported energy today in Wh', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });
    mockGetReport.mockResolvedValue([
      { Timestamp: 0, A_Plus: 0.5, A_Minus: 0 },
      { Timestamp: 1, A_Plus: 0.3, A_Minus: 0 },
      { Timestamp: 2, A_Plus: 0.2, A_Minus: 0 },
    ]);

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    // (0.5 + 0.3 + 0.2) × 1000 = 1000 Wh
    expect(mockMeter.setImportedEnergyToday).toHaveBeenCalledWith('1000');
  });

  it('sums hourly report entries to calculate exported energy today in Wh', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });
    mockGetReport.mockResolvedValue([
      { Timestamp: 0, A_Plus: 0, A_Minus: 10.0 },
      { Timestamp: 1, A_Plus: 0, A_Minus: 25.5 },
      { Timestamp: 2, A_Plus: 0, A_Minus: 43.89 },
    ]);

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    // (10.0 + 25.5 + 43.89) × 1000 = 79390 Wh
    expect(mockMeter.setExportedEnergyToday).toHaveBeenCalledWith('79390');
  });

  it('treats missing A_Minus in report entry as 0', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0 });
    mockGetReport.mockResolvedValue([
      { Timestamp: 0, A_Plus: 1.0 },
      { Timestamp: 1, A_Plus: 0.5 },
    ]);

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setExportedEnergyToday).toHaveBeenCalledWith('0');
    expect(mockMeter.setImportedEnergyToday).toHaveBeenCalledWith('1500');
  });

  it('reports 0 Wh when report is empty', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 100, Timestamp: 0, A_Plus: 0, A_Minus: 0 });
    mockGetReport.mockResolvedValue([]);

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setImportedEnergyToday).toHaveBeenCalledWith('0');
    expect(mockMeter.setExportedEnergyToday).toHaveBeenCalledWith('0');
  });

  it('still sets Watt when report API fails', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 500, Timestamp: 0, A_Plus: 0, A_Minus: 0 });
    mockGetReport.mockRejectedValue(new Error('Network error'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    // Poll fails entirely (Promise.all rejects) – no meter updates
    expect(mockMeter.setCurrentPowerConsumed).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('fetches report for today on each poll', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 0, A_Minus: 0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });
    jest.advanceTimersByTime(30_000);
    await flush();

    expect(mockGetReport).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('does not call meter methods when the API returns an error', async () => {
    mockGetCurrentData.mockRejectedValue(new Error('Network error'));

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setCurrentPowerConsumed).not.toHaveBeenCalled();
  });

  it('continues updating remaining datapoints when one setter rejects (transient error)', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 500, Timestamp: 0, A_Plus: 100, A_Minus: 10 });
    mockGetReport.mockResolvedValue([{ Timestamp: 0, A_Plus: 0.1, A_Minus: 0 }]);
    mockMeter.setCurrentPowerConsumed.mockRejectedValue(new Error('Request error: Forbidden'));

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setCurrentPowerConsumed).toHaveBeenCalledWith('500');
    expect(mockMeter.setExportedEnergyToday).toHaveBeenCalledWith('0');
  });

  it('continues updating when setImportedEnergyToday rejects (e.g. 403 on older firmware)', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 100, Timestamp: 0, A_Plus: 200, A_Minus: 10 });
    mockGetReport.mockResolvedValue([{ Timestamp: 0, A_Plus: 0.2, A_Minus: 0.05 }]);
    mockMeter.setImportedEnergyToday.mockRejectedValue(new Error('Request error: Forbidden'));

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setImportedEnergyToday).toHaveBeenCalled();
    expect(mockMeter.setExportedEnergyToday).toHaveBeenCalled();
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
});
