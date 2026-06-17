import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { PopurApi } from './popurApi';
import { PopurDevicePoller } from './devicePoller';
import { PopurAccessory, PopurFeature } from './platformAccessory';

interface PopurPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  pollInterval?: number;
}

/** The separate HomeKit tiles created for each Popur device. */
const FEATURES: { feature: PopurFeature; suffix: string; label: string }[] = [
  { feature: 'clean', suffix: 'clean', label: 'Clean' },
  { feature: 'night', suffix: 'night', label: 'Night Mode' },
  { feature: 'bin', suffix: 'bin', label: 'Waste Bin' },
  { feature: 'cycles', suffix: 'cycles', label: 'Cycles Today' },
];

export class PopurPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  public readonly popur: PopurApi | null = null;
  public readonly pollInterval: number;

  private readonly pollers: PopurDevicePoller[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PopurPlatformConfig,
    public readonly api: API,
  ) {
    this.pollInterval = Math.max(15, config.pollInterval ?? 60) * 1000;

    if (!config.email || !config.password) {
      this.log.error('Popur: "email" and "password" are required in the plugin config. Plugin disabled.');
    } else {
      this.popur = new PopurApi(config.email, config.password, this.log);
    }

    this.api.on('didFinishLaunching', () => {
      if (this.popur) {
        this.discoverDevices();
      }
    });
    this.api.on('shutdown', () => this.pollers.forEach((p) => p.stop()));
  }

  /** Restore accessories from the Homebridge cache on startup. */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    const popur = this.popur!;
    if (!(await popur.login())) {
      this.log.error('Popur: login failed; check your email/password. Plugin disabled.');
      return;
    }

    const devices = await popur.getDevices();
    if (devices.length === 0) {
      this.log.warn('Popur: no devices found on this account.');
    }

    const activeUuids = new Set<string>();

    for (const device of devices) {
      this.log.info(`Setting up Popur device: ${device.name} (${device.model || 'unknown model'})`);
      const poller = new PopurDevicePoller(popur, device, this.pollInterval, this.log);
      this.pollers.push(poller);

      // Each feature becomes its own accessory so they appear as separate tiles.
      for (const { feature, suffix, label } of FEATURES) {
        const uuid = this.api.hap.uuid.generate(`${device.id}:${suffix}`);
        activeUuids.add(uuid);
        const name = `${device.name} ${label}`;

        const existing = this.accessories.find((a) => a.UUID === uuid);
        if (existing) {
          existing.context.device = device;
          new PopurAccessory(this, existing, device, poller, feature);
        } else {
          const accessory = new this.api.platformAccessory(name, uuid);
          accessory.context.device = device;
          new PopurAccessory(this, accessory, device, poller, feature);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    }

    // Remove cached accessories that no longer exist on the account (or from an
    // older layout, e.g. the previous single-accessory-per-device version).
    const stale = this.accessories.filter((a) => !activeUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale Popur accessory(ies).`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
