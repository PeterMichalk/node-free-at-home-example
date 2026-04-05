import { FreeAtHome, PairingIds, AddOn, Utilities } from '@busch-jaeger/free-at-home';
import { ApiChannel } from '@busch-jaeger/free-at-home/lib/api/apiChannel';
import { DimActuatorChannel } from '@busch-jaeger/free-at-home/lib/virtualChannels/dimActuatorChannel';

const freeAtHome = new FreeAtHome();
freeAtHome.activateSignalHandling();

const metaData = AddOn.readMetaData();
const addOn = new AddOn.AddOn(metaData.id);

// ── State ─────────────────────────────────────────────────────────────────────

let targetChannelRef: string | undefined;
let lampChannel: ApiChannel | undefined;

// Internal accumulator – unbounded, can exceed 100
let internalSum = 0;

// 4 configurable colors (hue 0–360°) and 3 thresholds (unbounded)
let colors: [number, number, number, number] = [120, 60, 30, 0];
let thresholds: [number, number, number] = [25, 50, 75];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the hue for the current internalSum based on configured zones. */
function sumToHueDegrees(sum: number): number {
    if (sum <= 0)             return colors[0]; // handled separately (lamp off)
    if (sum < thresholds[0]) return colors[0];
    if (sum < thresholds[1]) return colors[1];
    if (sum < thresholds[2]) return colors[2];
    return colors[3];
}

async function resolveLampChannel(ref: string): Promise<ApiChannel | undefined> {
    const parts = ref.split('/');
    if (parts.length !== 2) {
        console.error(`[StatusLamp] Invalid channel reference: "${ref}"`);
        return undefined;
    }
    const [serial, channelStr] = parts;
    const channelNumber = parseInt(channelStr.substring(2), 16); // "ch0001" → 1

    const allChannels = await freeAtHome.getAllChannels();
    for (const ch of allChannels) {
        if (ch.serialNumber === serial && ch.channelNumber === channelNumber) {
            return ch;
        }
    }
    console.error(`[StatusLamp] Channel not found: ${ref}`);
    return undefined;
}

async function updateLamp(): Promise<void> {
    if (!lampChannel) {
        if (!targetChannelRef) {
            console.warn('[StatusLamp] No target lamp configured yet');
            return;
        }
        lampChannel = await resolveLampChannel(targetChannelRef);
        if (!lampChannel) return;
    }

    if (internalSum <= 0) {
        await lampChannel.setInputDatapoint(PairingIds.AL_SWITCH_ON_OFF, '0');
        console.log(`[StatusLamp] Lamp OFF (sum=${internalSum})`);
        return;
    }

    const hueDeg  = sumToHueDegrees(internalSum);
    const encoded = Utilities.hsvTouint32(hueDeg / 360, 1, 1).toString();

    await lampChannel.setInputDatapoint(PairingIds.AL_SWITCH_ON_OFF, '1');
    await lampChannel.setInputDatapoint(PairingIds.AL_HSV, encoded);

    console.log(`[StatusLamp] sum=${internalSum} → Hue=${hueDeg}° encoded=${encoded}`);
}

/** Add delta to sum, reset actuator display to 0. */
async function handleAdd(delta: number, actor: DimActuatorChannel): Promise<void> {
    if (delta <= 0) return;
    internalSum += delta;
    console.log(`[StatusLamp] +${delta} → sum=${internalSum}`);
    actor.setValue(0);
    await updateLamp();
}

/** Subtract delta from sum (floor at 0), reset actuator display to 0. */
async function handleSubtract(delta: number, actor: DimActuatorChannel): Promise<void> {
    if (delta <= 0) return;
    internalSum = Math.max(0, internalSum - delta);
    console.log(`[StatusLamp] -${delta} → sum=${internalSum}`);
    actor.setValue(0);
    await updateLamp();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const dimAdd = await freeAtHome.createDimActuatorDevice('statuslamp-add', 'Status Addieren');
    dimAdd.setAutoKeepAlive(true);
    dimAdd.isAutoConfirm = true;

    dimAdd.on('absoluteValueChanged', async (value: number) => {
        await handleAdd(value, dimAdd);
    });

    const dimSub = await freeAtHome.createDimActuatorDevice('statuslamp-sub', 'Status Subtrahieren');
    dimSub.setAutoKeepAlive(true);
    dimSub.isAutoConfirm = true;

    dimSub.on('absoluteValueChanged', async (value: number) => {
        await handleSubtract(value, dimSub);
    });

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
    return isFinite(n) ? Math.max(0, n) : fallback; // no upper limit
}

addOn.on('configurationChanged', async (configuration: AddOn.Configuration) => {
    const items = configuration['default']?.items ?? {};

    const newRef = typeof items['targetLamp'] === 'string' ? items['targetLamp'] : undefined;
    if (newRef && newRef !== targetChannelRef) {
        targetChannelRef = newRef;
        lampChannel = undefined;
        console.log(`[StatusLamp] Target lamp → ${targetChannelRef}`);
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
    await updateLamp();
});

addOn.connectToConfiguration();
