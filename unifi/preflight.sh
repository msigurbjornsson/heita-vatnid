#!/bin/sh
# Read-only checks. Run over SSH before copying/installing the collector.
set -eu
printf 'Model: '
if command -v ubnt-device-info >/dev/null 2>&1; then
    ubnt-device-info model_short 2>/dev/null || true
elif test -r /proc/ubnthal/system.info; then
    sed -n '/^shortname=/p' /proc/ubnthal/system.info
else
    printf 'not identified\n'
fi
uname -m
if test -r /etc/os-release; then cat /etc/os-release; fi
printf '\nPython / SQLite:\n'
if ! command -v python3; then
    printf 'Python 3 is missing; no packages have been installed.\n'
    exit 1
fi
python3 - <<'PY'
import datetime, json, os, shutil, sqlite3, sys
print(json.dumps({'python':sys.version.split()[0], 'executable':sys.executable,
 'sqlite':sqlite3.sqlite_version, 'local_time':datetime.datetime.now().astimezone().isoformat(),
 'data_exists':os.path.isdir('/data'), 'data_writable':os.access('/data',os.W_OK),
 'data_free_mb':round(shutil.disk_usage('/data').free/1024**2) if os.path.isdir('/data') else None},indent=2))
if sys.version_info < (3,9):
    raise SystemExit('Python 3.9+ is required; nothing has been installed.')
PY
printf '\nService manager:\n'
command -v systemctl
systemctl --version | head -1
printf '\nStorage:\n'
df -h /data
if command -v findmnt >/dev/null 2>&1; then findmnt -T /data || true; fi
printf '\nExisting collector / startup helper:\n'
systemctl is-enabled p1-relay.service 2>/dev/null || true
systemctl is-active p1-relay.service 2>/dev/null || true
systemctl is-enabled udm-boot.service 2>/dev/null || true
printf '\nListening TCP ports (relay opens none):\n'
if command -v ss >/dev/null 2>&1; then ss -ltn; fi
