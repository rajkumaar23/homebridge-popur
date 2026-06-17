/**
 * Standalone smoke test for the Popur cloud API — run BEFORE wiring into Homebridge.
 *
 * Usage:
 *   POPUR_EMAIL=you@example.com POPUR_PASSWORD='yourpassword' npm run smoke
 *
 * Optional: add `clean` or `night-on` / `night-off` as the first arg to actually
 * send a command to the first discovered device (this WILL move your litter box):
 *   POPUR_EMAIL=... POPUR_PASSWORD=... npm run smoke -- clean
 */
import { PopurApi } from '../src/popurApi';

const log = {
  debug: (...a: unknown[]) => console.log('[debug]', ...a),
  info: (...a: unknown[]) => console.log('[info]', ...a),
  warn: (...a: unknown[]) => console.warn('[warn]', ...a),
  error: (...a: unknown[]) => console.error('[error]', ...a),
};

async function main() {
  const email = process.env.POPUR_EMAIL;
  const password = process.env.POPUR_PASSWORD;
  const action = process.argv[2];

  if (!email || !password) {
    log.error('Set POPUR_EMAIL and POPUR_PASSWORD env vars.');
    process.exit(1);
  }

  const api = new PopurApi(email, password, log);

  if (!(await api.login())) {
    log.error('Login failed.');
    process.exit(1);
  }
  log.info('Login OK', api.session);
  if (!api.session.homeId) {
    log.warn('No homeId (defaulthomeid) on this account — device discovery needs a home id.');
  }

  // Set DEBUG_RAW=1 to dump the raw home_details body (useful if discovery breaks).
  if (process.env.DEBUG_RAW) {
    const rawHome = await api.getHomeDetailsRaw();
    log.info('RAW home_details:\n' + JSON.stringify(rawHome, null, 2));
  }

  const devices = await api.getDevices();
  log.info(`Found ${devices.length} device(s):`, devices.map((d) => `${d.name} (${d.id})`));
  if (devices.length === 0) {
    process.exit(0);
  }

  const device = devices[0];
  const status = await api.getStatus(device.id);
  log.info(`Status of ${device.name}:`, status);

  if (action === 'clean') {
    log.info('Sending CLEAN command...');
    await api.triggerClean(device.id);
    log.info('Clean command sent.');
  } else if (action === 'night-on' || action === 'night-off') {
    const on = action === 'night-on';
    log.info(`Setting night mode -> ${on}`);
    await api.setManualMode(device.id, on);
    log.info('Night mode command sent.');
  }
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
