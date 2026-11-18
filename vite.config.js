import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import project from './cloudflare.config.ts';
export default defineConfig({
  root: 'web',
  plugins: [cloudflare({ config: loaded => ({ ...loaded, ...project, worker: { ...loaded.worker, ...project.worker } }) })],
  build: { outDir: '../dist', emptyOutDir: true }
});
