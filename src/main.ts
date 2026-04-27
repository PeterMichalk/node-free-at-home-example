import { FreeAtHome } from '@busch-jaeger/free-at-home';

const freeAtHome = new FreeAtHome();
freeAtHome.activateSignalHandling();

async function main() {
  const virtualSwitch = await freeAtHome.createSwitchingActuatorDevice("123switch", "Virtual Switch");
  virtualSwitch.setAutoKeepAlive(true);
  virtualSwitch.isAutoConfirm = true;
  virtualSwitch.on('isOnChanged', (value: boolean) => {
    console.log("switch state is:", (value) ? "on" : "off");
  });

  const virtualDimming = await freeAtHome.createDimActuatorDevice("123Dim", "Virtual Dimming");
  virtualDimming.setAutoKeepAlive(true);
  virtualDimming.isAutoConfirm = true;
  virtualDimming.on('isOnChanged', (value: boolean) => {
    console.log("dimming state is:", (value) ? "on" : "off");
  });
  virtualDimming.on("absoluteValueChanged", (value: number) => {
    console.log("dimming value is:", value);
  });

  // TV via MediaPlayer: supports inputs (HDMI), volume, mute, channels (playlists)
  const virtualTV = await freeAtHome.createMediaPlayerDevice("tv001", "Virtual TV");
  virtualTV.setAutoKeepAlive(true);
  virtualTV.isAutoConfirm = true;

  await virtualTV.setInputs(["HDMI 1", "HDMI 2", "AV", "TV"]);
  await virtualTV.setInputIndex(0);
  await virtualTV.setPlaylists(["ARD", "ZDF", "RTL", "SAT.1", "ProSieben"]);
  await virtualTV.setAllowedActions({ canSkip: true, canSkipBack: true, canPause: true });

  virtualTV.on('play', () => console.log("TV: on"));
  virtualTV.on('pause', () => console.log("TV: standby"));
  virtualTV.on('mute', () => console.log("TV: muted"));
  virtualTV.on('unMute', () => console.log("TV: unmuted"));
  virtualTV.on('volume', (value: number) => console.log("TV volume:", value));
  virtualTV.on('input', (value: number) => console.log("TV input changed to index:", value));
  virtualTV.on('playlist', (value: number) => console.log("TV channel changed to index:", value));
}

main();

// Get notified about changes in the configuration of the add on
//#################################################################################

import {AddOn} from '@busch-jaeger/free-at-home';

const metaData = AddOn.readMetaData();

const addOn = new AddOn.AddOn(metaData.id);

addOn.on("configurationChanged", (configuration: AddOn.Configuration) => {
  console.log(configuration);
});

addOn.connectToConfiguration();
