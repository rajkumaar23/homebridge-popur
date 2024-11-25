import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { Popur } from './platform.js';

export class PopurTrashBoxFullnessAccessory {
  private airQualityService: Service;

  constructor(
    private readonly platform: Popur,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Popur')
      .setCharacteristic(this.platform.Characteristic.Model, 'X5');


    this.airQualityService = this.accessory.getService(this.platform.Service.AirQualitySensor)
     || this.accessory.addService(this.platform.Service.AirQualitySensor);
    this.airQualityService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.Name);
    this.airQualityService.getCharacteristic(this.platform.Characteristic.AirQuality).onGet(this.getTrashBoxFullness.bind(this));
  }

  async getTrashBoxFullness(): Promise<CharacteristicValue> {
    const deviceInfo = await this.platform.popurAPI.getDeviceInfo(this.accessory.context.device.DeviceID);
    this.platform.log.debug('Get Device Info ->', deviceInfo);

    const maxCycles = this.platform.config.maxCycles;
    if (isNaN(maxCycles)) {
      throw new Error('Invalid maxCycles');
    }

    const currentCycles = deviceInfo.CyclesSinceLastReset;
    const normalizedCycles = (currentCycles / maxCycles) * 5;
    const airQuality = Math.round(Math.max(1, Math.min(5, normalizedCycles)));
    
    return airQuality;
  }
}
