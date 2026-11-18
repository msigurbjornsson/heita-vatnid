#!/usr/bin/env python3
"""Idempotently copy saved local readings to the Cloudflare database via ingestion."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from p1_relay import post_batch
root=Path(__file__).resolve().parents[1]
config=json.loads((root/'data/private/relay.config.json').read_text())
path=Path(sys.argv[1]) if len(sys.argv)>1 else root/'data/migration-backup/mac-before-cloud.db'
db=sqlite3.connect('file:'+str(path.resolve())+'?mode=ro&immutable=1',uri=True);db.row_factory=sqlite3.Row
batch=[];total=0
for row in db.execute('SELECT * FROM readings ORDER BY timestamp,id'):
    reading=dict(row);row_id=reading.pop('id')
    for key in ('voltages','currents'):reading[key]=json.loads(reading[key])
    identifier=hashlib.sha256(('mac-history:'+str(row_id)+':'+reading['timestamp']).encode()).hexdigest()
    batch.append({'source_id':identifier,'collector_id':'mac-history','reading':reading})
    if len(batch)==50:post_batch(config,batch);total+=len(batch);batch=[]
if batch:post_batch(config,batch);total+=len(batch)
print('Historical readings acknowledged:',total)
