import datetime as dt
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import p1_reader as p
import p1_source

# Synthetic telegram; values and device identifier are test data.
SPLIT = '''/ISk5\\2MIE5T-200
0-0:1.0.0(261107205411)
1-0:1.8.0(001234.080*kWh)
1-0:2.8.0(000000.003*kWh)
1-0:21.7.0(00.000*kW)
1-0:41.7.0(01.502*kW)
1-0:61.7.0(00.141*kW)
1-0:32.7.0(227.0*V)
1-0:52.7.0(219.7*V)
1-0:72.7.0(221.9*V)
0-1:24.1.0((12345678))
0-1:24.2.1(261107205353)
0-1:24.2.1(1234.567*m3)
0-1:24.2.2(0000.156*m3/h)
0-1:24.2.3(000070.0*degC)
0-1:24.2.4(000030.0*degC)
0-1:24.2.5(0220.005*Wh)
!3A15
'''

class ParserTests(unittest.TestCase):
    def test_split_nonstandard_device(self):
        r=p.parse_telegram(SPLIT)
        self.assertEqual(r['hot_water_m3'],1234.567)
        self.assertEqual(r['mbus_timestamp'],'2026-11-07T20:53:53')
        self.assertEqual(r['flow_m3h'],.156)
        self.assertEqual((r['temp_supply_c'],r['temp_return_c']),(70.0,30.0))
        self.assertEqual(r['power_w'],1643)
        self.assertEqual(r['phase_power_w'],[0,1502,141])
        self.assertEqual(r['voltages'],[227,219.7,221.9])
    def test_standard_with_season_suffix(self):
        for suffix in ('W','S',''):
            text=SPLIT.replace('0-1:24.2.1(261107205353)\n0-1:24.2.1(1234.567*m3)', '0-1:24.2.1(261107205353%s)(1234.567*m3)'%suffix)
            r=p.parse_telegram(text)
            self.assertEqual(r['hot_water_m3'],1234.567)
            self.assertEqual(r['mbus_timestamp'],'2026-11-07T20:53:53'+suffix)
    def test_unknown_lines_and_checksum_ignored(self):
        self.assertEqual(p.parse_telegram(SPLIT.replace('!3A15','9-9:99.99.99(unknown)\n!BAD'))['hot_water_m3'],1234.567)
    def test_incomplete_or_empty_rejected(self):
        for text in ('', 'junk', SPLIT.split('!')[0], '/header\n!0000'):
            with self.assertRaises(ValueError):p.parse_telegram(text)
    def test_missing_water_is_not_zero(self):
        text='\n'.join(x for x in SPLIT.splitlines() if not x.startswith('0-1:'))
        r=p.parse_telegram(text)
        self.assertIsNone(r['hot_water_m3'])
        self.assertFalse(r['water_observed'])
    def test_malformed_water_and_date_do_not_crash(self):
        r=p.parse_telegram(SPLIT.replace('1234.567*m3','NaN*m3').replace('261107205353','269932205353'))
        self.assertIsNone(r['hot_water_m3'])
        self.assertIsNone(r['mbus_timestamp'])
    def test_public_meter_rejected_before_connect(self):
        with patch.object(p.socket,'getaddrinfo',return_value=[(2,1,6,'',('8.8.8.8',80))]),patch.object(p.http.client,'HTTPConnection') as conn:
            with self.assertRaises(ValueError):p.fetch_telegram({'p1_host':'example.com','http_timeout_seconds':1})
            conn.assert_not_called()
    def test_three_failed_attempts_then_recovers(self):
        stop=unittest.mock.Mock();stop.wait.return_value=False
        config={}
        with patch.object(p1_source,'fetch_telegram',side_effect=OSError('offline')) as fetch:
            self.assertIsNone(p.acquire(config,stop))
            self.assertEqual(fetch.call_count,3)
        with patch.object(p1_source,'fetch_telegram',return_value=SPLIT):
            self.assertEqual(p.acquire(config,stop)['hot_water_m3'],1234.567)

