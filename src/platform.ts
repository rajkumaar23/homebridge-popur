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
import { PopurX5Accessory } from './platformAccessory';

interface PopurPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  pollInterval?: number;
}

export class PopurX5Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  public readonly popur: PopurApi | null = null;
  public readonly pollInterval: number;

  constructor(
    public readonly log: Logging,
    public readonly config: PopurPlatformConfig,
    public readonly api: API,
  ) {
    this.pollInterval = Math.max(15, config.pollInterval ?? 60) * 1000;

    if (!config.email || !config.password) {
      this.log.error('Popur X5: "email" and "password" are required in the plugin config. Plugin disabled.');
    } else {
      this.popur = new PopurApi(config.email, config.password, this.log);
    }

    this.api.on('didFinishLaunching', () => {
      if (this.popur) {
        this.discoverDevices();
      }
    });
  }

  /** Restore accessories from the Homebridge cache on startup. */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    const popur = this.popur!;
    if (!(await popur.login())) {
      this.log.error('Popur X5: login failed; check your email/password. Plugin disabled.');
      return;
    }

    const devices = await popur.getDevices();
    if (devices.length === 0) {
      this.log.warn('Popur X5: no devices found on this account.');
    }

    const activeUuids = new Set<string>();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.id);
      activeUuids.add(uuid);

      const existing = this.accessories.find((a) => a.UUID === uuid);
      if (existing) {
        this.log.info(`Restoring Popur device: ${device.name}`);
        existing.context.device = device;
        new PopurX5Accessory(this, existing, device);
      } else {
        this.log.info(`Adding new Popur device: ${device.name}`);
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        new PopurX5Accessory(this, accessory, device);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Remove cached accessories that no longer exist on the account.
    const stale = this.accessories.filter((a) => !activeUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale Popur accessory(ies).`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
