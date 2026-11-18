#!/bin/sh
set -eu
test -f /data/p1-relay/systemd/p1-relay.service || exit 1
if test ! -e /etc/systemd/system/p1-relay.service; then
    ln -s /data/p1-relay/systemd/p1-relay.service /etc/systemd/system/p1-relay.service
fi
systemctl daemon-reload
systemctl enable p1-relay.service
systemctl start p1-relay.service
