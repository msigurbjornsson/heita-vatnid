#!/usr/bin/env python3
"""Generate and load this Mac user's LaunchAgent using the current Python."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
logs = root / 'logs'
logs.mkdir(exist_ok=True)
label = 'local.heita-vatnid'
plist = {'Label': label, 'ProgramArguments': [str(Path(sys.executable).resolve()), str(root / ('p1_cloud_dashboard.py' if '--cloud-dashboard' in sys.argv else 'p1_reader.py'))],
         'WorkingDirectory': str(root), 'RunAtLoad': True, 'KeepAlive': True,
         'ThrottleInterval': 30, 'ProcessType': 'Background',
         'StandardOutPath': str(logs / 'launchd.out.log'), 'StandardErrorPath': str(logs / 'launchd.err.log')}
path = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
path.parent.mkdir(parents=True, exist_ok=True)
(root / 'launchd' / (label + '.plist')).write_bytes(plistlib.dumps(plist))
# Replace only our own service; never stop unrelated processes.
subprocess.run(['launchctl', 'bootout', 'gui/%s/%s' % (os.getuid(), label)], capture_output=True)
path.write_bytes(plistlib.dumps(plist))
subprocess.run(['launchctl', 'bootstrap', 'gui/%s' % os.getuid(), str(path)], check=True)
print('Installed:', path)
print('Dashboard: http://localhost:8080 (or configured port)')