class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=p.Store(str(Path(self.tmp.name)/'readings.db'))
        self.today=dt.datetime.now().astimezone().date()
        self.config={'poll_interval_seconds':60,'hot_water_price_per_m3_isk':None}
    def tearDown(self):self.tmp.cleanup()
    def append(self,value,hour=1,days=0):
        r=p.parse_telegram(SPLIT)
        r['hot_water_m3']=value;r['timestamp']='%sT%02d:00:00+00:00'%(self.today-dt.timedelta(days=days),hour)
        self.store.append(r)
    def snapshot(self):return self.store.snapshot(self.config,{})
    def test_usage_cost_power_and_restart(self):
        self.append(100);self.append(102,2)
        self.assertEqual(self.snapshot()['summary']['today_m3'],2)
        self.assertIsNone(self.snapshot()['summary']['today_cost_isk'])
        self.config['hot_water_price_per_m3_isk']=10
        self.assertEqual(self.snapshot()['summary']['today_cost_isk'],20)
        self.assertAlmostEqual(self.snapshot()['summary']['heating_kw'],7.255733333333334,places=5)
        self.store=p.Store(self.store.path)
        self.assertEqual(self.snapshot()['reading_count'],2)
    def test_veitur_cost_uses_tax_inclusive_volume_rate_without_fixed_fee(self):
        self.config['veitur_tariff']='H1'
        self.append(100);self.append(102,2)
        data=self.snapshot()
        self.assertEqual(data['pricing']['price_per_m3_isk'],227.56)
        self.assertEqual(data['summary']['today_cost_isk'],455.12)
        self.assertEqual(data['daily'][0]['usage_cost_isk'],455.12)
        self.assertEqual(data['summary']['current_cost_per_hour_isk'],35.5)
        self.assertIsNone(data['pricing']['fixed_per_day_isk'])
        self.assertIsNone(data['summary']['yesterday_cost_isk'])
        hour=next(w for w in data['water_usage']['intervals'] if w['minutes']==60)
        self.assertEqual(hour['usage_cost_isk'],455.12)
        self.assertIsNone(next(w for w in data['water_usage']['intervals'] if w['minutes']==1440)['usage_cost_isk'])
        self.config['veitur_meter_class']='A'
        data=self.snapshot()
        self.assertEqual(data['pricing']['fixed_per_day_isk'],101.90)
        self.assertEqual(data['summary']['today_cost_isk'],455.12)
    def test_rural_tariff_custom_override_and_missing_cost(self):
        self.config.update(veitur_tariff='J1',veitur_meter_class='B')
        self.append(100);self.append(101,2)
        data=self.snapshot()
        self.assertEqual(data['summary']['today_cost_isk'],300.29)
        self.assertEqual(data['pricing']['fixed_per_day_isk'],479.50)
        self.config['hot_water_price_per_m3_isk']=42
        data=self.snapshot()
        self.assertEqual(data['pricing']['basis'],'custom')
        self.assertEqual(data['summary']['today_cost_isk'],42)
        self.config.update(hot_water_price_per_m3_isk=None,veitur_tariff=None)
        self.assertIsNone(self.snapshot()['summary']['today_cost_isk'])

    def test_trend_cost_summary_uses_counter_total_before_rounding(self):
        self.config['veitur_tariff']='H1'
        self.append(100);self.append(102,2)
        trend=self.snapshot()['water_usage']['trends']['1h']
        self.assertEqual(trend['total']['volume_m3'],2)
        self.assertEqual(trend['total']['usage_cost_isk'],455.12)
        self.assertTrue(all(r['usage_cost_isk'] is not None for r in trend['points']))
        self.assertEqual(trend['interval_minutes'],1)

    def test_estimated_gap_cost_does_not_insert_readings(self):
        self.config['veitur_tariff']='H1'
        self.append(100);self.append(102,2)
        data=self.snapshot()
        minute=next(w for w in data['water_usage']['intervals'] if w['minutes']==1)
        self.assertTrue(minute['estimated'])
        self.assertEqual(minute['usage_cost_isk'],round(minute['volume_m3']*227.56,2))
        self.assertEqual(data['reading_count'],2)
        self.assertFalse(data['usage_quality']['today_estimated'])

    def test_missing_water_retained_but_not_counted(self):
        self.append(100)
        r=p.parse_telegram('\n'.join(x for x in SPLIT.splitlines() if not x.startswith('0-1:')))
        r['timestamp']=str(self.today)+'T03:00:00+00:00';self.store.append(r)
        data=self.snapshot()
        self.assertEqual(data['latest']['hot_water_m3'],100)
        self.assertEqual(data['daily'][0]['samples'],1)
        self.assertIsNone(data['summary']['today_m3'])
    def test_repeated_hourly_readings_are_valid(self):
        self.append(100);self.append(100,2)
        self.assertEqual(self.snapshot()['summary']['today_m3'],0)
    def test_reset_does_not_produce_negative_usage(self):
        self.append(100);self.append(1,2)
        self.assertIsNone(self.snapshot()['summary']['today_m3'])
        self.assertTrue(self.snapshot()['daily'][0]['reset'])
    def test_yesterday_and_insufficient_week(self):
        self.append(90,1,1);self.append(94,2,1)
        self.assertEqual(self.snapshot()['summary']['yesterday_m3'],4)
        self.assertIsNone(self.snapshot()['summary']['seven_days_m3'])
    def test_seven_days_includes_midnight_changes(self):
        for days in range(6,-1,-1):
            self.append(100 + (6-days)*10,1,days)
            self.append(102 + (6-days)*10,2,days)
        self.assertEqual(self.snapshot()['summary']['seven_days_m3'],62)
        self.assertEqual(sum(d['volume_m3'] for d in self.snapshot()['daily'][:7]),62)
        self.assertTrue(any(d['estimated'] for d in self.snapshot()['daily'][:7]))

    def test_live_stream_delivers_new_readings_without_reloading(self):
        self.append(100)
        server=p.serve(self.store,dict(self.config,dashboard_port=0),{'connected':True})
        threading.Thread(target=server.serve_forever,daemon=True).start()
        conn=p.http.client.HTTPConnection('127.0.0.1',server.server_address[1],timeout=6)
        response=None
        try:
            conn.request('GET','/api/events',headers={'Host':'localhost'})
            response=conn.getresponse()
            self.assertEqual(response.status,200)
            self.assertTrue(response.getheader('Content-Type').startswith('text/event-stream'))
            self.assertEqual(response.getheader('Cache-Control'),'no-store')
            self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
            def next_reading():
                while True:
                    line=response.readline()
                    if not line:raise AssertionError('Stream closed before a reading arrived')
                    if line.startswith(b'data: '):return json.loads(line[6:])
            first=next_reading()
            self.assertEqual(first['latest']['hot_water_m3'],100)
            self.assertEqual(first['frontend_version'],p.frontend_version())
            self.append(101,2)
            second=next_reading()
            self.assertEqual(second['latest']['hot_water_m3'],101)
            self.assertEqual(second['reading_count'],2)
        finally:
            if response:response.close()
            conn.close();server.shutdown();server.server_close()

    def test_served_html_and_api_share_frontend_version(self):
        server=p.serve(self.store,dict(self.config,dashboard_port=0),{})
        threading.Thread(target=server.serve_forever,daemon=True).start()
        conn=p.http.client.HTTPConnection('127.0.0.1',server.server_address[1],timeout=5)
        try:
            conn.request('GET','/',headers={'Host':'localhost'})
            response=conn.getresponse();html=response.read().decode()
            self.assertEqual(response.status,200)
            self.assertIn('content="'+p.frontend_version()+'"',html)
            self.assertNotIn('__FRONTEND_VERSION__',html)
        finally:conn.close();server.shutdown();server.server_close()

    def test_server_binds_only_loopback_and_rejects_other_hosts(self):
        config=dict(self.config,dashboard_port=0)
        server=p.serve(self.store,config,{})
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            self.assertEqual(server.server_address[0],'127.0.0.1')
            conn=p.http.client.HTTPConnection('127.0.0.1',server.server_address[1])
            conn.request('GET','/api/status',headers={'Host':'evil.example'})
            self.assertEqual(conn.getresponse().status,403);conn.close()
            conn=p.http.client.HTTPConnection('127.0.0.1',server.server_address[1])
            conn.request('GET','/api/status',headers={'Host':'localhost'})
            res=conn.getresponse();self.assertEqual(res.status,200)
            self.assertIsNone(res.getheader('Access-Control-Allow-Origin'))
            json.loads(res.read());conn.close()
        finally:server.shutdown();server.server_close()

