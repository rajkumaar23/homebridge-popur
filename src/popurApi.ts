import { createHash } from 'crypto';
import axios, { AxiosInstance } from 'axios';
import mqtt from 'mqtt';

const BASE_URL = 'https://cloud.popur.com.cn';
const USER_AGENT = 'com.cloudapp.popur.app';
const MQTT_BROKER = 'cloud.popur.com.cn';
const MQTT_PORT = 443;

/** Minimal logger shape so this client works with or without Homebridge's logger. */
export interface Logger {
  debug(message: string, ...params: unknown[]): void;
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
}

export interface PopurDevice {
  /** Device id used in status/command endpoints. */
  id: string;
  name: string;
  /** Model code reported by the cloud (e.g. "LB02K"), if any. */
  model: string;
  /** Raw device record from the cloud, in case more fields are needed later. */
  raw: Record<string, unknown>;
}

export interface PopurStatus {
  binFull: boolean;
  cycles: number;
  totalCycles: number;
  manualMode: boolean;
  online: boolean;
}

/**
 * Client for the (unofficial, reverse-engineered) Popur cloud API.
 *
 * Ported from the Home Assistant custom component
 * https://github.com/gingerAUT1988/home-assistant-popur (custom_components/popur/api.py).
 *
 * Status is read over plain HTTPS; commands (clean / manual mode) are sent over
 * MQTT-over-WebSocket, matching how the official app behaves.
 */
export class PopurApi {
  private readonly http: AxiosInstance;
  private readonly passwordHash: string;

  private token: string | null = null;
  private userId: string | null = null;
  private homeId: string | null = null;

