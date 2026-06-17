import { Logger, PopurApi, PopurDevice, PopurStatus } from './popurApi';

type Listener = (status: PopurStatus) => void;

/**
 * Polls one Popur device's status on an interval and fans the result out to every
 * accessory that represents it. This way the device's separate HomeKit tiles
 * (clean / night mode / waste bin / cycles) share a single cloud poll.
 */
export class PopurDevicePoller {
  private status: PopurStatus = {
    binFull: false,
    cycles: 0,
    totalCycles: 0,
    manualMode: false,
    online: false,
  };

  private readonly listeners: Listener[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly api: PopurApi,
    public readonly device: PopurDevice,
    intervalMs: number,
    private readonly log: Logger,
  ) {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), intervalMs);
  }

  /** Most recent status (used by characteristic onGet handlers). */
  get current(): PopurStatus {
    return this.status;
  }

  /** Register a callback; it fires now with the current status and on every refresh. */
  onUpdate(cb: Listener): void {
    this.listeners.push(cb);
    cb(this.status);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async refresh(): Promise<void> {
    const status = await this.api.getStatus(this.device.id);
    // On a failed fetch, keep last-known values but mark the device offline.
    this.status = status ?? { ...this.status, online: false };

    for (const cb of this.listeners) {
      try {
        cb(this.status);
      } catch (err) {
        this.log.error(`Popur listener error: ${(err as Error).message}`);
      }
    }

    this.log.debug(
      `${this.device.name}: online=${this.status.online} binFull=${this.status.binFull} ` +
      `manualMode=${this.status.manualMode} cycles=${this.status.cycles} total=${this.status.totalCycles}`,
    );
  }
}
