import { FreeAtHome, PairingIds, AddOn, Utilities } from '@busch-jaeger/free-at-home';
import { DimActuatorChannel } from '@busch-jaeger/free-at-home/lib/virtualChannels/dimActuatorChannel';

const freeAtHome = new FreeAtHome();
freeAtHome.activateSignalHandling();

const metaData = AddOn.readMetaData();
const addOn = new AddOn.AddOn(metaData.id);

// ── State ─────────────────────────────────────────────────────────────────────

// Parsed from config: "<serialNumber>/ch<hexNumber>"
let lampSerial: string | undefined;
let lampChannelNumber: number | undefined;

// Internal accumulator – unbounded, can exceed 100
let internalSum = 0;

// 4 configurable colors (hue 0–360°) and 3 thresholds (unbounded)
let colors: [number, number, number, number] = [120, 60, 30, 0];
let thresholds: [number, number, number] = [25, 50, 75];

// Serialises all updateLamp() calls so they never run concurrently
let updateChain: Promise<void> = Promise.resolve();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the hue for the current internalSum based on configured zones. */
function sumToHueDegrees(sum: number): number {
    if (sum < thresholds[0]) return colors[0];
    if (sum < thresholds[1]) return colors[1];
    if (sum < thresholds[2]) return colors[2];
    return colors[3];
}

/** Sends a single input datapoint directly to the real lamp via the low-level API. */
async function sendDatapoint(pairingId: PairingIds, value: string): Promise<void> {
    if (lampSerial === undefined || lampChannelNumber === undefined) return;
    await freeAtHome.freeAtHomeApi.setInputDatapoint(lampSerial, lampChannelNumber, pairingId, value);
}

async function updateLamp(): Promise<void> {
    if (lampSerial === undefined || lampChannelNumber === undefined) {
        console.warn('[StatusLamp] No target lamp configured yet');
        return;
    }

    if (internalSum <= 0) {
        await sendDatapoint(PairingIds.AL_SWITCH_ON_OFF, '0');
        console.log(`[StatusLamp] Lamp OFF (sum=${internalSum})`);
        return;
    }

    const hueDeg  = sumToHueDegrees(internalSum);
    const encoded = Utilities.hsvTouint32(hueDeg / 360, 1, 1).toString();

    await sendDatapoint(PairingIds.AL_SWITCH_ON_OFF, '1');
    await sendDatapoint(PairingIds.AL_HSV, encoded);

    console.log(`[StatusLamp] sum=${internalSum} → Hue=${hueDeg}° encoded=${encoded}`);
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
    const dimAdd = await freeAtHome.createDimActuatorDevice('statuslamp-add', 'Status Addieren');
    dimAdd.setAutoKeepAlive(true);
    dimAdd.isAutoConfirm = true;

    dimAdd.on('isOnChanged', (isOn: boolean) => { if (!isOn) handleReset(); });
    dimAdd.on('absoluteValueChanged', (value: number) => { handleAdd(value, dimAdd); });

    const dimSub = await freeAtHome.createDimActuatorDevice('statuslamp-sub', 'Status Subtrahieren');
    dimSub.setAutoKeepAlive(true);
    dimSub.isAutoConfirm = true;

    dimSub.on('isOnChanged', (isOn: boolean) => { if (!isOn) handleReset(); });
    dimSub.on('absoluteValueChanged', (value: number) => { handleSubtract(value, dimSub); });

    console.log('[StatusLamp] Addon started – waiting for configuration');
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

/** Parses "<serialNumber>/ch<hexNumber>" into serial + channel number. */
function parseLampRef(ref: string): { serial: string; channelNumber: number } | undefined {
    const parts = ref.split('/');
    if (parts.length !== 2 || !parts[1].startsWith('ch')) {
        console.error(`[StatusLamp] Invalid channel reference: "${ref}"`);
        return undefined;
    }
    const channelNumber = parseInt(parts[1].substring(2), 16);
    if (isNaN(channelNumber)) {
        console.error(`[StatusLamp] Cannot parse channel number from: "${ref}"`);
        return undefined;
    }
    return { serial: parts[0], channelNumber };
}

addOn.on('configurationChanged', (configuration: AddOn.Configuration) => {
    const items = configuration['default']?.items ?? {};

    const newRef = typeof items['targetLamp'] === 'string' ? items['targetLamp'] : undefined;
    if (newRef) {
        const parsed = parseLampRef(newRef);
        if (parsed) {
            lampSerial        = parsed.serial;
            lampChannelNumber = parsed.channelNumber;
            console.log(`[StatusLamp] Target lamp → serial=${lampSerial} channel=${lampChannelNumber}`);
        }
    }

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
