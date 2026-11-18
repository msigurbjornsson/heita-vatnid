import { readFileSync, existsSync } from 'node:fs';
import { bindings, defineConfig, triggers } from 'cf/config';
const path = new URL('./data/private/cloudflare.json', import.meta.url);
if (!existsSync(path)) throw new Error('Cloud hosting is optional. Run python3 scripts/setup.py --cloud first; for local-only use python3 p1_reader.py.');
const settings = JSON.parse(readFileSync(path, 'utf8'));
export default defineConfig({
 accountId: settings.account_id,
 worker: {
  name: settings.worker_name, workersDev: true, compatibilityDate: '2026-11-08',
  entrypoint: './cloud/worker.js',
  triggers: [triggers.scheduled({schedule:'* * * * *'})],
  assets: {runWorkerFirst:true,notFoundHandling:'single-page-application'},
  env: {ASSETS:bindings.assets(),DB:bindings.d1({id:settings.database_id})},
  observability:{enabled:true,redactQueryString:true,logs:{enabled:true},traces:{enabled:true,headSamplingRate:0.1}}
 }
});
