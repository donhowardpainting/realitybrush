// Dev helper: node tests/eval.mjs <script.js> [query] [screenshot.png] [WxH]
// Evaluates a script inside the running game (test mode) and prints its JSON result.
import { readFileSync } from 'node:fs';
import { serve, open } from './lib.mjs';
const [file, query = 'test=1', shot, size = '640x360'] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
const srv = await serve();
const { browser, page, errors } = await open(srv.url, query, { width, height });
try {
  const src = readFileSync(file, 'utf8');
  const res = await page.evaluate(`(async () => { const g = window.__rb; ${src} })()`);
  console.log(JSON.stringify(res, null, 1));
  if (shot) { await page.waitForTimeout(1200); await page.screenshot({ path: shot, timeout: 300000 }); }
  if (errors.length) console.log('ERRORS', errors);
} finally { await browser.close(); srv.stop(); }
