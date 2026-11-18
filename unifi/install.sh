#!/bin/sh
set -eu
test "$(id -u)" = 0 || { echo 'Run on the gateway as root.' >&2; exit 1; }
test "$(ubnt-device-info model_short)" = UCGF || { echo 'Expected UCG-Fiber.' >&2; exit 1; }
cd /data/p1-relay
python3 - <<'PY'
import ast,json,pathlib,sys
if sys.version_info<(3,9):raise SystemExit('Python 3.9+ required')
for name in ('p1_relay.py','p1_source.py'):ast.parse(pathlib.Path(name).read_text())
c=json.loads(pathlib.Path('relay.config.json').read_text())
if not c['ingest_url'].startswith('https://'):raise SystemExit('HTTPS required')
PY
mkdir -p data logs
chmod 700 data logs
chmod 600 relay.config.json
systemd-analyze verify systemd/p1-relay.service
if test -e /etc/systemd/system/p1-relay.service && ! test -L /etc/systemd/system/p1-relay.service; then
    echo 'Existing non-symlink unit; review before replacing.' >&2; exit 1
fi
ln -sfn /data/p1-relay/systemd/p1-relay.service /etc/systemd/system/p1-relay.service
systemctl daemon-reload
systemctl enable p1-relay.service
systemctl restart p1-relay.service
