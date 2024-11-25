import axios from 'axios';
import md5 from 'md5';
import { Popur } from './platform';

const API_BASE_URL = 'https://cloud.popur.com.cn';

export interface DeviceListEntry {
    DeviceID: string;
    Model: string;
    Name: string;
}

export interface DeviceItem {
    CyclesSinceLastReset: number;
    CyclesToday: number;
}

export class PopurAPI {
  private api;
  private token: string | null = null;
  private homeList: string[] = [];

  constructor(private readonly platform: Popur) {
    this.api = axios.create({
      baseURL: API_BASE_URL,
    });
    this.platform = platform;
  }

  async login(username: string, password: string): Promise<void> {
    this.platform.log.debug('Logging in');
    const response = await this.api.post('/uapi/auth', {
      'param': username,
      'password': md5(password),
      'type': '2',
    });
    this.token = response.data.data.token;
    this.homeList = response.data.data.user.homelist;
    this.platform.log.debug('Logged in with token', this.token);
    this.platform.log.debug('Home list', this.homeList);
    return Promise.resolve();
  }

  async fetchDevices(): Promise<DeviceListEntry[]> {
    if (!this.token) {
      throw new Error('Not authenticated');
    }

    const devices: DeviceListEntry[] = [];
    for (const homeId of this.homeList) {
      const response = await this.api.get(`/uapi/home_details/${homeId}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });
      for (const device of response.data.data.devicelist) {
        devices.push({
          DeviceID: device.devid,
          Model: device.model,
          Name: device.name,
        });
      }
    }
    this.platform.log.debug('Fetched devices', devices);
    return devices;
  }

  async getDeviceInfo(devid: string): Promise<DeviceItem> {
    if (!this.token) {
      throw new Error('Not authenticated');
    }

    const response = await this.api.get(`/uapi/deviceinfo/info/${devid}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    return {
      CyclesSinceLastReset: response.data.data.lastworknum,
      CyclesToday: response.data.data.worknum,
    };
  }
}
