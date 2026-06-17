import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { PopurX5Platform } from './platform';
import { PopurDevice, PopurStatus } from './popurApi';

/**
 * One accessory per Popur X5. HomeKit has no native litter-box type, so the device
 * is modeled as:
 *   - Switch "Clean Cycle"  (momentary; triggers a clean, then auto-resets)
 *   - Switch "Night Mode"   (stateful; toggles manual/do-not-disturb mode)
 *   - FilterMaintenance     ("Change Filter" when the waste bin is full)
 * Online/offline is reflected via StatusActive + StatusFault on those services.
 */
export class PopurX5Accessory {
  private readonly cleanService: Service;
  private readonly nightService: Service;
  private readonly binService: Service;
  private readonly cyclesService: Service;

  private status: PopurStatus = {
    binFull: false,
    cycles: 0,
    totalCycles: 0,
    manualMode: false,
    online: false,
  };

  private pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: PopurX5Platform,
    private readonly accessory: PlatformAccessory,
    private readonly device: PopurDevice,
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Popur')
      .setCharacteristic(Characteristic.Model, 'X5')
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    // --- Clean cycle (momentary switch) ---
    this.cleanService =
      this.accessory.getServiceById(Service.Switch, 'clean') ||
      this.accessory.addService(Service.Switch, `${device.name} Clean`, 'clean');
    this.cleanService.setCharacteristic(Characteristic.Name, `${device.name} Clean`);
    this.cleanService.getCharacteristic(Characteristic.On)
      .onGet(() => false) // momentary: always reads off
      .onSet(this.handleCleanSet.bind(this));

    // --- Night / manual mode (stateful switch) ---
    this.nightService =
      this.accessory.getServiceById(Service.Switch, 'night') ||
      this.accessory.addService(Service.Switch, `${device.name} Night Mode`, 'night');
    this.nightService.setCharacteristic(Characteristic.Name, `${device.name} Night Mode`);
    this.nightService.getCharacteristic(Characteristic.On)
      .onGet(() => this.status.manualMode)
      .onSet(this.handleNightSet.bind(this));

    // --- Bin full (filter maintenance) ---
    this.binService =
      this.accessory.getService(Service.FilterMaintenance) ||
      this.accessory.addService(Service.FilterMaintenance, `${device.name} Waste Bin`);
    this.binService.setCharacteristic(Characteristic.Name, `${device.name} Waste Bin`);
    this.binService.getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => this.binIndication());

    // --- Cycles today (light sensor "lux hack") ---
    // HomeKit has no numeric-display service, so the daily cycle count is surfaced as
    // an ambient-light-level reading: 3 cycles today -> "3 lux". Pure read-only display.
    this.cyclesService =
      this.accessory.getService(Service.LightSensor) ||
      this.accessory.addService(Service.LightSensor, `${device.name} Cycles Today`);
    this.cyclesService.setCharacteristic(Characteristic.Name, `${device.name} Cycles Today`);
    this.cyclesService.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.cyclesLux());

    // Initial fetch + polling loop.
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), this.platform.pollInterval);
    this.platform.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
    });
  }

  private binIndication(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.status.binFull
      ? Characteristic.FilterChangeIndication.CHANGE_FILTER
      : Characteristic.FilterChangeIndication.FILTER_OK;
  }

  /** Map today's cycle count to lux. CurrentAmbientLightLevel must be >= 0.0001. */
  private cyclesLux(): CharacteristicValue {
    return Math.max(0.0001, this.status.cycles);
  }

  private async handleCleanSet(value: CharacteristicValue) {
    if (!value) {
      return;
    }
    this.platform.log.info(`Popur ${this.device.name}: starting clean cycle`);
    try {
      await this.platform.popur!.triggerClean(this.device.id);
    } catch (err) {
      this.platform.log.error(`Clean command failed: ${(err as Error).message}`);
    }
    // Reset the momentary switch back to off shortly after.
    setTimeout(() => {
      this.cleanService.updateCharacteristic(this.platform.Characteristic.On, false);
    }, 1000);
  }

  private async handleNightSet(value: CharacteristicValue) {
    const on = value as boolean;
    this.platform.log.info(`Popur ${this.device.name}: night mode -> ${on ? 'on' : 'off'}`);
    try {
      await this.platform.popur!.setManualMode(this.device.id, on);
      this.status.manualMode = on;
    } catch (err) {
      this.platform.log.error(`Night mode command failed: ${(err as Error).message}`);
    }
  }

  private async refresh() {
    const status = await this.platform.popur!.getStatus(this.device.id);
    if (!status) {
      this.setReachability(false);
      return;
    }
    this.status = status;
    const { Characteristic } = this.platform;

    this.nightService.updateCharacteristic(Characteristic.On, status.manualMode);
    this.binService.updateCharacteristic(
      Characteristic.FilterChangeIndication,
      this.binIndication(),
    );
    this.cyclesService.updateCharacteristic(
      Characteristic.CurrentAmbientLightLevel,
      this.cyclesLux(),
    );
    this.setReachability(status.online);

    this.platform.log.debug(
      `Popur ${this.device.name}: online=${status.online} binFull=${status.binFull} ` +
      `manualMode=${status.manualMode} cycles=${status.cycles} total=${status.totalCycles}`,
    );
  }

  /** Reflect online/offline on every service via StatusActive + StatusFault. */
  private setReachability(online: boolean) {
    const { Characteristic } = this.platform;
    const fault = online
      ? Characteristic.StatusFault.NO_FAULT
      : Characteristic.StatusFault.GENERAL_FAULT;
    for (const svc of [this.cleanService, this.nightService, this.binService, this.cyclesService]) {
      svc.updateCharacteristic(Characteristic.StatusActive, online);
      svc.updateCharacteristic(Characteristic.StatusFault, fault);
    }
  }
}
