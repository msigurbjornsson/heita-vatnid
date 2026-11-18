# Optional public hosting with Cloudflare

Start with the [local test](LOCAL_SETUP.md). This path is optional; local mode needs none of these services.

## What becomes public

The website and read API expose readings and usage patterns **without sign-in**. Everyone with the URL can view them. The collector's secret authenticates uploads only. If this is not appropriate, use local-only mode. This guide does not install Cloudflare Access or another read-access control.

Your meter remains on your LAN, with no port forwarding. An always-on LAN computer polls it and sends readings outbound over verified HTTPS. A separate Cloudflare Worker/D1 instance serves the website. Your Mac need not stay on if a different machine runs the relay. The machine showing the website is not the collector.

## Prerequisites and private configuration

- Your own Cloudflare account and a D1 database.
- Node 22.18+ on the deployment computer, Python 3.11+ on your collector.
- Your own account ID, D1 UUID and chosen Worker name.

```sh
npm ci
npx cf auth login
```

Create a D1 database in your Cloudflare dashboard. In its SQL console, execute `cloud/schema.sql`. Note its UUID and your account ID. Choose a unique Worker name and use the account's workers.dev subdomain to form `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/ingest`.

On a new installation run:

```sh
python3 scripts/setup.py --cloud
```

The helper asks for your meter LAN address, account/database IDs, Worker name and your own HTTPS `/ingest` URL. It writes ignored owner-only files:

- `config.json`: optional direct local-collector settings.
- `data/private/cloudflare.json`: your account/database/Worker configuration.
- `data/private/worker-secrets.json`: newly generated upload secret.
- `data/private/relay.config.json`: the same secret and your meter/ingest settings.

No deployment or network requests occur in the helper. If you already created local configuration, enter the same meter address: the helper preserves it and adds only the three new cloud files. It refuses to overwrite any existing cloud file. You can also use the templates in `examples/` manually; use the same random `WRITE_TOKEN` in the relay's `write_token`. `cloudflare.config.ts` reads `data/private/cloudflare.json`; it contains no preconfigured account or custom domain.

## Build and deploy

```sh
npm run check
npm run build
npx cf deploy --prebuilt --mode production --secrets-file data/private/worker-secrets.json --dry-run
npx cf deploy --prebuilt --mode production --secrets-file data/private/worker-secrets.json
```

Use the HTTPS URL returned by deployment. If it differs from the relay configuration, correct `ingest_url` before running the relay. A custom domain is optional; it is not needed for workers.dev hosting.

Scheduled refresh runs once a minute. Public page requests read materialized views rather than rebuilding the whole history. Verify Cloudflare resource limits and usage for your account; free tiers are not an unlimited service guarantee. No paid subscription is enabled by this guide.

## Run the LAN collector

On the always-on machine, place `p1_relay.py`, `p1_source.py` and your private relay configuration in a private folder. You can also copy the source checkout, excluding any database/configuration that belongs to another machine. Run:

```sh
python3 p1_relay.py --config data/private/relay.config.json
```

That command assumes the repository layout. If you copied only the modules and a config beside them, use `--config relay.config.json`. Relative outbox paths resolve against the program folder. Keep files owner-only and preserve the outbox on updates.

Use only one collector per meter; stop the local foreground collector or its autostart service before starting the relay. Foreground relay execution ends when its session closes: install a startup service on the collector host for unattended operation. [UniFi instructions](../unifi/README.md) are an optional advanced route; a general Linux host is sufficient.

For a Linux systemd host with the files installed at `/opt/p1-relay`, use the generic [service example](../examples/p1-relay.service). Adapt its paths and `User`/`Group` to an unprivileged account that owns that folder and can write its data/log directories. Create the account and the `data/` and `logs/` directories before starting the service; the sandbox requires those paths to exist. Install the reviewed unit into `/etc/systemd/system/`, then run `sudo systemctl daemon-reload` and `sudo systemctl enable --now p1-relay`. Do not use the UniFi root-specific installer on a normal Linux computer.

## Verify your installation

1. Open your own URL. After one or two minutes the latest reading should advance without reloading.
2. Compare the volume/power against the physical meter. Check the water channel and capture time.
3. An unauthenticated POST to `/ingest` should return 401; the read API is public by design.
4. Check `logs/relay.log`. Temporarily stop network access, then restore it: the process should remain alive, queue records and later upload them. Do not delete the outbox as a workaround.
5. Confirm scheduled summaries and account usage/quotas in Cloudflare. Database recovery and backups are your responsibility.

Raw data starts when collection starts. Gaps are estimated only between actual observations; samples missing while the collector/meter was offline cannot be recreated. An old water value is not zero usage. Prices are saved reference snapshots, not bills: verify your actual supply/distribution/water tariff, payment fees, VAT and meter class.

## Upgrades and private backups

Preserve `data/`, `logs/` and private configuration. Back up D1 and take a consistent SQLite backup of the relay outbox. Keep the Worker and relay secret in sync. Never publish secrets, databases, raw telegrams, generated build files or deployment archives.

For the optional local mirror of your own cloud site:

```sh
P1_DASHBOARD_HOST=YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev python3 p1_cloud_dashboard.py
```

That is a viewer, not a collector; it does not poll your meter. The default macOS service is the local collector; configure your own environment/service explicitly if using this mirror.
