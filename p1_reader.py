#!/usr/bin/env python3
"""LAN-only HomeWizard raw DSMR collector. Python standard library only."""
import argparse
from bisect import bisect_left, bisect_right
import datetime as dt
import http.client
import hashlib
from functools import lru_cache
import ipaddress
import json
import logging
from logging.handlers import RotatingFileHandler
import math
from pathlib import Path
import re
import signal
import socket
import sqlite3
import threading
import time
from urllib.parse import urlsplit, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from p1_source import parse_telegram, fetch_telegram, acquire

ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger('p1')
WATER = ('hot_water_m3', 'flow_m3h', 'temp_supply_c', 'temp_return_c', 'energy_wh')
COLUMNS = ('timestamp', 'mbus_timestamp', 'meter_timestamp', 'hot_water_m3', 'flow_m3h',
           'temp_supply_c', 'temp_return_c', 'energy_wh', 'elec_import_kwh',
           'elec_export_kwh', 'power_w', 'voltages', 'currents', 'water_observed')
STOP = threading.Event()


def frontend_version():
    files = [ROOT / 'web' / name for name in ('index.html', 'app.js', 'style.css', 'trend.js', 'details.js', 'comparison.js')]
    signature = tuple((str(file), file.stat().st_mtime_ns, file.stat().st_size) for file in files)
    return _frontend_digest(signature)


@lru_cache(maxsize=1)
def _frontend_digest(signature):
    return hashlib.sha256(b''.join(Path(name).read_bytes() for name, _, _ in signature)).hexdigest()[:16]


def pricing_details(config):
    """Local tariff snapshot; no provider/cloud requests during collection."""
    code = config.get('veitur_tariff')
    override = config.get('hot_water_price_per_m3_isk')
    if code is None:
        return {'price_per_m3_isk': override, 'basis': 'custom' if override is not None else 'none'}
    catalog = json.loads((ROOT / 'veitur_tariffs.json').read_text())
    tariff = catalog['tariffs'][code]
    meter_class = config.get('veitur_meter_class')
    return {**catalog, 'tariff_code': code, 'tariff_label': tariff['label'],
            'price_per_m3_isk': tariff['price_per_m3_isk'] if override is None else override,
            'basis': 'veitur' if override is None else 'custom',
            'meter_class': meter_class, 'fixed_per_day_isk': tariff['fixed_per_day_isk'].get(meter_class),
            'fixed_rates': [{'class': cls, 'size': size, 'per_day_isk': tariff['fixed_per_day_isk'][cls]}
                            for cls, size in catalog['meter_classes'].items()]}



def load_config(path):
    config = json.loads(Path(path).read_text())
    host = config['p1_host']
    if not isinstance(host, str) or not re.fullmatch(r'[a-zA-Z0-9.:-]+', host):
        raise ValueError('p1_host must be a LAN IP or hostname without URL/path')
    for key, low, high in [('poll_interval_seconds', 10, 86400), ('http_timeout_seconds', .1, 60),
                           ('dashboard_port', 1024, 65535)]:
        n = config[key]
        if isinstance(n, bool) or not isinstance(n, (float, int)) or not math.isfinite(n) or not low <= n <= high:
            raise ValueError('%s must be between %s and %s' % (key, low, high))
    if int(config['dashboard_port']) != config['dashboard_port']:
        raise ValueError('dashboard_port must be an integer')
    price = config.get('hot_water_price_per_m3_isk')
    if price is not None and (isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price < 0):
        raise ValueError('Price must be null or a nonnegative finite number')
    if config.get('veitur_tariff') not in (None, 'H1', 'J1'):
        raise ValueError('veitur_tariff must be null, H1 or J1')
    if config.get('veitur_meter_class') not in (None, 'A', 'B', 'C', 'D'):
        raise ValueError('veitur_meter_class must be null, A, B, C or D')
    config['db_path'] = str((ROOT / config['db_path']).resolve())
    return config




WINDOW_MINUTES = (1, 5, 15, 30, 60, 180, 360, 720, 1440, 2880, 10080)
TREND_RANGES = {'1h': (1, 60), '3h': (5, 36), '6h': (15, 24),
                '12h': (30, 24), '24h': (60, 24), '7d': (360, 28)}


