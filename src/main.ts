import { FreeAtHome, AddOn } from '@busch-jaeger/free-at-home';
import { EnergyTwoWayMeterV2Channel } from '@busch-jaeger/free-at-home/lib/virtualChannels/energyTwoWayMeterV2Channel';
import { PowerfoxClient } from './powerfoxClient';

const freeAtHome = new FreeAtHome();
freeAtHome.activateSignalHandling();

const metaData = AddOn.readMetaData();
const addOn = new AddOn.AddOn(metaData.id);

let pollTimer: ReturnType<typeof setInterval> | undefined;
let meter: EnergyTwoWayMeterV2Channel | undefined;

// Daily baseline values to calculate "today" energy
let dailyBaseline: { importKwh: number; exportKwh: number; day: number } | undefined;

async function poll(client: PowerfoxClient): Promise<void> {
  try {
    const data = await client.getCurrentData();

    const today = new Date().getDate();
    if (!dailyBaseline || dailyBaseline.day !== today) {
      dailyBaseline = {
        importKwh: data.A_Plus,
        exportKwh: data.A_Minus ?? 0,
        day: today,
      };
    }

    if (!meter) return;

    await meter.setCurrentPowerConsumed(String(data.Watt));
    await meter.setTotalEnergyImported(String(data.A_Plus));
    await meter.setTotalEnergyExported(String(data.A_Minus ?? 0));

    // Convert kWh delta to Wh for today's values
    const importedTodayWh = (data.A_Plus - dailyBaseline.importKwh) * 1000;
    const exportedTodayWh = ((data.A_Minus ?? 0) - dailyBaseline.exportKwh) * 1000;

    await meter.setImportedEnergyToday(String(Math.max(0, importedTodayWh)));
    await meter.setExportedEnergyToday(String(Math.max(0, exportedTodayWh)));

    console.log(
      `Powerfox | Leistung: ${data.Watt} W | Bezug gesamt: ${data.A_Plus} kWh | Einspeisung gesamt: ${data.A_Minus ?? 0} kWh`
    );
  } catch (error) {
    console.error('Fehler beim Abruf der powerfox API:', error);
  }
}

async function startPolling(email: string, password: string, intervalSeconds: number): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  if (!meter) {
    meter = await freeAtHome.createEnergyTwoWayMeterV2Device('powerfox-main', 'Powerfox Stromzähler');
  }

  const client = new PowerfoxClient(email, password);

  await poll(client);
  pollTimer = setInterval(() => poll(client), intervalSeconds * 1000);

  console.log(`Powerfox Polling gestartet (Intervall: ${intervalSeconds}s)`);
}

addOn.on('configurationChanged', (configuration: AddOn.Configuration) => {
  const items = configuration['default']?.items;
  if (!items) return;

  const email = items['email'] as string | undefined;
  const password = items['password'] as string | undefined;
  const pollIntervalSeconds = Number(items['pollIntervalSeconds']) || 30;

  if (email && password) {
    startPolling(email, password, pollIntervalSeconds).catch((error) => {
      console.error('Fehler beim Starten des Pollings:', error);
    });
  } else {
    console.log('Powerfox: E-Mail und Passwort noch nicht konfiguriert.');
  }
});

addOn.connectToConfiguration();
