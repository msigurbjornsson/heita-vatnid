# UCG-Fiber: minimal collector

Current topology: HomeWizard LAN telegram → UCG-Fiber → HTTPS → Cloudflare Worker → D1.
The optional public dashboard runs in your Cloudflare account, updates automatically every 15 seconds, and has no read authentication. The router has **no dashboard, web listener, graph calculations, cloud CLI, Docker, pip packages, or database server**. Python's SQLite is only a durable upload outbox.

Reference environment tested during development: model UCGF, aarch64, Debian 11, Python 3.9.2, SQLite 3.34.1, systemd 247. The service normally uses approximately 11 MB RAM. It is limited to 5% CPU and 96 MB RAM and restarts after failures. No routing, firewall, Wi-Fi or port forwarding configuration was changed.

## Installed files

- `/data/p1-relay/p1_relay.py` — polling loop and independent uploader thread.
- `/data/p1-relay/p1_source.py` — shared raw telegram parser and LAN-only HTTP client.
- `/data/p1-relay/relay.config.json` — private configuration including upload secret; root-only mode 0600.
- `/data/p1-relay/data/outbox.db` — committed readings waiting for acknowledgement.
- `/data/p1-relay/logs/relay.log` — rotated at 1 MB, two backups.
- `/data/p1-relay/systemd/p1-relay.service` — unit, linked into `/etc/systemd/system/` and enabled.

Configuration fields: `p1_host`, `poll_interval_seconds` (30, minimum 10), `upload_interval_seconds` (60), `http_timeout_seconds` (5), `collector_id`, `outbox_path`, `ingest_url`, `write_token`. Never publish this file or the deployment archive. Rotate the Worker secret and this file together if compromised.

Reads only `/api/v1/telegram`; no meter changes or HomeWizard cloud account. HTTP gets up to three attempts. Unchanged readings are valid. Missing water fields stay null with `water_observed=false`; the dashboard retains the last known values but excludes those polls from usage calculations.

## Operations (gateway SSH)

```sh
systemctl status p1-relay.service
systemctl is-enabled p1-relay.service
systemctl restart p1-relay.service
tail -30 /data/p1-relay/logs/relay.log
python3 -c "import sqlite3; d=sqlite3.connect('/data/p1-relay/data/outbox.db'); print('Queued:',d.execute('SELECT COUNT(*) FROM outbox').fetchone()[0])"
```

New readings are held until the next minute upload and sent as a batch, normally two readings per request. Every reading remains an individual D1 row. Uploads have a 10-second timeout and exponential retry from 5 seconds to 5 minutes. Each reading has a stable random ID. D1 enforces uniqueness; a lost acknowledgement/retry cannot duplicate a reading. Only a successful complete acknowledgement removes queued rows. Polling continues while the internet is down. If the queue cannot be written, the current reading is retained in memory and retried; no finite disk is an unlimited buffer.

Stop without deleting queued readings:

```sh
systemctl disable --now p1-relay.service
```

## Reboot and firmware upgrades

Systemd is enabled for normal boot; restart recovery has been tested without rebooting the household router. No gateway reboot was performed. `/data` is used for persistent application files. UniFi firmware upgrades can replace system files or remove third-party service links. **After a firmware upgrade, verify the service and new dashboard timestamps.** Do not assume third-party software is a supported UniFi feature.

If the unit link disappears, restore only this service:

```sh
sh /data/p1-relay/unifi/restore-service.sh
```

No `udm-boot` runner was present, so no undocumented boot runner or automatic firmware hooks were installed.

## Installation / update

Run `python3 scripts/prepare_unifi.py` on the Mac. It writes `data/p1-relay.tar.gz`, containing only the two Python modules, unit, private config, and restoration script. Copy it with authenticated SSH, extract into `/data/p1-relay`, and run `sh /data/p1-relay/unifi/install.sh`. No package installation is required. Keep any existing `data/` and `logs/` directories on updates. The installer validates model and Python syntax and installs/enables the service.