  constructor(
    private readonly email: string,
    password: string,
    private readonly log: Logger,
  ) {
    this.passwordHash = createHash('md5').update(password).digest('hex');
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 10_000,
      headers: { 'User-Agent': USER_AGENT },
    });
  }

  /** Authenticate and cache the token / home id. Returns true on success. */
  async login(): Promise<boolean> {
    try {
      const resp = await this.http.post(
        '/uapi/auth',
        { param: this.email, password: this.passwordHash, type: '2' },
        { headers: { 'Content-Type': 'application/json' } },
      );
      const data = resp.data;
      if (data?.code === 200) {
        this.token = data.data.token;
        const user = data.data.user ?? {};
        this.userId = user._id ?? null;
        this.homeId = user.defaulthomeid ?? null;
        this.log.debug(`Popur login OK (home ${this.homeId})`);
        return true;
      }
      this.log.error(`Popur login failed: ${JSON.stringify(data)}`);
    } catch (err) {
      this.log.error(`Popur connection error: ${(err as Error).message}`);
    }
    return false;
  }

  /** Debug snapshot of the authenticated session (no secrets). */
  get session() {
    return { hasToken: !!this.token, userId: this.userId, homeId: this.homeId };
  }

  private async ensureToken(): Promise<boolean> {
    if (this.token) {
      return true;
    }
    return this.login();
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.token}`, 'User-Agent': USER_AGENT };
  }

  /** Fetch the list of devices on the account's default home. */
  async getDevices(): Promise<PopurDevice[]> {
    if (!(await this.ensureToken())) {
      return [];
    }
    if (!this.homeId) {
      this.log.warn('Popur: no defaulthomeid on the account; cannot list devices.');
      return [];
    }
    try {
      const resp = await this.http.get(`/uapi/home_details/${this.homeId}`, {
        headers: this.authHeaders(),
      });
      const list = this.extractDeviceList(resp.data);
      if (list.length === 0) {
        this.log.warn(
          `Popur: home_details returned no devices. Raw response: ${JSON.stringify(resp.data)}`,
        );
      }
      return list.map((d) => ({
        id: String(d.devid ?? d._id ?? d.did ?? d.deviceid ?? d.id ?? ''),
        name: String(d.name ?? d.nickname ?? d.devicename ?? 'Popur'),
        model: String(d.model ?? d.devicemodel ?? ''),
        raw: d,
      })).filter((d) => d.id !== '');
    } catch (err) {
      this.log.error(`Popur device discovery error: ${(err as Error).message}`);
      return [];
    }
  }

  /** Debug helper: return the raw home_details response body. */
  async getHomeDetailsRaw(): Promise<unknown> {
    if (!(await this.ensureToken()) || !this.homeId) {
      return null;
    }
    const resp = await this.http.get(`/uapi/home_details/${this.homeId}`, {
      headers: this.authHeaders(),
    });
    return resp.data;
  }

  /** Find the device array in the home_details response, tolerating key variations. */
  private extractDeviceList(body: unknown): Record<string, unknown>[] {
    const data = (body as { data?: unknown })?.data;
    if (Array.isArray(data)) {
      return data as Record<string, unknown>[];
    }
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      for (const key of ['devicelist', 'devices', 'deviceList', 'device', 'list']) {
        if (Array.isArray(obj[key])) {
          return obj[key] as Record<string, unknown>[];
        }
      }
    }
    return [];
  }

  /** Debug helper: return the raw deviceinfo/info response body for a device. */
  async getStatusRaw(deviceId: string): Promise<unknown> {
    if (!(await this.ensureToken())) {
      return null;
    }
    const resp = await this.http.get(`/uapi/deviceinfo/info/${deviceId}`, {
      headers: this.authHeaders(),
    });
    return resp.data;
  }

  /** Fetch and normalize the status of a single device. Returns null on failure. */
  async getStatus(deviceId: string): Promise<PopurStatus | null> {
    if (!(await this.ensureToken())) {
      return null;
    }
    try {
      const resp = await this.http.get(`/uapi/deviceinfo/info/${deviceId}`, {
        headers: this.authHeaders(),
      });
      const data = resp.data?.data ?? {};
      return {
        binFull: data.rubbish === 2,
        cycles: Number(data.worknum ?? 0),
        totalCycles: Number(data.lastworknum ?? 0),
        manualMode: String(data.manualmode) === '1',
        online: String(data.isonline) === '1',
      };
    } catch (err) {
      // A 401 most likely means the token expired — drop it so the next call re-logs in.
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        this.log.debug('Popur token rejected (401); will re-login on next call.');
        this.token = null;
      }
      this.log.error(`Popur status fetch error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Trigger a cleaning cycle. */
  async triggerClean(deviceId: string): Promise<void> {
    await this.sendCommand(deviceId, 'clean');
  }

  /** Turn manual (night / do-not-disturb) mode on or off. */
  async setManualMode(deviceId: string, on: boolean): Promise<void> {
    await this.sendCommand(deviceId, 'manual_mode', on);
  }

  private buildPayload(deviceId: string, cmd: 'clean' | 'manual_mode', value?: boolean) {
    const id = Math.floor(Date.now() / 1000);
    if (cmd === 'clean') {
      return {
        topic: `devcrpc/action/${deviceId}`,
        payload: {
          id,
          method: 'action',
          from: 'remote',
          params: { did: '0', sid: 2, aid: 1, in: [] },
        },
      };
    }
    return {
      topic: `devcrpc/attr/${deviceId}`,
      payload: {
        id,
        method: 'set_properties',
        from: 'remote',
        params: [{ did: '0', pid: 3, sid: 2, value: value ? 1 : 0 }],
      },
    };
  }

  /**
   * Publish a single command over MQTT-over-WebSocket, then disconnect.
   * Mirrors api.py send_command(): connect, publish, brief settle, disconnect.
   */
  private async sendCommand(
    deviceId: string,
    cmd: 'clean' | 'manual_mode',
    value?: boolean,
  ): Promise<void> {
    if (!(await this.ensureToken())) {
      throw new Error('Cannot send command: not authenticated');
    }
    const { topic, payload } = this.buildPayload(deviceId, cmd, value);
    const url = `wss://${MQTT_BROKER}:${MQTT_PORT}/mqtt?token=${this.token}`;

    await new Promise<void>((resolve, reject) => {
      const client = mqtt.connect(url, {
        protocolVersion: 4,
        connectTimeout: 10_000,
        reconnectPeriod: 0,
        // The broker speaks the "mqtt" websocket subprotocol.
        wsOptions: { headers: { 'Sec-WebSocket-Protocol': 'mqtt' } },
      });

      const fail = (err: Error) => {
        client.end(true);
        reject(err);
      };

      client.on('error', fail);
      client.on('connect', () => {
        client.publish(topic, JSON.stringify(payload), { qos: 0 }, (err) => {
          if (err) {
            return fail(err);
          }
          this.log.debug(`Popur command sent to ${topic}: ${JSON.stringify(payload)}`);
          // Give the broker a moment to forward before closing (matches HA's sleep(0.5)).
          setTimeout(() => {
            client.end(false, {}, () => resolve());
          }, 500);
        });
      });
    });
  }
}
