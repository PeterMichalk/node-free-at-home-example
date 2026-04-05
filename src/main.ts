import { FreeAtHome, AddOn } from '@busch-jaeger/free-at-home';
import { DimActuatorChannel } from '@busch-jaeger/free-at-home/lib/virtualChannels/dimActuatorChannel';
import { RGBChannel } from '@busch-jaeger/free-at-home/lib/virtualChannels/rgbChannel';

const freeAtHome = new FreeAtHome();
freeAtHome.activateSignalHandling();

const metaData = AddOn.readMetaData();
const addOn = new AddOn.AddOn(metaData.id);

// Current configuration (updated on configurationChanged)
let numberOfInputs = 3;
let yellowThreshold = 33;  // % of max sum where color starts shifting to yellow
let redThreshold = 66;     // % of max sum where color turns fully red

// Runtime state
const inputValues: number[] = [];
let statusLamp: RGBChannel | undefined;
let inputActors: DimActuatorChannel[] = [];
let initialized = false;

/**
 * Maps a sum ratio (0–1) to an HSV hue:
 *   0.0 → green  (120°)
 *   0.5 → yellow  (60°)
 *   1.0 → red     (0°)
 */
function sumToHue(ratio: number): number {
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    // Hue goes from 120 (green) down to 0 (red)
    return Math.round(120 * (1 - clampedRatio));
}

function updateStatusLamp(): void {
    if (!statusLamp) return;

    const sum = inputValues.reduce((acc, v) => acc + v, 0);
    const maxSum = numberOfInputs * 100;
    const ratio = maxSum > 0 ? sum / maxSum : 0;

    const hue = sumToHue(ratio);
    const saturation = sum > 0 ? 100 : 0;   // grey when all values are 0
    const value = 100;                         // always full brightness

    console.log(`[StatusLamp] Sum=${sum}/${maxSum} (${(ratio * 100).toFixed(1)}%) → HSV(${hue}°, ${saturation}%, ${value}%)`);

    statusLamp.setHSV(hue, saturation, value);
    statusLamp.setColorMode("hsv");
    statusLamp.setOn(sum > 0);
}

async function setupDevices(numInputs: number): Promise<void> {
    // Tear down previous listeners (the SDK doesn't support removing virtual
    // devices, so we just reassign the event handlers on the existing channels)
    inputActors.forEach(actor => actor.removeAllListeners());

    inputActors = [];
    inputValues.length = 0;

    for (let i = 0; i < numInputs; i++) {
        inputValues.push(0);

        const actor = await freeAtHome.createDimActuatorDevice(
            `statuslamp-input-${i}`,
            `Status Input ${i + 1}`
        );
        actor.setAutoKeepAlive(true);
        actor.isAutoConfirm = true;

        const index = i;

        actor.on('isOnChanged', (isOn: boolean) => {
            if (!isOn) {
                inputValues[index] = 0;
                console.log(`[Input ${index + 1}] turned OFF → value reset to 0`);
                updateStatusLamp();
            }
        });

        actor.on('absoluteValueChanged', (value: number) => {
            inputValues[index] = value;
            console.log(`[Input ${index + 1}] value changed to ${value}`);
            updateStatusLamp();
        });

        inputActors.push(actor);
    }

    console.log(`[StatusLamp] Created ${numInputs} input actor(s)`);
}

async function main(): Promise<void> {
    // Create the RGB status lamp
    statusLamp = await freeAtHome.createRGBDevice('statuslamp-rgb', 'Status Lamp');
    statusLamp.setAutoKeepAlive(true);
    statusLamp.isAutoConfirm = true;

    statusLamp.on('isOnChanged', (isOn: boolean) => {
        console.log(`[StatusLamp] on/off changed to: ${isOn ? 'on' : 'off'}`);
    });

    await setupDevices(numberOfInputs);
    initialized = true;

    console.log('[StatusLamp] Addon started successfully');
}

main().catch(err => console.error('[StatusLamp] Startup error:', err));

// Configuration updates
addOn.on('configurationChanged', async (configuration: AddOn.Configuration) => {
    console.log('[StatusLamp] Configuration changed:', configuration);

    const items = configuration['default']?.items ?? {};

    const newNumInputs = typeof items['numberOfInputs'] === 'number'
        ? Math.max(1, Math.min(10, items['numberOfInputs']))
        : numberOfInputs;

    yellowThreshold = typeof items['yellowThreshold'] === 'number'
        ? Math.max(0, Math.min(100, items['yellowThreshold']))
        : yellowThreshold;

    redThreshold = typeof items['redThreshold'] === 'number'
        ? Math.max(0, Math.min(100, items['redThreshold']))
        : redThreshold;

    if (initialized && newNumInputs !== numberOfInputs) {
        numberOfInputs = newNumInputs;
        await setupDevices(numberOfInputs);
    } else {
        numberOfInputs = newNumInputs;
    }

    // Recalculate with new thresholds
    updateStatusLamp();
});

addOn.connectToConfiguration();
