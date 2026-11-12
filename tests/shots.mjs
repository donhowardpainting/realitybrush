// Dev helper: capture high-quality screenshots from named viewpoints.
// usage: node tests/shots.mjs [names,comma,separated] [extra-js-file]
import { readFileSync } from 'node:fs';
import { serve, open } from './lib.mjs';
const VIEWS = {
  lab: [0, 0, 17.5, 0, 0],
  courtyard: [0, 0, 7, 0, 0.12],
  mass: [7, 0, -3, 0.65, 0.1],
  balcony: [0, 8, -18, Math.PI, -0.25],
  breach: [0, 8, -35.5, 0, -0.35],
  spillway: [0, 6.5, -58, 0, -0.3],
  plaza: [0, 0, -97, 0, 0.15],
  hall: [0, 0, -116, 0.15, 0.2],
  hall2: [10, 0, -150, 1.2, 0.25],
  deck: [-12, 8, -163, -1.4, -0.1],
  greenhouse: [23, 0, -139, -1.57, 0.1],
  roof: [10, 19, -150, 0.35, 0.3],
  tower: [0, 19, -190.5, 0, 0.5],
  towerup: [9, 43, -198, 1.57, -0.1],
  sandbox: [300, 0, 21, 0, 0.05],
};
const names = (process.argv[2] ?? Object.keys(VIEWS).join(',')).split(',');
const extra = process.argv[3] ? readFileSync(process.argv[3], 'utf8') : '';
const srv = await serve();
const { browser, page, errors } = await open(srv.url, process.argv[4] ?? 'test=1&quality=high&bake=1', { width: 1280, height: 720 });
try {
  await page.evaluate(`(async () => { const g = window.__rb; g.start('new'); g.simulate(0.5); ${extra} })()`);
  for (const n of names) {
    const v = VIEWS[n];
    await page.evaluate(([x, y, z, yaw, pitch]) => {
      const g = window.__rb, V = g.player.pos.constructor;
      g.player.teleport(new V(x, y, z), yaw); g.player.pitch = pitch; g.player.frozen = true; g.stage.fade = 0; g.stage.fadeTarget = 0;
    }, v);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `tests/out/${n}.png`, timeout: 300000 });
    console.log('shot', n);
  }
  if (errors.length) console.log('ERRORS', errors);
} finally { await browser.close(); srv.stop(); }
