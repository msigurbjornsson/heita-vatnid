import json
from pathlib import Path
import sqlite3
import subprocess
import unittest

class CalendarSQLTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script="import {comparisonQuery} from './cloud/comparisons.js'; console.log(JSON.stringify(Object.fromEntries(['day','week','month'].map(k=>[k,comparisonQuery(k)]))));"
        cls.queries=json.loads(subprocess.check_output(['node','--input-type=module','-e',script],cwd=Path(__file__).resolve().parents[1],text=True))
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        self.db.execute('CREATE TABLE readings(seq INTEGER PRIMARY KEY,timestamp TEXT,water_observed INTEGER,hot_water_m3 REAL)')
    def tearDown(self):self.db.close()
    def test_sql_aggregates_week_month_and_excludes_missing_water(self):
        rows=[('2026-11-01T00:00:00.000Z',1,100),('2026-11-01T23:59:30.000Z',1,102),('2026-11-02T00:00:00.000Z',1,102),('2026-11-02T12:00:00.000Z',0,0),('2026-11-02T23:59:30.000Z',1,105)]
        self.db.executemany('INSERT INTO readings(timestamp,water_observed,hot_water_m3) VALUES(?,?,?)',rows)
        for unit,count in [('day',2),('week',2),('month',1)]:
            result=list(self.db.execute(self.queries[unit],('2026-10-01','2026-12-01')))
            self.assertEqual(len(result),count)
            self.assertEqual(sum(r['samples'] for r in result),4)
            self.assertEqual(sum(r['resets'] for r in result),0)
        month=self.db.execute(self.queries['month'],('2026-10-01','2026-12-01')).fetchone()
        self.assertEqual(month['last_m3']-month['first_m3'],5)
        week=list(self.db.execute(self.queries['week'],('2026-10-01','2026-12-01')))
        self.assertEqual([r['bucket'] for r in week],['2026-10-26','2026-11-02'])
    def test_reset_inside_period_is_detected_even_after_counter_recovers(self):
        rows=[('2026-11-02T00:00:00.000Z',1,100),('2026-11-02T05:00:00.000Z',1,110),('2026-11-02T06:00:00.000Z',1,90),('2026-11-02T23:59:30.000Z',1,120)]
        self.db.executemany('INSERT INTO readings(timestamp,water_observed,hot_water_m3) VALUES(?,?,?)',rows)
        result=self.db.execute(self.queries['day'],('2026-11-01','2026-12-01')).fetchone()
        self.assertEqual(result['resets'],1)
