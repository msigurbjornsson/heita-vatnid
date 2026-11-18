#!/usr/bin/env python3
"""Package the minimal relay. Configuration contains a secret: keep archive private."""
from pathlib import Path
import tarfile
root=Path(__file__).resolve().parents[1]
config=root/'data/private/relay.config.json'
if not config.is_file():raise SystemExit('Create the private relay config first; see unifi/README.md')
out=root/'data/p1-relay.tar.gz'
with tarfile.open(out,'w:gz') as tar:
    for name in ('p1_relay.py','p1_source.py','unifi/install.sh','unifi/restore-service.sh'):
        tar.add(root/name,arcname=name)
    tar.add(root/'unifi/p1-relay.service',arcname='systemd/p1-relay.service')
    tar.add(config,arcname='relay.config.json')
out.chmod(0o600)
print('Private deployment archive:',out)
