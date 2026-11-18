import { execFileSync } from 'node:child_process';
import project from '../cloudflare.config.ts';
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
// Vite roots its Build Output under web/.cloudflare; cf deploy reads the project root.
mkdirSync('.cloudflare/output', { recursive: true });
rmSync('.cloudflare/output/v0', { recursive: true, force: true });
cpSync('web/.cloudflare/output/v0', '.cloudflare/output/v0', { recursive: true });

const worker = JSON.parse(readFileSync('.cloudflare/output/v0/workers/default/worker.config.json', 'utf8'));
if (worker.name !== project.worker.name) throw new Error('Refusing deployment: generated Worker name differs from project configuration');

