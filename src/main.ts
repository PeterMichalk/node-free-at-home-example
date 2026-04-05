import { FreeAtHome, PairingIds, AddOn, Utilities } from '@busch-jaeger/free-at-home';
import { ApiChannel } from '@busch-jaeger/free-at-home/lib/api/apiChannel';

const freeAtHome = new FreeAtHome();
freeAtHome.activateSignalHandling();

const metaData = AddOn.readMetaData();
const addOn = new AddOn.AddOn(metaData.id);

// Channel reference from config: "<serialNumber>/ch<hexNumber>"
let targetChannelRef: string | undefined;
let lampChannel: ApiChannel | undefined;

/**
 * Maps a 0-100 input value to a hue angle (degrees):
 *   0   → green  (120°)
 *   50  → yellow  (60°)
 *   100 → red      (0°)
 */
function valueToHueDegrees(value: number): number {
    return 120 * (1 - Math.max(0, Math.min(100, value)) / 100);
}

/**
 * Finds the real ApiChannel matching "<serialNumber>/ch<hex>" from config.
 */
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

async function setLampColor(inputValue: number): Promise<void> {
    if (!lampChannel) {
        if (!targetChannelRef) {
            console.warn('[StatusLamp] No target lamp configured yet');
            return;
        }
        lampChannel = await resolveLampChannel(targetChannelRef);
        if (!lampChannel) return;
    }

    if (inputValue <= 0) {
        await lampChannel.setInputDatapoint(PairingIds.AL_SWITCH_ON_OFF, '0');
        console.log('[StatusLamp] Lamp turned OFF');
        return;
    }

    const hueDeg = valueToHueDegrees(inputValue);
    // SDK hsvTouint32 expects normalized values 0–1
    const hueNorm = hueDeg / 360;
    const encoded = Utilities.hsvTouint32(hueNorm, 1, 1).toString();

    await lampChannel.setInputDatapoint(PairingIds.AL_SWITCH_ON_OFF, '1');
    await lampChannel.setInputDatapoint(PairingIds.AL_HSV, encoded);

    console.log(`[StatusLamp] Input=${inputValue} → Hue=${Math.round(hueDeg)}° → HSV encoded=${encoded}`);
}

async function main(): Promise<void> {
    const dimInput = await freeAtHome.createDimActuatorDevice('statuslamp-input', 'Status Input');
    dimInput.setAutoKeepAlive(true);
    dimInput.isAutoConfirm = true;

    dimInput.on('isOnChanged', async (isOn: boolean) => {
        if (!isOn) {
            await setLampColor(0);
        }
    });

    dimInput.on('absoluteValueChanged', async (value: number) => {
        await setLampColor(value);
    });

    console.log('[StatusLamp] Addon started – waiting for configuration');
}

main().catch(err => console.error('[StatusLamp] Startup error:', err));

// Configuration updates
addOn.on('configurationChanged', async (configuration: AddOn.Configuration) => {
    console.log('[StatusLamp] Configuration changed:', configuration);

    const items = configuration['default']?.items ?? {};
    const newRef = typeof items['targetLamp'] === 'string' ? items['targetLamp'] : undefined;

    if (newRef && newRef !== targetChannelRef) {
        targetChannelRef = newRef;
        lampChannel = undefined; // force re-resolve on next setLampColor
        console.log(`[StatusLamp] Target lamp set to: ${targetChannelRef}`);
    }
});

addOn.connectToConfiguration();
