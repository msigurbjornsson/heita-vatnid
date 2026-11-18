# Getting started

Choose one of two installation paths:

1. **[Local-only website](docs/LOCAL_SETUP.md)** — recommended first. Enter your meter's LAN IP/hostname, run Python, and open localhost. No cloud account, Node or pip dependencies; readings stay on the computer.
2. **[Optional public website](docs/PUBLIC_HOSTING.md)** — your own Cloudflare account/database plus an always-on LAN collector. The read API and history are public without sign-in; uploads require a generated secret.

In either mode, the collector must reach your meter over the home network. Enable the HomeWizard local API, find its local IP in your router and preferably reserve it with DHCP. The setup helper creates ignored owner-only configuration and refuses to overwrite existing files. It never deploys, scans the network or changes the meter/router.

Verify that M-Bus channel 1 actually represents hot water in your installation before trusting water/cost figures. Missing history is unknown, not zero. See [README](README.md) for compatibility and limitations.
