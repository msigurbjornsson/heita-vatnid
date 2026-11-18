# Local-only website

This is the default and requires no cloud account. All readings stay on your computer.

1. Connect the computer to the meter's home LAN. Enable the HomeWizard Local API.
2. Find the meter's private address in your router, for example `192.168.1.100`. Prefer a DHCP reservation. Never use someone else's address from a screenshot or guide.
3. Install Python 3.11+ and clone/download this repository. In its folder run `python3 scripts/setup.py`. Enter the meter address, without `http://` or `/api/...`.
4. Run `python3 p1_reader.py --once`. It prints one real reading as JSON; it does not populate historical data.
5. Run `python3 p1_reader.py`, then open **http://localhost:8080** on that computer. Wait for readings to accumulate.

The setup script writes private `config.json`. It is ignored by Git and created with owner-only permissions. To change the address later, edit `p1_host` there; to change the port, edit `dashboard_port`. Restart the collector after configuration changes. The script refuses to overwrite existing configurations.

No inbound internet ports, HomeWizard cloud account, Cloudflare account or extra hardware is required. The local site listens only on `127.0.0.1`. Access from a phone or another LAN computer is intentionally not enabled by default. Never enable router port forwarding for the meter or dashboard.

## Optional hot-water prices

Leave `hot_water_price_per_m3_isk` and `veitur_tariff` null until you have checked your household bill. You can supply your price in ISK/m³, or choose a compatible saved Veitur tariff and meter class. Missing prices are displayed as unknown rather than invented.

Electricity retailer comparisons in the cloud dashboard use additional prepared data. The local collector's views do not automatically inherit Cloudflare's tariff settings or contact its API. Some comparison fields are unavailable in local-only mode.

## macOS autostart

After a successful local test, stop the foreground process with Ctrl+C. Run:

```sh
python3 scripts/install_launchd.py
```

This installs and starts your `local.heita-vatnid` LaunchAgent for the current Mac user using that Python executable and root `config.json`. It replaces an existing service with the same label; review first if you already have one. No `sudo` is required. Do not run a second foreground collector at the same time.

The computer must stay awake and connected to collect. Logging out, sleep or loss of power stops collection. Start-on-login does not make a sleeping laptop an always-on collector.

Remove autostart without deleting data:

```sh
launchctl bootout gui/$(id -u)/local.heita-vatnid
rm ~/Library/LaunchAgents/local.heita-vatnid.plist
```

## Troubleshooting and backups

- Cannot connect: check Local API, meter IP, Wi-Fi and that both devices are on the same LAN.
- Electricity works but water is unknown: inspect channel compatibility; channel 1 is not universally hot water.
- Water does not change every poll: M-Bus refresh can be slower than the telegram. This is normal.
- History is empty: no readings exist before installation. Keep it running and check `logs/p1.log`.
- Before moving an active SQLite database, stop the collector or use SQLite's backup API. Preserve `data/` and configuration on upgrades. Restarting does not erase the database.
