import { FreeAtHome, AddOn } from '@busch-jaeger/free-at-home';
import { EnergyTwoWayMeterV2Channel } from '@busch-jaeger/free-at-home/lib/virtualChannels/energyTwoWayMeterV2Channel';
import { PowerfoxClient } from './powerfoxClient';

const VERSION = '1.4.0';

const freeAtHome = new FreeAtHome();
freeAtHome.activateSignalHandling();

const metaData = AddOn.readMetaData();
const addOn = new AddOn.AddOn(metaData.id);

let pollTimer: ReturnType<typeof setInterval> | undefined;
let meter: EnergyTwoWayMeterV2Channel | undefined;
let isStartingUp = false;

type Baseline = { exportKwh: number; importKwh: number; day: number };
let dailyBaseline: Baseline | undefined;

let consecutivePollErrors = 0;

function saveBaseline(b: Baseline): void {
  addOn.setApplicationState({ default: { items: { baseline: b } } })
    .catch(e => console.error(`[powerfox] Baseline speichern fehlgeschlagen: ${e}`));
}

async function poll(client: PowerfoxClient, deviceId: string, prosumerMode: boolean): Promise<void> {
  try {
    const data = await client.getCurrentData(deviceId);

    const today = new Date().getDate();
    if (!dailyBaseline || dailyBaseline.day !== today) {
      dailyBaseline = { exportKwh: data.A_Minus ?? 0, importKwh: data.A_Plus, day: today };
      saveBaseline(dailyBaseline);
    }

    if (!meter) return;

    const exportedTodayWh = ((data.A_Minus ?? 0) - dailyBaseline.exportKwh) * 1000;

    const updates: Array<[string, () => Promise<void>]> = [];
    if (prosumerMode) {
      updates.push(['setCurrentPowerConsumed', () => meter!.setCurrentPowerConsumed(String(Math.max(0, data.Watt)))]);
      updates.push(['setCurrentExcessPower',   () => meter!.setCurrentExcessPower(String(Math.max(0, -data.Watt)))]);
    } else {
      updates.push(['setCurrentPowerConsumed', () => meter!.setCurrentPowerConsumed(String(data.Watt))]);
    }
    updates.push(['setExportedEnergyToday', () => meter!.setExportedEnergyToday(String(Math.max(0, exportedTodayWh)))]);

    let anySetterFailed = false;
    for (const [name, fn] of updates) {
      try {
        await fn();
      } catch (e) {
        anySetterFailed = true;
        console.error(`[powerfox] Datenpunkt ${name} fehlgeschlagen (übersprungen): ${e}`);
      }
    }

    if (anySetterFailed) {
      consecutivePollErrors++;
      if (consecutivePollErrors === 3) {
        console.error(`[powerfox] Datenpunkte schlagen wiederholt fehl – Gerät antwortet möglicherweise nicht mehr (${consecutivePollErrors} Zyklen)`);
      }
    } else {
      if (consecutivePollErrors >= 3) {
        console.log(`[powerfox] Datenpunkte erfolgreich – Gerät wieder erreichbar (nach ${consecutivePollErrors} Fehlerzyklen)`);
      }
      consecutivePollErrors = 0;
    }

    const outdatedNote = data.Outdated ? ' [Outdated]' : '';
    console.log(
      `Powerfox | Leistung: ${data.Watt} W | Bezug gesamt: ${data.A_Plus} kWh | Einspeisung gesamt: ${data.A_Minus ?? 0} kWh${outdatedNote}`
    );
  } catch (error) {
    consecutivePollErrors++;
    const err = error instanceof Error ? error : new Error(String(error));
    const extra = (err as NodeJS.ErrnoException).code ? ` [code=${(err as NodeJS.ErrnoException).code}]` : '';
    console.error(`[powerfox] Poll-Fehler: ${err.message}${extra}`);
    if (consecutivePollErrors === 3) {
      console.error(`[powerfox] Poll schlägt wiederholt fehl – Powerfox API nicht erreichbar? (${consecutivePollErrors} Zyklen)`);
    }
  }
}

async function startPolling(email: string, password: string, intervalSeconds: number, prosumerMode: boolean): Promise<void> {
  if (isStartingUp) return;
  isStartingUp = true;

  try {
    if (!meter) {
      meter = await freeAtHome.createEnergyTwoWayMeterV2Device('powerfox-main', 'Powerfox Stromzähler');
      meter.setAutoKeepAlive(true);
      console.log('[powerfox] Virtuelles Gerät erstellt, Auto-Keepalive aktiviert');
    }

    const client = new PowerfoxClient(email, password);

    let deviceId: string;
    try {
      deviceId = await client.getDeviceId();
      console.log(`Powerfox Gerät gefunden: ${deviceId}`);
    } catch (error) {
      // Keep existing polling timer running – don't clear it on transient getDeviceId failure
      const err = error instanceof Error ? error : new Error(String(error));
      const extra = (err as NodeJS.ErrnoException).code ? ` [code=${(err as NodeJS.ErrnoException).code}]` : '';
      console.error(`[powerfox] Gerät-Erkennung fehlgeschlagen: ${err.message}${extra}`);
      console.error('[powerfox] Bitte E-Mail und Passwort in der Addon-Konfiguration prüfen.');
      return;
    }

    // Only clear the old timer once we know a new one can be started
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    consecutivePollErrors = 0;

    const doPoll = () => poll(client, deviceId, prosumerMode);
    pollTimer = setInterval(doPoll, intervalSeconds * 1000);
    console.log(`Powerfox Polling gestartet (Gerät: ${deviceId}, Intervall: ${intervalSeconds}s, Prosumer: ${prosumerMode})`);
    // Delay first poll so the SysAP has time to register the virtual channel
    setTimeout(doPoll, 3000);
  } finally {
    isStartingUp = false;
  }
}

console.log(`[powerfox] Addon gestartet (v${VERSION})`);

addOn.on('applicationStateChanged', (state: AddOn.Configuration) => {
  const saved = state['default']?.items?.['baseline'] as Baseline | undefined;
  if (saved && typeof saved.day === 'number' && saved.day === new Date().getDate()) {
    dailyBaseline = saved;
    console.log(`[powerfox] Baseline geladen: Tag ${saved.day}, Export ${saved.exportKwh} kWh, Bezug ${saved.importKwh} kWh`);
  }
});

addOn.on('configurationChanged', (configuration: AddOn.Configuration) => {
  const items = configuration['default']?.items;
  if (!items) return;

  const email = items['email'] as string | undefined;
  const password = items['password'] as string | undefined;
  const pollIntervalSeconds = Number(items['pollIntervalSeconds']) || 30;
  const prosumerMode = items['prosumerMode'] === true;

  console.log(`[powerfox] Konfiguration empfangen (Intervall: ${pollIntervalSeconds}s, Prosumer: ${prosumerMode})`);

  if (email && password) {
    startPolling(email, password, pollIntervalSeconds, prosumerMode).catch((error) => {
      console.error('Fehler beim Starten des Pollings:', error);
    });
  } else {
    console.log('[powerfox] E-Mail und/oder Passwort fehlen – Addon nicht gestartet.');
  }
});

addOn.connectToApplicationState();
addOn.connectToConfiguration();
