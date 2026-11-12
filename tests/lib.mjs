// Shared helpers for the headless test scripts.
import { createRequire } from 'node:module';
// Playwright is resolved CommonJS-style so a globally installed copy works too.
const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';

export async function serve(port = 4173) {
  const url = `http://localhost:${port}`;
  // reuse a server that is already running (e.g. `npm run preview` in another shell)
  try { if ((await fetch(url)).ok) return { url, stop() {} }; } catch { /* not running */ }
  const proc = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('preview server did not start')), 20000);
    proc.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(t); res(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
  return { url, stop: () => proc.kill() };
}

export async function open(url, query = 'test=1', size = { width: 1280, height: 720 }) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: size });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${url}/?${query}`);
  await page.waitForFunction(() => window.__rb && window.__rb.state === 'menu', null, { timeout: 180000 });
  return { browser, page, errors };
}
