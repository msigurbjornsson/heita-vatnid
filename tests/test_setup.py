import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('setup_helper', Path(__file__).resolve().parents[1]/'scripts/setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

class SetupTests(unittest.TestCase):
    def test_local_private_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(setup,'ROOT',Path(tmp)), patch('sys.stdout',new_callable=io.StringIO):
            setup.main(['--host','192.168.1.100','--non-interactive'])
            path=Path(tmp)/'config.json'
            self.assertEqual(json.loads(path.read_text())['p1_host'],'192.168.1.100')
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            with patch('sys.stderr',new_callable=io.StringIO), self.assertRaises(SystemExit):
                setup.main(['--host','192.168.1.101','--non-interactive'])
            self.assertEqual(json.loads(path.read_text())['p1_host'],'192.168.1.100')

    def test_cloud_preserves_local_and_matches_secret(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(setup,'ROOT',Path(tmp)), patch('sys.stdout',new_callable=io.StringIO):
            setup.main(['--host','192.168.1.100','--non-interactive'])
            before=(Path(tmp)/'config.json').read_bytes()
            answers=['0'*32,'00000000-0000-0000-0000-000000000001','my-dashboard','https://my-dashboard.example.com/ingest']
            with patch('builtins.input',side_effect=answers):setup.main(['--cloud','--host','192.168.1.100'])
            private=Path(tmp)/'data/private'
            secret=json.loads((private/'worker-secrets.json').read_text())['WRITE_TOKEN']
            self.assertGreater(len(secret),40)
            self.assertEqual(secret,json.loads((private/'relay.config.json').read_text())['write_token'])
            self.assertEqual(before,(Path(tmp)/'config.json').read_bytes())
            for file in private.iterdir():self.assertEqual(file.stat().st_mode & 0o777,0o600)

    def test_private_host(self):
        self.assertEqual(setup.private_host('meter.local'),'meter.local')
        for bad in ['8.8.8.8','https://192.168.1.100','192.168.1.100/api','192.168.1.100:80','999.1.1.1']:
            with self.assertRaises(ValueError):setup.private_host(bad)
