# Heita vatnið

A self-hosted HomeWizard P1 dashboard for hot water and electricity, with Icelandic labels, live graphs and electricity-plan comparisons. Parse the raw local DSMR telegram, store readings, and see usage over time.

**Choose where your data lives:**

| Mode | Website | Data storage | Requirements |
|---|---|---|---|
| **Local-only — start here** | `http://localhost:8080`, on the collector computer | Your SQLite database | Python 3.11+, same LAN as your meter |
| **Optional public cloud** | Your own HTTPS URL, accessible without sign-in | Your Cloudflare D1 database; collector has a durable outbox | Python collector on the LAN, your Cloudflare account, Node 22.18+ for deployment |

## Quick start: local website

Download this repository, or clone it and open its folder:

```sh
git clone https://github.com/msigurbjornsson/heita-vatnid.git
cd heita-vatnid
```

Then:

```sh
python3 --version
python3 scripts/setup.py
python3 p1_reader.py --once
python3 p1_reader.py
```

The setup helper asks for **your P1 meter's local IP or hostname**, for example `192.168.1.100`. Find it in your router's client list or meter settings; enable the HomeWizard Local API. The collector must be on the same home network. A DHCP reservation keeps the address stable. The helper creates ignored private configuration and refuses to overwrite existing files. It does not deploy or contact any cloud service.

Open **http://localhost:8080**. No Node, pip packages, account or cloud service is needed for local mode. The server binds to loopback only: this URL is for the same computer, not other devices on the LAN. Keep that computer awake to keep collecting. See [local setup and autostart](docs/LOCAL_SETUP.md).

## Optional: make your own public website

Follow the separate [public hosting handbook](docs/PUBLIC_HOSTING.md). It covers your own database/account, a matching collector upload secret, deployment, verification, startup and backups. **Public hosting exposes usage history to anyone with the URL.** Upload authentication is not read authentication. A local-only setup publishes no readings to the internet.

## Compatibility

- HomeWizard P1 with unauthenticated local telegram endpoint `/api/v1/telegram` enabled.
- Hot water is read from M-Bus channel 1, including nonstandard split timestamp/volume lines. Channel 1 must actually be your hot-water meter: verify this on your installation. Other meters may use channel 1 for gas or another medium. Do not assume the medium from the channel number alone.
- Missing water values remain unknown; unchanged cumulative readings are valid. Closed gaps are allocated as estimates. No data is invented before the first reading. Counter resets invalidate affected usage periods.
- Dates, tariffs and time bands currently assume Iceland (`Atlantic/Reykjavik`, UTC). This is not a generic international billing engine.

## Features and operating limits

Live water flow, volume, temperatures, electricity power and phases; daily history; graphs; minute/hour windows; calendar water comparisons; optional cost references and electricity-plan comparisons based on saved Aurbjörg prices. Fixed/service fees are excluded. Verify your own tariff and update the saved price files; prices are not refreshed automatically.

The standalone local collector has its own calculation path. Cloud-specific retail plan comparisons require the cloud-prepared fields; local mode can show unavailable plan values until those fields are provided. No cloud calls are made to fill them in.

Polling/retry logs and SQLite data persist across restarts. Cloud relay collection is independent of uploads, with durable retry and idempotent acknowledgements. No collector captures samples while it or the meter is offline. Cloudflare quotas and finite disk space still apply; inspect logs and back up data. Optional [UniFi collector installation](unifi/README.md) is advanced and is not a requirement or a vendor-supported router feature.

## Development and tests

Python code uses only the standard library. Run:

```sh
python3 -m unittest discover -s tests
node tests/test_cloud.mjs
node tests/test_heating_insights.mjs
node tests/test_electricity_cost.mjs
node tests/test_hs_orka.mjs
node tests/test_plans.mjs
node tests/test_materialized.mjs
node tests/test_worker_reads.mjs
```

Cloud development uses the `cf` CLI, not Wrangler. See the hosting handbook for account/database configuration before `npm ci`, `npm run check` and `npm run build`. The application does not include a working deployment account or any household's data. Test fixtures are synthetic.

## Privacy and license

Never commit `config.json`, `data/`, `logs/`, databases, backups, upload secrets, generated builds or installed service files. Use only the example templates in `examples/` for sharing. No accounts, secrets or data from an existing installation are included.

MIT license; see [LICENSE](LICENSE). Third-party tariff facts and source links are references, not a guarantee of current prices or supplier endorsement.

## Heating-system indications

`cloud/heating-insights.js` evaluates raw water observations during the most recent hour. At least 90% valid interval coverage and a fresh water observation are required; missing water, invalid temperatures, stale M-Bus captures and polling gaps are not interpolated. Low cooling is indicated only after at least 54 minutes with a supply/return difference below 10 °C and flow of at least 100 L/h. These are provisional household thresholds, not validated fault or efficiency limits.

Flow and supply-temperature changes use the median of the matching rolling hour on the preceding seven days, requiring at least three sufficiently covered days. Flow flags require a 50% change, with minimum flow and absolute-change guards; supply flags require a 5 °C drop with at least 20 L/h flow. Weather, domestic hot-water use and changed habits can explain changes. The water page displays evidence, thresholds and a system checklist; the overview links to active indications. Disconnected, stale, demo and imported views suppress active indications. Inlet readings do not diagnose individual radiators, leaks, filters or pressure regulators. Run `node tests/test_heating_insights.mjs` for persistence, baseline, missing-data, gap and freshness cases.
