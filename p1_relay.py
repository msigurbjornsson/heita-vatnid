#!/usr/bin/env python3
"""Minimal P1 -> durable SQLite outbox -> authenticated Cloudflare HTTPS relay."""
import argparse
import http.client
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import signal
import sqlite3
import threading
import time
from urllib.parse import urlsplit
import uuid
from p1_source import acquire

ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger('p1')
STOP = threading.Event()
WAKE = threading.Event()


def post_batch(config, batch):
    target = urlsplit(config['ingest_url'])
    if target.scheme != 'https' or not target.hostname or target.username or target.password or target.port not in (None,443) or target.path != '/ingest' or target.query or target.fragment:
        raise ValueError('ingest_url must be an HTTPS /ingest endpoint')
    conn = http.client.HTTPSConnection(target.hostname, timeout=10)
    try:
        body = json.dumps(batch, allow_nan=False, separators=(',', ':')).encode()
        conn.request('POST', '/ingest', body=body, headers={
            'Authorization': 'Bearer '+config['write_token'], 'Content-Type':'application/json'})
        response = conn.getresponse()
        if response.status != 200:
            raise ValueError('Upload HTTP status %s' % response.status)
        data = json.loads(response.read(65536))
        expected = {r['source_id'] for r in batch}
        if not isinstance(data.get('ack'), list) or set(data['ack']) != expected:
            raise ValueError('Incomplete or invalid upload acknowledgement')
        return expected
    finally:
        conn.close()


class Outbox:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS relay_state (key TEXT PRIMARY KEY,value REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)')

    def connect(self):
        return sqlite3.connect(self.path, timeout=5)

    def put(self, reading, collector_id):
        item = {'source_id': uuid.uuid4().hex, 'collector_id':collector_id, 'reading':reading}
        with self.connect() as db:
            db.execute('INSERT INTO outbox(source_id,payload) VALUES(?,?)', (item['source_id'],json.dumps(item,allow_nan=False)))
        return item['source_id']

    def batch(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT payload FROM outbox ORDER BY id LIMIT 50')]

    def ack(self, identifiers):
        with self.connect() as db:
            db.executemany('DELETE FROM outbox WHERE source_id=?', [(i,) for i in identifiers])

    def count(self):
        with self.connect() as db:
            return db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0]


    def wait_for_poll(self, interval):
        with self.connect() as db:
            row=db.execute("SELECT value FROM relay_state WHERE key='last_poll'").fetchone()
        remaining=max(0,min(interval,(row[0]+interval-time.time()) if row else 0))
        if STOP.wait(remaining):return False
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO relay_state(key,value) VALUES('last_poll',?)",(time.time(),))
        return True


def upload_loop(config, outbox):
    delay = 5
    interval = config.get('upload_interval_seconds', 60)
    next_upload = time.monotonic() + interval
    while not STOP.is_set():
        try:
            if STOP.wait(max(0, next_upload - time.monotonic())):
                break
            batch = outbox.batch()
            if not batch:
                WAKE.wait(1); WAKE.clear()
                continue
            identifiers = post_batch(config, batch)
            outbox.ack(identifiers)
            LOG.info('Uploaded %s readings; queued=%s',len(identifiers),outbox.count())
            delay = 5
            next_upload = time.monotonic() + (0 if outbox.count() else interval)
        except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException, sqlite3.Error) as exc:
            LOG.warning('Upload unavailable (%s); queue retained; retry in %ss', exc, delay)
            STOP.wait(delay)
            delay = min(300, delay*2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(ROOT/'relay.config.json'))
    parser.add_argument('--once', action='store_true', help='Queue one real reading, then attempt upload')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    interval = config.get('poll_interval_seconds',30)
    upload_interval = config.get('upload_interval_seconds',60)
    timeout = config.get('http_timeout_seconds',5)
    if isinstance(interval,bool) or not isinstance(interval,(float,int)) or not 10<=interval<=86400:
        parser.error('Poll interval must be 10..86400 seconds')
    if isinstance(upload_interval,bool) or not isinstance(upload_interval,(float,int)) or not 10<=upload_interval<=86400:
        parser.error('Upload interval must be 10..86400 seconds')
    if isinstance(timeout,bool) or not isinstance(timeout,(float,int)) or not .1<=timeout<=60:
        parser.error('HTTP timeout must be .1..60 seconds')
    (ROOT/'logs').mkdir(exist_ok=True)
    handler = RotatingFileHandler(ROOT/'logs/relay.log',maxBytes=1_000_000,backupCount=2)
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    LOG.addHandler(handler); LOG.setLevel(logging.INFO)
    outbox = Outbox(ROOT/config.get('outbox_path','data/outbox.db'))
    for sig in (signal.SIGTERM,signal.SIGINT):
        signal.signal(sig,lambda *_:(STOP.set(),WAKE.set()))
    if args.once:
        if not outbox.wait_for_poll(10):return 1
        reading = acquire(config,STOP)
        if reading:
            outbox.put(reading,config['collector_id'])
            try:
                batch=outbox.batch();outbox.ack(post_batch(config,batch))
            except (OSError,ValueError,http.client.HTTPException):
                LOG.exception('Upload failed; reading queued durably')
        print(json.dumps({'reading':reading,'queued':outbox.count()}))
        return 0 if reading else 1
    uploader = threading.Thread(target=upload_loop,args=(config,outbox),daemon=True)
    uploader.start()
    LOG.info('Relay started; poll=%ss; upload=%ss; no dashboard on this device',interval,upload_interval)
    try:
        while not STOP.is_set():
            if not outbox.wait_for_poll(interval):break
            started=time.monotonic()
            reading=acquire(config,STOP)
            if reading:
                reading['poll_interval_seconds'] = interval
                reading['upload_interval_seconds'] = upload_interval
                # Keep the acquired reading in memory and retry a full/locked disk before polling again.
                while not STOP.is_set():
                    try:
                        outbox.put(reading,config['collector_id']);WAKE.set()
                        LOG.info('Queued reading; water=%s m3; pending=%s',reading.get('hot_water_m3'),outbox.count())
                        break
                    except sqlite3.Error:
                        LOG.exception('Queue write failed; retaining reading in memory and retrying')
                        STOP.wait(15)
            STOP.wait(max(10,interval-(time.monotonic()-started)))
    finally:
        WAKE.set();uploader.join(timeout=12)
        LOG.info('Relay stopped; pending=%s',outbox.count())
    return 0


if __name__=='__main__':
    raise SystemExit(main())
