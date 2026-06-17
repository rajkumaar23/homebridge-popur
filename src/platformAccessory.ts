import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { PopurPlatform } from './platform';
import { PopurDevice, PopurStatus } from './popurApi';
import { PopurDevicePoller } from './devicePoller';

/** The distinct HomeKit tiles a Popur device is split into. */
export type PopurFeature = 'clean' | 'night' | 'bin' | 'cycles';

/**
 * A single HomeKit accessory (one tile) for one feature of a Popur device.
 *
 * HomeKit has no native litter-box type, so each device is exposed as several
 * standalone accessories so they appear as separate tiles in the Home app:
 *   - clean  : Switch (momentary)  -> triggers a clean cycle, then auto-resets
 *   - night  : Switch (stateful)   -> toggles manual / do-not-disturb mode
 *   - bin    : LeakSensor          -> "Leak Detected" (red alert) when the bin is full
 *   - cycles : LightSensor         -> today's cycle count surfaced as lux (read-only)
 * Online/offline is reflected via StatusActive + StatusFault on the sensor tiles.
 *
 * Note: the waste bin uses a LeakSensor rather than FilterMaintenance because Apple's
 * Home app does not render a standalone FilterMaintenance service; a leak sensor gives
 * the most visible "needs attention" alert for a full bin.
 */
export class PopurAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: PopurPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: PopurDevice,
    private readonly poller: PopurDevicePoller,
    private readonly feature: PopurFeature,
  ) {
    const { Service, Characteristic } = this.platform;
    const name = this.accessory.displayName;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Popur')
      .setCharacteristic(Characteristic.Model, device.model || 'Popur')
      .setCharacteristic(Characteristic.SerialNumber, `${device.id}-${feature}`);

    // Each accessory carries exactly one primary service (so each shows as its own tile).
    switch (feature) {
      case 'clean':
        this.service = this.accessory.getService(Service.Switch)
          || this.accessory.addService(Service.Switch, name);
        this.service.getCharacteristic(Characteristic.On)
          .onGet(() => false) // momentary: always reads off
          .onSet(this.handleCleanSet.bind(this));
        break;

      case 'night':
        this.service = this.accessory.getService(Service.Switch)
          || this.accessory.addService(Service.Switch, name);
        this.service.getCharacteristic(Characteristic.On)
          .onGet(() => this.poller.current.manualMode)
          .onSet(this.handleNightSet.bind(this));
        break;

      case 'bin':
        this.service = this.accessory.getService(Service.LeakSensor)
          || this.accessory.addService(Service.LeakSensor, name);
        this.service.getCharacteristic(Characteristic.LeakDetected)
          .onGet(() => this.binLeak(this.poller.current));
        break;

      case 'cycles':
      default:
        this.service = this.accessory.getService(Service.LightSensor)
          || this.accessory.addService(Service.LightSensor, name);
        this.service.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
          .onGet(() => this.cyclesLux(this.poller.current));
        break;
    }

    // Drop any leftover services from earlier plugin versions (e.g. a cached bin
    // accessory that still carries the old FilterMaintenance service). A stale
    // service can stop the Home app from rendering the accessory.
    for (const stale of [...this.accessory.services]) {
      if (stale.UUID !== Service.AccessoryInformation.UUID && stale !== this.service) {
        this.platform.log.debug(`Removing stale service "${stale.displayName}" from ${name}`);
        this.accessory.removeService(stale);
      }
    }

    this.service.setCharacteristic(Characteristic.Name, name);
    this.poller.onUpdate((status) => this.update(status));
  }

  private binLeak(status: PopurStatus): CharacteristicValue {
    const { Characteristic } = this.platform;
    return status.binFull
      ? Characteristic.LeakDetected.LEAK_DETECTED
      : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  }

  /** Map today's cycle count to lux. CurrentAmbientLightLevel must be >= 0.0001. */
  private cyclesLux(status: PopurStatus): CharacteristicValue {
    return Math.max(0.0001, status.cycles);
  }

  private async handleCleanSet(value: CharacteristicValue) {
    if (!value) {
      return;
    }
    this.platform.log.info(`${this.device.name}: starting clean cycle`);
    try {
      await this.platform.popur!.triggerClean(this.device.id);
    } catch (err) {
      this.platform.log.error(`Clean command failed: ${(err as Error).message}`);
    }
    // Reset the momentary switch back to off shortly after.
    setTimeout(() => {
      this.service.updateCharacteristic(this.platform.Characteristic.On, false);
    }, 1000);
  }

  private async handleNightSet(value: CharacteristicValue) {
    const on = value as boolean;
    this.platform.log.info(`${this.device.name}: night mode -> ${on ? 'on' : 'off'}`);
    try {
      await this.platform.popur!.setManualMode(this.device.id, on);
    } catch (err) {
      this.platform.log.error(`Night mode command failed: ${(err as Error).message}`);
    }
  }

  /** Push the latest status to this accessory's characteristic + reachability. */
  private update(status: PopurStatus) {
    const { Characteristic } = this.platform;

    switch (this.feature) {
      case 'night':
        this.service.updateCharacteristic(Characteristic.On, status.manualMode);
        break;
      case 'bin':
        this.service.updateCharacteristic(
          Characteristic.LeakDetected,
          this.binLeak(status),
        );
        break;
      case 'cycles':
        this.service.updateCharacteristic(
          Characteristic.CurrentAmbientLightLevel,
          this.cyclesLux(status),
        );
        break;
      // 'clean' is momentary and has no state to reflect.
    }

    // StatusActive/StatusFault are only valid on the sensor services; the Switch
    // service doesn't support them (setting them there would log warnings).
    if (this.feature === 'bin' || this.feature === 'cycles') {
      this.service.updateCharacteristic(Characteristic.StatusActive, status.online);
      this.service.updateCharacteristic(
        Characteristic.StatusFault,
        status.online
          ? Characteristic.StatusFault.NO_FAULT
          : Characteristic.StatusFault.GENERAL_FAULT,
      );
    }
  }
}