class CounterHistory:
    """Keep observed counters intact; interpolate only across closed polling gaps."""
    def __init__(self, rows, poll_interval):
        self.points = {dt.datetime.fromisoformat(row['timestamp']).timestamp():
                       (row['timestamp'], row['hot_water_m3']) for row in rows}
        self.times = sorted(self.points)
        self.gap_threshold = max(2, poll_interval * 2.5)
        self.tolerance = max(2, poll_interval * 1.5)
        self.resets = [0]
        for a, b in zip(self.times, self.times[1:]):
            self.resets.append(self.resets[-1] + int(self.points[b][1] < self.points[a][1]))

    @staticmethod
    def stamp(epoch):
        return dt.datetime.fromtimestamp(epoch).astimezone().isoformat()

    def boundary(self, epoch, gap_only=False):
        i = bisect_right(self.times, epoch) - 1
        if i < 0:
            return None  # Never extrapolate before the first real reading.
        left = self.times[i]
        if left == epoch:
            return {'time': left, 'value': self.points[left][1], 'index': i, 'estimated': False}
        if i + 1 < len(self.times):
            right = self.times[i + 1]
            if right - left > self.gap_threshold:
                if self.points[right][1] < self.points[left][1]:
                    return {'reset': True}
                value = self.points[left][1] + ((epoch - left) / (right - left)) * (self.points[right][1] - self.points[left][1])
                return {'time': epoch, 'value': value, 'index': i, 'estimated': True}
        if not gap_only and epoch - left <= self.tolerance:
            return {'time': left, 'value': self.points[left][1], 'index': i, 'estimated': False}
        return None

    def difference(self, first, last):
        result = {'volume_m3': None, 'average_m3h': None, 'from': None, 'to': None,
                  'duration_seconds': None, 'status': 'insufficient', 'samples': 0, 'estimated': False}
        if (first and first.get('reset')) or (last and last.get('reset')):
            result['status'] = 'reset'
            return result
        if first is None or last is None or last['time'] <= first['time']:
            return result
        duration = last['time'] - first['time']
        result.update({'from': self.stamp(first['time']), 'to': self.stamp(last['time']),
                       'duration_seconds': duration,
                       'samples': bisect_right(self.times, last['time']) - bisect_left(self.times, first['time'])})
        if self.resets[last['index']] != self.resets[first['index']]:
            result['status'] = 'reset'
            return result
        volume = last['value'] - first['value']
        estimated = first['estimated'] or last['estimated']
        result.update({'volume_m3': round(volume, 6), 'average_m3h': volume * 3600 / duration,
                       'status': 'estimated' if estimated else 'measured', 'estimated': estimated})
        return result

    def window(self, minutes, end):
        if end is None:
            return {'minutes': minutes, **self.difference(None, None)}
        return {'minutes': minutes, 'end': self.stamp(end),
                **self.difference(self.boundary(end - minutes * 60), self.boundary(end))}

    def day(self, date):
        start = dt.datetime.combine(date, dt.time()).astimezone().timestamp()
        end = dt.datetime.combine(date + dt.timedelta(days=1), dt.time()).astimezone().timestamp()
        a, b = bisect_left(self.times, start), bisect_left(self.times, end)
        first = self.boundary(start, gap_only=True)
        last = self.boundary(end, gap_only=True)
        if first is None and a < b:
            first = self.boundary(self.times[a])
        if last is None and a < b:
            last = self.boundary(self.times[b - 1])
        result = self.difference(first, last)
        result.update({'date': date.isoformat(), 'samples': b - a, 'reset': result['status'] == 'reset'})
        return result

    def gaps(self):
        gaps = []
        for a, b in zip(self.times, self.times[1:]):
            if b - a > self.gap_threshold:
                # Whole-gap usage is a measured counter difference, even though its timing is unknown.
                gaps.append(self.difference(self.boundary(a), self.boundary(b)))
        return gaps


def water_windows(rows, poll_interval, history=None):
    history = history if history is not None else CounterHistory(rows, poll_interval)
    anchor = history.times[-1] if history.times else None
    gaps = history.gaps()
    return {'as_of': history.stamp(anchor) if anchor is not None else None,
            'intervals': [history.window(minutes, anchor) for minutes in WINDOW_MINUTES],
            'series': {str(minutes): [history.window(minutes, anchor - i * minutes * 60 if anchor is not None else None)
                                     for i in range(23, -1, -1)] for minutes in WINDOW_MINUTES[:9]},
            'trends': {key: {'interval_minutes': minutes, 'total': history.window(minutes * count, anchor),
                             'points': [history.window(minutes, anchor - i * minutes * 60 if anchor is not None else None)
                                        for i in range(count - 1, -1, -1)]}
                       for key, (minutes, count) in TREND_RANGES.items()},
            'gaps': gaps[-20:], 'gap_count': len(gaps),
            'gap_threshold_seconds': history.gap_threshold}

