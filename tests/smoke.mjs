import { serve, open } from './lib.mjs';
const srv = await serve();
try {
  const t0 = Date.now();
  const { browser, page, errors } = await open(srv.url, process.argv[2] ?? 'test=1', { width: 640, height: 360 });
  console.log('boot ms', Date.now() - t0);
  const info = () => page.evaluate(() => { const g = window.__rb; return { state: g.state, pos: g.player.pos.toArray().map((v) => +v.toFixed(2)), grounded: g.player.grounded, paintables: g.paint.all.length, fps: +g.fps.toFixed(1), calls: g.stage.renderer.info.render.calls, tris: g.stage.renderer.info.render.triangles }; });
  await page.waitForTimeout(3000);
  console.log(JSON.stringify(await info()));
  console.log('errors:', errors);
  await page.screenshot({ path: 'tests/out/menu.png', timeout: 120000 });
  await page.evaluate(() => window.__rb.start('new'));
  await page.waitForTimeout(3000);
  console.log(JSON.stringify(await info()));
  await page.screenshot({ path: 'tests/out/start.png', timeout: 120000 });
  console.log('errors:', errors);
  await browser.close();
} finally { srv.stop(); }
