"""Shared HomeWizard LAN reader; standard library, Python 3.9+."""
import datetime as dt
import http.client
import ipaddress
import logging
import math
import re
import socket
import threading
LOG = logging.getLogger('p1')
STOP = threading.Event()

def parse_telegram(text):
    if not text.strip().startswith('/') or not any(x.startswith('!') for x in text.splitlines()):
        raise ValueError('Empty or incomplete DSMR telegram')
    values, result = {}, {}
    for line in text.splitlines():
        match = re.match(r'^(\d+-\d+:\d+\.\d+\.\d+)(.*)$', line)
        if match:
            values.setdefault(match[1], []).extend(re.findall(r'\(([^()]*)\)', match[2]))

    def number(code, unit):
        for value in values.get(code, []):
            match = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)\*' + re.escape(unit), value)
            if match:
                n = float(match[1])
                if math.isfinite(n):
                    return n
        return None

    def capture(code):
        for value in values.get(code, []):
            if re.fullmatch(r'\d{12}[WS]?', value):
                try:
                    # Keep meter-local wall time and W/S marker; do not assume European DST.
                    return dt.datetime.strptime(value[:12], '%y%m%d%H%M%S').isoformat() + (value[12:] or '')
                except ValueError:
                    pass
        return None

    for field, code, unit in (
        ('hot_water_m3', '0-1:24.2.1', 'm3'), ('flow_m3h', '0-1:24.2.2', 'm3/h'),
        ('temp_supply_c', '0-1:24.2.3', 'degC'), ('temp_return_c', '0-1:24.2.4', 'degC'),
        ('energy_wh', '0-1:24.2.5', 'Wh'), ('elec_import_kwh', '1-0:1.8.0', 'kWh'),
        ('elec_export_kwh', '1-0:2.8.0', 'kWh')):
        result[field] = number(code, unit)
    result['voltages'] = [number('1-0:%d.7.0' % c, 'V') for c in (32, 52, 72)]
    result['currents'] = [number('1-0:%d.7.0' % c, 'A') for c in (31, 51, 71)]
    phases = [number('1-0:%d.7.0' % c, 'kW') for c in (21, 41, 61)]
    result['phase_power_w'] = [None if v is None else round(v * 1000, 3) for v in phases]
    result['power_w'] = round(sum(phases) * 1000, 3) if all(v is not None for v in phases) else None
    result['mbus_timestamp'] = capture('0-1:24.2.1')
    result['meter_timestamp'] = capture('0-0:1.0.0')
    result['water_observed'] = result['hot_water_m3'] is not None
    if result['hot_water_m3'] is None and result['elec_import_kwh'] is None:
        raise ValueError('Telegram has no usable water or electricity reading')
    return result



def fetch_telegram(config):
    # Resolve once per attempt, validate, then connect to that literal IP. No proxy or redirects.
    addresses = socket.getaddrinfo(config['p1_host'], 80, type=socket.SOCK_STREAM)
    allowed = [ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', 'fc00::/7', '::1/128')]
    ips = [item[4][0] for item in addresses]
    if not ips or any(not any(ipaddress.ip_address(ip) in net for net in allowed) for ip in ips):
        raise ValueError('Meter must resolve only to private LAN addresses')
    conn = http.client.HTTPConnection(ips[0], timeout=config['http_timeout_seconds'])
    try:
        conn.request('GET', '/api/v1/telegram', headers={'Host': config['p1_host'], 'Accept': 'text/plain'})
        response = conn.getresponse()
        if response.status != 200:
            raise ValueError('Meter HTTP status %s' % response.status)
        body = response.read(65537)
        if len(body) > 65536:
            raise ValueError('Telegram too large')
        return body.decode('ascii')
    finally:
        conn.close()


def acquire(config, stop=STOP):
    for attempt in range(3):
        try:
            reading = parse_telegram(fetch_telegram(config))
            reading['timestamp'] = dt.datetime.now().astimezone().isoformat(timespec='seconds')
            if not reading['water_observed']:
                LOG.warning('M-Bus channel 1 missing or invalid; retaining last water reading')
            return reading
        except (OSError, ValueError, http.client.HTTPException) as exc:
            LOG.warning('Poll attempt %s/3 failed: %s', attempt + 1, exc)
            if attempt < 2 and stop.wait(attempt + 1):
                break
    return None