class WindowTests(unittest.TestCase):
    def rows(self, offsets, values):
        base=dt.datetime(2026,11,7,12,tzinfo=dt.timezone.utc)
        return [{'timestamp':(base+dt.timedelta(seconds=t)).isoformat(), 'hot_water_m3':v} for t,v in zip(offsets,values)]
    def interval(self, result, minutes):
        return next(r for r in result['intervals'] if r['minutes']==minutes)
    def test_minute_and_five_minute_usage_and_average(self):
        rows=self.rows([0,60,120,180,240,300],[100,100.002,100.004,100.006,100.008,100.010])
        result=p.water_windows(rows,60)
        self.assertEqual(self.interval(result,1)['volume_m3'],.002)
        self.assertEqual(self.interval(result,5)['volume_m3'],.010)
        self.assertAlmostEqual(self.interval(result,5)['average_m3h'],.120)
        self.assertEqual(self.interval(result,15)['status'],'insufficient')
        series=result['series']['1']
        self.assertEqual(len(series),24)
        self.assertEqual(sum(w['volume_m3'] is not None for w in series),5)
        self.assertEqual(series[-1]['duration_seconds'],60)
    def test_closed_gap_is_apportioned_and_marked_estimated(self):
        result=p.water_windows(self.rows([0,600],[100,100.1]),60)
        self.assertEqual(self.interval(result,1)['volume_m3'],.01)
        self.assertEqual(self.interval(result,5)['volume_m3'],.05)
        self.assertEqual(self.interval(result,1)['status'],'estimated')
        self.assertTrue(self.interval(result,5)['estimated'])
        self.assertEqual(result['gap_count'],1)
        self.assertEqual(result['gaps'][0]['volume_m3'],.1)
        self.assertEqual(result['gaps'][0]['status'],'measured')
        self.assertIsNone(self.interval(result,15)['volume_m3'])
        known=[w for w in result['series']['1'] if w['volume_m3'] is not None]
        self.assertEqual(len(known),10)
        self.assertAlmostEqual(sum(w['volume_m3'] for w in known),.1)

    def test_trend_ranges_preserve_totals_and_missing_history(self):
        result=p.water_windows(self.rows([0,3600],[100,103.6]),60)
        self.assertEqual(set(result['trends']),set(p.TREND_RANGES))
        for key,(_,count) in p.TREND_RANGES.items():
            self.assertEqual(len(result['trends'][key]['points']),count)
        hour=result['trends']['1h']
        self.assertEqual(hour['total']['volume_m3'],3.6)
        self.assertFalse(hour['total']['estimated'])
        self.assertAlmostEqual(sum(r['volume_m3'] for r in hour['points']),3.6)
        self.assertTrue(all(r['estimated'] for r in hour['points']))
        three=result['trends']['3h']
        self.assertIsNone(three['total']['volume_m3'])
        self.assertEqual(sum(r['volume_m3'] is not None for r in three['points']),12)

    def test_open_gap_and_before_history_are_not_extrapolated(self):
        history=p.CounterHistory(self.rows([0,60],[100,101]),60)
        self.assertIsNone(history.boundary(history.times[0]-1))
        self.assertIsNone(history.boundary(history.times[-1]+600))
        self.assertIsNone(history.window(1,history.times[-1]+600)['volume_m3'])

    def test_exact_endpoints_keep_whole_gap_total_measured(self):
        history=p.CounterHistory(self.rows([0,600],[100,100.1]),60)
        whole=history.window(10,history.times[-1])
        self.assertEqual(whole['volume_m3'],.1)
        self.assertFalse(whole['estimated'])
        self.assertAlmostEqual(whole['average_m3h'],.6)

    def test_gap_allocation_across_midnight_conserves_total(self):
        rows=[{'timestamp':'2026-11-05T12:00:00+00:00','hot_water_m3':100},
              {'timestamp':'2026-11-08T12:00:00+00:00','hot_water_m3':172}]
        history=p.CounterHistory(rows,60)
        days=[history.day(dt.date(2026,11,d)) for d in range(5,9)]
        self.assertEqual([d['volume_m3'] for d in days],[12,24,24,12])
        self.assertEqual(sum(d['volume_m3'] for d in days),72)
        self.assertTrue(all(d['estimated'] for d in days))
        self.assertEqual(days[1]['samples'],0)

    def test_reset_inside_gap_is_not_interpolated(self):
        history=p.CounterHistory(self.rows([0,600],[100,1]),60)
        part=history.window(1,history.times[-1])
        self.assertIsNone(part['volume_m3'])
        self.assertEqual(part['status'],'reset')
        self.assertIsNone(history.gaps()[0]['volume_m3'])

    def test_unchanged_hourly_meter_is_not_a_polling_gap(self):
        result=p.water_windows(self.rows([0,60,120,180],[100,100,100,100]),60)
        self.assertEqual(result['gap_count'],0)
        self.assertEqual(self.interval(result,1)['status'],'measured')
        self.assertEqual(self.interval(result,1)['volume_m3'],0)
    def test_unchanged_counter_is_measured_zero(self):
        result=p.water_windows(self.rows([0,60],[100,100]),60)
        self.assertEqual(self.interval(result,1)['volume_m3'],0)
        self.assertEqual(self.interval(result,1)['status'],'measured')
    def test_counter_reset_invalidates_window_even_if_it_recovers(self):
        result=p.water_windows(self.rows([0,60,300],[100,1,101]),60)
        self.assertEqual(self.interval(result,5)['status'],'reset')
        self.assertIsNone(self.interval(result,5)['volume_m3'])
    def test_empty_history_and_actual_boundary_duration(self):
        self.assertIsNone(p.water_windows([],60)['as_of'])
        result=p.water_windows(self.rows([0,61,122,183,244,305],[100,101,102,103,104,105]),60)
        interval=self.interval(result,5)
        self.assertEqual(interval['duration_seconds'],305)
        self.assertEqual(interval['volume_m3'],5)
        self.assertAlmostEqual(interval['average_m3h'],5*3600/305)

if __name__=='__main__':unittest.main()
