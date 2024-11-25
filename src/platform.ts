import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { PopurTrashBoxFullnessAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { PopurAPI } from './popur.js';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class Popur implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];
  public readonly popurAPI: PopurAPI = new PopurAPI(this);

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    this.popurAPI.login(this.config.username, this.config.password).then(async () => {
      const devices = await this.popurAPI.fetchDevices();
      for (const device of devices) {
        const uuid = this.api.hap.uuid.generate(device.DeviceID);
        const existingAccessory = this.accessories.get(uuid);

        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          new PopurTrashBoxFullnessAccessory(this, existingAccessory);
        } else {
          this.log.info('Adding new accessory:', device.Name);
          const accessory = new this.api.platformAccessory(device.Name, uuid);
          accessory.context.device = device;
          new PopurTrashBoxFullnessAccessory(this, accessory);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }

        this.discoveredCacheUUIDs.push(uuid);
      }

      for (const [uuid, accessory] of this.accessories) {
        if (!this.discoveredCacheUUIDs.includes(uuid)) {
          this.log.info('Removing existing accessory from cache:', accessory.displayName);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    });
  }
}
