import { FreeAtHome, PairingIds, AddOn, Utilities } from '@busch-jaeger/free-at-home';
import { DimActuatorChannel } from '@busch-jaeger/free-at-home/lib/virtualChannels/dimActuatorChannel';
import { RGBChannel } from '@busch-jaeger/free-at-home/lib/virtualChannels/rgbChannel';

const freeAtHome = new FreeAtHome();
freeAtHome.activateSignalHandling();

const metaData = AddOn.readMetaData();
const addOn = new AddOn.AddOn(metaData.id);

// ── State ─────────────────────────────────────────────────────────────────────

// Internal accumulator – unbounded, can exceed 100
let internalSum = 0;

// 4 configurable colors (hue 0–360°) and 3 thresholds (unbounded)
let colors: [number, number, number, number] = [120, 60, 30, 0];
let thresholds: [number, number, number] = [25, 50, 75];

// Serialises all updateLamp() calls so they never run concurrently
let updateChain: Promise<void> = Promise.resolve();

// The virtual RGB device – created once in main(), then controlled via setHSV
let statusLamp: RGBChannel;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the hue for the current internalSum based on configured zones. */
function sumToHueDegrees(sum: number): number {
    if (sum < thresholds[0]) return colors[0];
    if (sum < thresholds[1]) return colors[1];
    if (sum < thresholds[2]) return colors[2];
    return colors[3];
}

async function updateLamp(): Promise<void> {
    if (internalSum <= 0) {
        statusLamp.setOn(false);
        console.log(`[StatusLamp] Lamp OFF (sum=${internalSum})`);
        return;
    }

    const hueDeg = sumToHueDegrees(internalSum);
    // RGBChannel.setHSV expects normalized 0–1 values
    statusLamp.setHSV(hueDeg / 360, 1, 1);
    statusLamp.setColorMode('hsv');
    statusLamp.setOn(true);

    console.log(`[StatusLamp] sum=${internalSum} → Hue=${hueDeg}°`);
}

function scheduleUpdate(): void {
    updateChain = updateChain
        .then(() => updateLamp())
        .catch(err => console.error('[StatusLamp] updateLamp error:', err));
}

/** Add delta to sum, reset actuator display to 0. */
function handleAdd(delta: number, actor: DimActuatorChannel): void {
    if (delta <= 0) return;
    internalSum += delta;
    console.log(`[StatusLamp] +${delta} → sum=${internalSum}`);
    actor.setValue(0);
    scheduleUpdate();
}

/** Subtract delta from sum (floor at 0), reset actuator display to 0. */
function handleSubtract(delta: number, actor: DimActuatorChannel): void {
    if (delta <= 0) return;
    internalSum = Math.max(0, internalSum - delta);
    console.log(`[StatusLamp] -${delta} → sum=${internalSum}`);
    actor.setValue(0);
    scheduleUpdate();
}

/** Reset sum to 0 when an actuator is switched off. */
function handleReset(): void {
    internalSum = 0;
    console.log('[StatusLamp] Sum reset to 0');
    scheduleUpdate();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // Virtual RGB device – link this to the real lamp in the free@home app
    statusLamp = await freeAtHome.createRGBDevice('statuslamp-rgb', 'Status Lampe');
    statusLamp.setAutoKeepAlive(true);
    statusLamp.isAutoConfirm = true;

    // Addier-Aktor
    const dimAdd = await freeAtHome.createDimActuatorDevice('statuslamp-add', 'Status Addieren');
    dimAdd.setAutoKeepAlive(true);
    dimAdd.isAutoConfirm = true;

    dimAdd.on('isOnChanged', (isOn: boolean) => { if (!isOn) handleReset(); });
    dimAdd.on('absoluteValueChanged', (value: number) => { handleAdd(value, dimAdd); });

    // Subtrahier-Aktor
    const dimSub = await freeAtHome.createDimActuatorDevice('statuslamp-sub', 'Status Subtrahieren');
    dimSub.setAutoKeepAlive(true);
    dimSub.isAutoConfirm = true;

    dimSub.on('isOnChanged', (isOn: boolean) => { if (!isOn) handleReset(); });
    dimSub.on('absoluteValueChanged', (value: number) => { handleSubtract(value, dimSub); });

    console.log('[StatusLamp] Addon started');
}

main().catch(err => console.error('[StatusLamp] Startup error:', err));

// ── Configuration ─────────────────────────────────────────────────────────────

function parseColor(value: unknown, fallback: number): number {
    const n = Number(value);
    return isFinite(n) ? Math.max(0, Math.min(360, n)) : fallback;
}

function parseThreshold(value: unknown, fallback: number): number {
    const n = Number(value);
    return isFinite(n) ? Math.max(0, n) : fallback;
}

addOn.on('configurationChanged', (configuration: AddOn.Configuration) => {
    const items = configuration['default']?.items ?? {};

    colors = [
        parseColor(items['color1Hue'], 120),
        parseColor(items['color2Hue'],  60),
        parseColor(items['color3Hue'],  30),
        parseColor(items['color4Hue'],   0),
    ];

    thresholds = [
        parseThreshold(items['threshold1'],  25),
        parseThreshold(items['threshold2'],  50),
        parseThreshold(items['threshold3'],  75),
    ];

    console.log(`[StatusLamp] Config: colors=${colors} thresholds=${thresholds}`);
    scheduleUpdate();
});

addOn.connectToConfiguration();
