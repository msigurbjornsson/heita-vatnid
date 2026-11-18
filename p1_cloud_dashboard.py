#!/usr/bin/env python3
"""Optional localhost view of Cloudflare data. Never polls the P1 meter."""
import datetime as dt
import os
import http.client
import json
import signal
import threading
from pathlib import Path
import p1_reader as p

ENDPOINT=os.environ.get('P1_DASHBOARD_HOST','')


def main():
    if not ENDPOINT or any(c in ENDPOINT for c in "/:@?#"):
        raise SystemExit("Set P1_DASHBOARD_HOST to your own dashboard hostname (without https:// or path)")
    p.setup_logging()
    config=p.load_config(p.ROOT/'config.json')
    store=p.Store(config['db_path'])
    original=store.snapshot
    cached=[None]
    health={'connected':False,'last_success':None,'error':None}
    def snapshot(config,health):
        result=dict(cached[0]) if cached[0] else original(config,health)
        result['frontend_version']=p.frontend_version()
        if not health['connected']:
            result['health']={**result.get('health',{}),'connected':False,'error':'Cloudflare svarar ekki. Síðustu gögn varðveitt.'}
        return result
    def comparison_snapshot(unit):
        conn=http.client.HTTPSConnection(ENDPOINT,timeout=15)
        try:
            conn.request('GET','/api/water-comparison?period='+unit)
            response=conn.getresponse()
            if response.status!=200:raise ValueError('Cloudflare comparison HTTP %s'%response.status)
            return json.loads(response.read(1_000_000))
        finally:conn.close()
    store.comparison_snapshot=comparison_snapshot
    store.snapshot=snapshot
    server=p.serve(store,config,health)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:p.STOP.set())
    p.LOG.info('Local dashboard mirrors Cloudflare; no local meter polling')
    try:
        while not p.STOP.is_set():
            conn=http.client.HTTPSConnection(ENDPOINT,timeout=7)
            try:
                conn.request('GET','/api/status')
                response=conn.getresponse()
                if response.status!=200:raise ValueError('Cloudflare HTTP %s'%response.status)
                data=json.loads(response.read(2_000_000))
                if data.get('mode')!='live' or 'latest' not in data:raise ValueError('Invalid snapshot')
                cached[0]=data
                health.update(connected=True,last_success=dt.datetime.now().astimezone().isoformat())
            except (OSError,ValueError,http.client.HTTPException):
                p.LOG.exception('Cloudflare dashboard sync failed; retrying')
                health['connected']=False
            finally:conn.close()
            p.STOP.wait(15)
    finally:server.shutdown();server.server_close()


if __name__=='__main__':main()
