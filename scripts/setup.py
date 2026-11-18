#!/usr/bin/env python3
"""Configure your own meter. Local-only is the default; no network calls or deployment."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit
ROOT = Path(__file__).resolve().parents[1]


def private_host(value):
    if not re.fullmatch(r'[A-Za-z0-9.:-]+', value or ''):
        raise ValueError('Enter a LAN IP/hostname without http://, path or port')
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        if value.replace('.', '').isdigit() or ':' in value:
            raise ValueError('Invalid LAN IP address')
        return value  # DNS resolution is checked by the actual LAN-only meter client.
    allowed = ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','fc00::/7')
    if not any(address in ipaddress.ip_network(network) for network in allowed):
        raise ValueError('Use the meter private LAN address, not a public IP')
    return value


def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cloud', action='store_true', help='Also prepare optional public cloud hosting')
    parser.add_argument('--host', help='Private LAN IP/hostname of your P1 meter')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--non-interactive', action='store_true')
    args = parser.parse_args(argv)
    def ask(value, prompt):
        if value: return value
        if args.non_interactive: parser.error(prompt+' is required')
        return input(prompt+': ').strip()
    try:
        host = private_host(ask(args.host, 'P1 meter LAN IP/hostname'))
        if not 1024 <= args.port <= 65535: raise ValueError('Port must be 1024..65535')
        config = {'p1_host':host,'poll_interval_seconds':60,'http_timeout_seconds':5,
                  'db_path':'data/readings.db','dashboard_port':args.port,
                  'hot_water_price_per_m3_isk':None,'veitur_tariff':None,'veitur_meter_class':None}
        local_path = ROOT/'config.json'
        outputs = {local_path:config}
        if args.cloud and local_path.exists():
            existing_local = json.loads(local_path.read_text())
            if existing_local.get('p1_host') != host:
                raise ValueError('Existing local configuration uses a different meter; edit/review it first')
            outputs = {}  # Preserve a tested local configuration when adding cloud hosting.

        if args.cloud:
            print('Public cloud mode: anyone with the dashboard URL can read your usage history.')
            account = ask(None, 'Your Cloudflare account ID')
            database = ask(None, 'Your new D1 database UUID')
            name = ask(None, 'Worker name (lowercase letters, numbers and hyphens)')
            endpoint = ask(None, 'Your dashboard HTTPS /ingest URL')
            if not re.fullmatch(r'[0-9a-fA-F]{32}',account): raise ValueError('Invalid account ID')
            if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}',database): raise ValueError('Invalid database UUID')
            if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}',name): raise ValueError('Invalid Worker name')
            url=urlsplit(endpoint)
            if url.scheme!='https' or not url.hostname or url.username or url.password or url.port not in (None,443) or url.path!='/ingest' or url.query or url.fragment:
                raise ValueError('Use your HTTPS /ingest endpoint without credentials or query')
            token=secrets.token_urlsafe(48)
            outputs[ROOT/'data/private/cloudflare.json']={'account_id':account,'database_id':database,'worker_name':name}
            outputs[ROOT/'data/private/worker-secrets.json']={'WRITE_TOKEN':token}
            outputs[ROOT/'data/private/relay.config.json']={'p1_host':host,'poll_interval_seconds':30,'upload_interval_seconds':60,'http_timeout_seconds':5,'collector_id':'home-collector','outbox_path':'data/outbox.db','ingest_url':endpoint,'write_token':token}
        # Never silently replace the user's configuration or generate a mismatched replacement secret.
        existing=[str(p.relative_to(ROOT)) for p in outputs if p.exists()]
        if existing: raise ValueError('Files already exist; edit them instead: '+', '.join(existing))
        for path, value in outputs.items(): write_private(path,value)
    except (ValueError, OSError, EOFError) as error:
        parser.error(str(error))
    print('Private configuration saved. No network requests or deployment performed.')
    print('Test: python3 p1_reader.py --once')
    print('Local website: python3 p1_reader.py -> http://localhost:'+str(args.port))
    if args.cloud: print('Next: follow docs/PUBLIC_HOSTING.md; keep data/private/ secret.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
