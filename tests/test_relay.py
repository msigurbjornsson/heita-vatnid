import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import p1_relay as relay
from test_p1_reader import SPLIT
from p1_source import parse_telegram

class QueueTests(unittest.TestCase):
    def test_restart_preserves_stable_id_until_ack(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'queue.db'
            q=relay.Outbox(path)
            r=parse_telegram(SPLIT);r['timestamp']='2026-11-08T12:00:00+00:00'
            identifier=q.put(r,'ucg-fiber')
            q=relay.Outbox(path)
            self.assertEqual(q.batch()[0]['source_id'],identifier)
            self.assertEqual(q.count(),1)
            q.ack([identifier]);q.ack([identifier])
            self.assertEqual(q.count(),0)
    def test_failure_retains_batch_then_recovery_removes_it(self):
        with tempfile.TemporaryDirectory() as folder:
            q=relay.Outbox(Path(folder)/'queue.db');q.put({'timestamp':'t'},'ucg-fiber')
            relay.STOP.clear()
            def wait(_):
                self.assertEqual(q.count(),1)
                return False
            def success(config,batch):
                relay.STOP.set()
                return {item['source_id'] for item in batch}
            with patch.object(relay,'post_batch',side_effect=[OSError('offline'),success]) as upload:
                # Callable side effects are explicitly invoked by this adapter.
                upload.side_effect=[OSError('offline')]
                calls=[0]
                def attempt(config,batch):
                    calls[0]+=1
                    if calls[0]==1:raise OSError('offline')
                    return success(config,batch)
                upload.side_effect=attempt
                with patch.object(relay.STOP,'wait',side_effect=wait):relay.upload_loop({},q)
            self.assertEqual(q.count(),0)
            relay.STOP.clear()

    def test_restart_respects_persisted_poll_interval(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'queue.db'
            q=relay.Outbox(path)
            with patch.object(relay.time,'time',return_value=1000),patch.object(relay.STOP,'wait',return_value=False):
                self.assertTrue(q.wait_for_poll(60))
            q=relay.Outbox(path)
            with patch.object(relay.time,'time',return_value=1001),patch.object(relay.STOP,'wait',return_value=False) as wait:
                self.assertTrue(q.wait_for_poll(60))
                wait.assert_called_once_with(59)

    def test_two_half_minute_readings_upload_together_after_sixty_seconds(self):
        with tempfile.TemporaryDirectory() as folder:
            q=relay.Outbox(Path(folder)/'queue.db')
            clock=[0]
            relay.STOP.clear()
            def wait(seconds):
                clock[0]+=seconds
                q.put({'timestamp':'2026-11-08T12:00:00Z'},'test')
                q.put({'timestamp':'2026-11-08T12:00:30Z'},'test')
                return False
            def post(config,batch):
                self.assertEqual(clock[0],60)
                self.assertEqual(len(batch),2)
                relay.STOP.set()
                return {i['source_id'] for i in batch}
            with patch.object(relay.time,'monotonic',side_effect=lambda:clock[0]),patch.object(relay.STOP,'wait',side_effect=wait),patch.object(relay,'post_batch',side_effect=post) as send:
                relay.upload_loop({'upload_interval_seconds':60},q)
                send.assert_called_once()
            self.assertEqual(q.count(),0)
            relay.STOP.clear()
