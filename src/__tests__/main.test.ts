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
  let mockGetDeviceId: jest.Mock;
  let triggerConfigChanged: (config: Partial<{ email: string; password: string; pollIntervalSeconds: number; prosumerMode: boolean }>) => void;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.resetModules();

    mockMeter = {
      setCurrentPowerConsumed: jest.fn().mockResolvedValue(undefined),
      setCurrentExcessPower: jest.fn().mockResolvedValue(undefined),
      setTotalEnergyImported: jest.fn().mockResolvedValue(undefined),
      setTotalEnergyExported: jest.fn().mockResolvedValue(undefined),
      setAutoKeepAlive: jest.fn(),
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
  // Total energy (cumulative meter readings → pairing 1224/1225)
  // ---------------------------------------------------------------------------

  it('passes A_Plus directly to setTotalEnergyImported in kWh', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 19414.53, A_Minus: 12364.07 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setTotalEnergyImported).toHaveBeenCalledWith('19414.53');
  });

  it('passes A_Minus directly to setTotalEnergyExported in kWh', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 0, Timestamp: 0, A_Plus: 19414.53, A_Minus: 12364.07 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setTotalEnergyExported).toHaveBeenCalledWith('12364.07');
  });

  it('uses 0 for setTotalEnergyExported when A_Minus is absent (one-way meter)', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 100, Timestamp: 0, A_Plus: 500.0 });

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setTotalEnergyExported).toHaveBeenCalledWith('0');
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
    mockMeter.setCurrentPowerConsumed.mockRejectedValue(new Error('Request error: Forbidden'));

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setCurrentPowerConsumed).toHaveBeenCalledWith('500');
    expect(mockMeter.setTotalEnergyExported).toHaveBeenCalledWith('10');
  });

  it('continues updating when setTotalEnergyImported rejects (e.g. 403 on older firmware)', async () => {
    mockGetCurrentData.mockResolvedValue({ Watt: 100, Timestamp: 0, A_Plus: 200, A_Minus: 10 });
    mockMeter.setTotalEnergyImported.mockRejectedValue(new Error('Request error: Forbidden'));

    await start({ email: 'u@x.de', password: 'pw', pollIntervalSeconds: 30 });

    expect(mockMeter.setTotalEnergyImported).toHaveBeenCalled();
    expect(mockMeter.setTotalEnergyExported).toHaveBeenCalled();
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