class Store:
    def __init__(self, path):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, mbus_timestamp TEXT,
                meter_timestamp TEXT, hot_water_m3 REAL, flow_m3h REAL, temp_supply_c REAL,
                temp_return_c REAL, energy_wh REAL, elec_import_kwh REAL, elec_export_kwh REAL,
                power_w REAL, voltages TEXT, currents TEXT, water_observed INTEGER NOT NULL)''')
            db.execute('CREATE INDEX IF NOT EXISTS readings_time ON readings(timestamp)')

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def decode(row):
        if row is None:
            return None
        r = dict(row)
        for k in ('voltages', 'currents'):
            r[k] = json.loads(r[k])
        return r

    def append(self, reading):
        reading = dict(reading)
        with self.connect() as db:
            previous = self.decode(db.execute('SELECT * FROM readings ORDER BY id DESC LIMIT 1').fetchone())
            if previous:
                for key in WATER + ('mbus_timestamp',):
                    if reading.get(key) is None:
                        reading[key] = previous[key]
            values = [json.dumps(reading[k]) if k in ('voltages', 'currents') else reading.get(k) for k in COLUMNS]
            db.execute('INSERT INTO readings (%s) VALUES (%s)' % (','.join(COLUMNS), ','.join('?' for _ in COLUMNS)), values)
        return reading

    def snapshot(self, config, health):
        today = dt.datetime.now().astimezone().date()
        cutoff = (today - dt.timedelta(days=13)).isoformat()
        with self.connect() as db:
            latest = self.decode(db.execute('SELECT * FROM readings ORDER BY id DESC LIMIT 1').fetchone())
            rows = db.execute('SELECT timestamp, hot_water_m3 FROM readings WHERE timestamp >= ? AND water_observed = 1 ORDER BY id', (cutoff,)).fetchall()
            previous = db.execute('SELECT timestamp, hot_water_m3 FROM readings WHERE timestamp < ? AND water_observed = 1 ORDER BY timestamp DESC LIMIT 1', (cutoff,)).fetchone()
            if previous is not None:
                rows = [previous] + list(rows)
            count = db.execute('SELECT COUNT(*) FROM readings').fetchone()[0]
        history = CounterHistory(rows, config['poll_interval_seconds'])
        daily = [history.day(today - dt.timedelta(days=i)) for i in range(14)]
        seven = history.difference(None, None)
        if all(day['volume_m3'] is not None for day in daily[:7]):
            seven = history.difference(history.boundary(dt.datetime.fromisoformat(daily[6]['from']).timestamp()),
                                       history.boundary(dt.datetime.fromisoformat(daily[0]['to']).timestamp()))
        seven_total = seven['volume_m3']
        power = None
        if latest and all(latest.get(k) is not None for k in ('flow_m3h', 'temp_supply_c', 'temp_return_c')):
            power = latest['flow_m3h'] * 1000 * 4.186 * (latest['temp_supply_c'] - latest['temp_return_c']) / 3600
        pricing = pricing_details(config)
        price = pricing['price_per_m3_isk']
        for day in daily:
            day['usage_cost_isk'] = round(day['volume_m3'] * price, 2) if day['volume_m3'] is not None and price is not None else None
        usage = water_windows(rows, config['poll_interval_seconds'], history)
        for interval in (usage['intervals'] + [item for series in usage['series'].values() for item in series]
                         + [item for trend in usage['trends'].values() for item in [trend['total']] + trend['points']]):
            interval['usage_cost_isk'] = round(interval['volume_m3'] * price, 2) if interval['volume_m3'] is not None and price is not None else None
        used = daily[0]['volume_m3']
        return {'mode': 'live', 'frontend_version': frontend_version(), 'latest': latest, 'daily': daily,
                'water_usage': usage, 'pricing': pricing,
                'usage_quality': {'today_estimated': daily[0]['estimated'],
                                  'yesterday_estimated': daily[1]['estimated'],
                                  'seven_days_estimated': seven['estimated']},
                'summary': {'today_m3': used, 'yesterday_m3': daily[1]['volume_m3'],
                            'seven_days_m3': seven_total,
                            'heating_kw': power,
                            'current_cost_per_hour_isk': round(latest['flow_m3h'] * price, 2) if latest and latest.get('flow_m3h') is not None and price is not None else None,
                            'yesterday_cost_isk': daily[1]['usage_cost_isk'],
                            'seven_days_cost_isk': round(seven_total * price, 2) if seven_total is not None and price is not None else None,
                            'today_cost_isk': used * price if used is not None and price is not None else None},
                'health': dict(health), 'reading_count': count,
                'poll_interval_seconds': config['poll_interval_seconds']}


def serve(store, config, health):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            # No cross-origin API access. Cloud page imports a file entirely in-browser.
            if self.headers.get('Host', '').split(':')[0] not in ('localhost', '127.0.0.1'):
                self.send_error(403)
                return
            route = self.path.split('?')[0]
            if route == '/api/events':
                self.stream_readings()
                return
            if route == '/api/water-comparison':
                unit = parse_qs(urlsplit(self.path).query).get('period', ['day'])[0]
                if unit not in ('day', 'week', 'month'):
                    self.send_error(400)
                    return
                if not hasattr(store, 'comparison_snapshot'):
                    self.send_error(501, 'Calendar comparisons require the Cloudflare viewer')
                    return
                try:
                    body = json.dumps(store.comparison_snapshot(unit), allow_nan=False).encode()
                except (OSError, ValueError, http.client.HTTPException):
                    self.send_error(503)
                    return
                mime = 'application/json; charset=utf-8'
            elif route in ('/api/status', '/export.json'):
                try:
                    body = json.dumps(store.snapshot(config, health), allow_nan=False).encode()
                except (sqlite3.Error, ValueError):
                    LOG.exception('Unable to read dashboard data')
                    self.send_error(503)
                    return
                mime = 'application/json; charset=utf-8'
            elif route in ('/', '/index.html', '/style.css', '/app.js', '/trend.js', '/details.js', '/comparison.js', '/vatn', '/rafmagn', '/saga'):
                file = ROOT / 'web' / ('index.html' if route in ('/', '/vatn', '/rafmagn', '/saga') else route[1:])
                body = file.read_bytes()
                if file.suffix == '.html':
                    body = body.replace(b'__FRONTEND_VERSION__', frontend_version().encode())
                mime = {'html': 'text/html', 'css': 'text/css', 'js': 'text/javascript'}[file.suffix[1:]] + '; charset=utf-8'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            if route == '/export.json':
                self.send_header('Content-Disposition', 'attachment; filename="heita-vatnid.json"')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def stream_readings(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.connection.settimeout(10)
            previous, heartbeat = None, time.monotonic()
            try:
                self.wfile.write(b'retry: 2000\n\n')
                self.wfile.flush()
                while not STOP.is_set():
                    try:
                        with store.connect() as db:
                            latest_id = db.execute('SELECT MAX(id) FROM readings').fetchone()[0]
                        revision = (latest_id, json.dumps(health, sort_keys=True),
                                    dt.datetime.now().astimezone().date(), frontend_version())
                        if revision != previous:
                            data = json.dumps(store.snapshot(config, health), allow_nan=False)
                            self.wfile.write(('event: reading\ndata: ' + data + '\n\n').encode())
                            self.wfile.flush()
                            previous, heartbeat = revision, time.monotonic()
                        elif time.monotonic() - heartbeat >= 15:
                            self.wfile.write(b': keepalive\n\n')
                            self.wfile.flush()
                            heartbeat = time.monotonic()
                    except sqlite3.Error:
                        LOG.warning('Live stream could not read database; retrying')
                    STOP.wait(2)
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                pass  # A closed tab is normal; EventSource reconnects after network loss.

        def log_message(self, fmt, *args):
            LOG.debug(fmt, *args)
    return ThreadingHTTPServer(('127.0.0.1', int(config['dashboard_port'])), Handler)


def setup_logging():
    (ROOT / 'logs').mkdir(exist_ok=True)
    handler = RotatingFileHandler(ROOT / 'logs/p1.log', maxBytes=2_000_000, backupCount=3)
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(ROOT / 'config.json'))
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    setup_logging()
    try:
        config = load_config(args.config)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.error(str(exc))
    if args.once:
        reading = acquire(config, STOP)
        print(json.dumps(reading if reading else {'error': 'Meter unavailable; see logs/p1.log'}, ensure_ascii=False, allow_nan=False))
        return 0 if reading else 1
    store = Store(config['db_path'])
    health = {'connected': False, 'last_success': None, 'last_attempt': None, 'error': None}
    server = serve(store, config, health)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: STOP.set())
    LOG.info('Started: localhost:%s; poll interval %ss', config['dashboard_port'], config['poll_interval_seconds'])
    print('Dashboard: http://localhost:%s' % config['dashboard_port'], flush=True)
    try:
        while not STOP.is_set():
            started = time.monotonic()
            health['last_attempt'] = dt.datetime.now().astimezone().isoformat()
            reading = acquire(config, STOP)
            health['connected'] = reading is not None
            health['error'] = None if reading else 'Mælir svarar ekki. Reynt aftur sjálfkrafa.'
            if reading:
                try:
                    store.append(reading)
                    health['last_success'] = reading['timestamp']
                    LOG.info('Reading stored; water=%s m3, M-Bus capture=%s', reading['hot_water_m3'], reading['mbus_timestamp'])
                except sqlite3.Error:
                    LOG.exception('Database write failed; will retry at next interval')
                    health['error'] = 'Ekki tókst að vista lestur.'
            STOP.wait(max(0, config['poll_interval_seconds'] - (time.monotonic() - started)))
    finally:
        server.shutdown()
        server.server_close()
        LOG.info('Stopped')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
