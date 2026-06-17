# homebridge-popur

A [Homebridge](https://homebridge.io) plugin that brings **Popur** self-cleaning cat litter
boxes into Apple HomeKit. Developed and tested against the **Popur X5**, but every device on
your Popur account is discovered automatically, so other models should work too.

> ⚠️ **Unofficial & cloud-dependent.** Popur boxes have no local API. This plugin talks to
> Popur's cloud (`cloud.popur.com.cn`) using the same protocol the official app uses,
> reverse-engineered from the
> [Home Assistant Popur integration](https://github.com/gingerAUT1988/home-assistant-popur).
> It is not affiliated with or endorsed by Popur and may stop working if they change their
> cloud API.

## What you get in HomeKit

HomeKit has no "litter box" accessory type, so each device is exposed as several **separate
tiles**:

| HomeKit tile          | Service | What it does |
|-----------------------|---------|--------------|
| **Clean**             | Switch (momentary) | Flip on to start a cleaning cycle; it auto-resets to off. |
| **Night Mode**        | Switch  | Toggles manual / do-not-disturb mode. |
| **Waste Bin**         | Leak Sensor | "Leak Detected" (bold red alert) when the waste drawer is full — use it to trigger Home app notifications. |
| **Cycles Today**      | Light Sensor | Today's cycle count surfaced as a lux reading (e.g. 3 cycles → "3 lux"), read-only. |

Each tile also reflects the box going offline (the sensors show an unreachable/fault state).

> HomeKit has no "litter box" or "bin full" accessory type, so these are pragmatic mappings.
> The **Waste Bin** uses a Leak Sensor (rather than the semantically-nicer Filter Maintenance)
> because Apple's Home app does not render standalone Filter Maintenance tiles — a leak sensor
> gives the most visible "needs attention" alert.

## Install

```sh
npm install -g homebridge-popur
```

Or via the Homebridge UI: search for **Popur**.

## Configuration

Add via the Homebridge UI, or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "Popur",
      "name": "Popur",
      "email": "you@example.com",
      "password": "your-popur-app-password",
      "pollInterval": 60
    }
  ]
}
```

| Field         | Required | Default | Notes |
|---------------|----------|---------|-------|
| `email`       | yes      | —       | Your Popur app account email. |
| `password`    | yes      | —       | Your Popur app password. |
| `pollInterval`| no       | `60`    | Seconds between cloud status refreshes (min 15). |

> 🔒 Your Popur password is stored in the Homebridge config. It is only ever sent to Popur's
> cloud (MD5-hashed in transit, as the app does).

## Development

```sh
npm install
npm run build      # compile TypeScript -> dist/

# Verify the cloud API works against your account before running Homebridge:
POPUR_EMAIL=you@example.com POPUR_PASSWORD='...' npm run smoke
# add `clean` or `night-on` / `night-off` to actually send a command:
POPUR_EMAIL=... POPUR_PASSWORD='...' npm run smoke -- clean
```

Then run Homebridge in dev mode pointing at a local config:

```sh
npm run watch
homebridge -D -U ./.homebridge
```

## Protocol notes

- Auth: `POST /uapi/auth` with `{param: email, password: md5(password), type: "2"}` → token.
- Status: `GET /uapi/deviceinfo/info/{deviceId}` → `rubbish` (==2 = bin full), `worknum`,
  `lastworknum`, `manualmode`, `isonline`.
- Commands: MQTT-over-WebSocket at `wss://cloud.popur.com.cn:443/mqtt?token=...`
  - Clean → `devcrpc/action/{deviceId}` (`method: action`)
  - Manual mode → `devcrpc/attr/{deviceId}` (`method: set_properties`, property id 3)

## License

MIT
