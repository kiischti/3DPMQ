/** Browser test of the 3D viewer (Playwright/Chromium, software WebGL). Run: npx tsx test/preview-ui.ts */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { modelGcode } from './make-model.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 3913, BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-pv-'));
const shots = path.resolve('test/shots'); fs.mkdirSync(shots, { recursive: true });
let fail = 0;
const ok = (c: unknown, m: string) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/server.ts'],
  { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STAFF_PASSWORD: 'pw', POLL_MS: '60000' }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { if ((await fetch(BASE + '/api/config').catch(() => null))?.ok) break; await sleep(250); }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  // set up: staff login, one printer, one request with a recognisable model
  const login = await ctx.request.post(`${BASE}/api/staff/login`, { data: { password: 'pw', name: 'T' } });
  ok(login.ok(), 'staff login');
  await ctx.request.post(`${BASE}/api/staff/printers`, { data: { name: 'P', base_url: 'http://localhost:9', model: 'MK4S', nozzle: 0.4 } });
  const cfg = await (await ctx.request.get(`${BASE}/api/config`)).json();
  const fil = cfg.filaments.find((f: any) => f.material === 'PLA');
  const sub = await ctx.request.post(`${BASE}/api/requests`, { multipart: {
    file: { name: 'model.gcode', mimeType: 'text/plain', buffer: Buffer.from(modelGcode({ metadata: true })) },
    name: 'Alice Example', email: 'alice@example.org', class: '2CE', filamentId: String(fil.id) } });
  const created = await sub.json();
  ok(sub.status() === 201, `request created (#${created.id})`);

  // the viewer
  await page.goto(`${BASE}/preview.html?id=${created.id}`);
  await page.waitForFunction(() => (window as any).__preview, null, { timeout: 30000 });
  await page.waitForSelector('#legend:not([hidden])');
  ok(true, 'viewer started (WebGL2 available, data loaded)');
  ok((await page.locator('#title').innerText()).includes('model.gcode'), 'title shows the file');
  ok((await page.locator('#legend label').count()) === 3, 'legend lists the 3 feature types');
  const info = await page.locator('#info').innerText();
  ok(/60\.0 × 20\.0 × 2\.0 mm/.test(info) && /10 layers/.test(info) && /1,?660 moves/.test(info), `info panel: ${info.replace(/\s+/g, ' ')}`);

  // pixel statistics straight from the GL canvas (read inside the same task as the draw call)
  const stat = (extra = '') => page.evaluate(() => {
    const p = (window as any).__preview; p.draw();
    const c = document.getElementById('gl') as HTMLCanvasElement, g = c.getContext('webgl2')!;
    const w = c.width, h = c.height, px = new Uint8Array(w * h * 4); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    let lit = 0, sum = 0; const bg = [18, 22, 28];
    for (let i = 0; i < px.length; i += 4) {
      const d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
      if (d > 60) { lit++; sum = (sum * 31 + (i >> 2) * (px[i] + 3 * px[i + 1] + 7 * px[i + 2])) % 1000003; }
    }
    return { lit, hash: sum, az: p.az, el: p.el, dist: p.dist };
  });
  const s0 = await stat();
  ok(s0.lit > 3000, `the model is drawn (${s0.lit} coloured pixels)`);
  await page.screenshot({ path: `${shots}/preview-1-start.png` });

  // rotate with the mouse: hold, move, release
  await page.mouse.move(400, 300); await page.mouse.down(); await page.mouse.move(520, 330, { steps: 8 }); await page.mouse.up();
  await sleep(150);
  const s1 = await stat();
  ok(Math.abs(s1.az - s0.az) > 0.5 && s1.el !== s0.el, `dragging rotates the view (azimuth ${s0.az.toFixed(2)} → ${s1.az.toFixed(2)}, elevation ${s0.el.toFixed(2)} → ${s1.el.toFixed(2)})`);
  ok(s1.hash !== s0.hash, 'and the picture really changes');
  await page.screenshot({ path: `${shots}/preview-2-rotated.png` });

  // zoom with the wheel
  await page.mouse.move(480, 270); await page.mouse.wheel(0, -400); await sleep(150);
  const s2 = await stat();
  ok(s2.dist < s1.dist * 0.8, `wheel zooms in (distance ${s1.dist.toFixed(0)} → ${s2.dist.toFixed(0)})`);
  await page.mouse.dblclick(480, 270); await sleep(150);
  const s3 = await stat();
  ok(Math.abs(s3.az - s0.az) < 1e-6 && Math.abs(s3.dist - s0.dist) < 1e-3, 'double-click resets the view');

  // shift-drag pans (the camera target moves, the angles do not)
  await page.keyboard.down('Shift'); await page.mouse.move(400, 300); await page.mouse.down(); await page.mouse.move(460, 300, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Shift'); await sleep(150);
  const s4 = await stat();
  ok(Math.abs(s4.az - s0.az) < 1e-6 && s4.hash !== s0.hash, 'shift-drag moves the model without rotating it');
  await page.mouse.dblclick(480, 270); await sleep(100);

  // layer slider and feature toggles hide geometry
  await page.locator('#layer').fill('3'); await sleep(150);
  const sl = await stat();
  ok(sl.lit < s0.lit * 0.6 && /Layer 3 \/ 10/.test(await page.locator('#layerlabel').innerText()), `layer slider: 3 of 10 layers show fewer pixels (${sl.lit} < ${s0.lit})`);
  await page.screenshot({ path: `${shots}/preview-3-layer3.png` });
  await page.locator('#layer').fill('10'); await page.keyboard.press('ArrowDown'); await sleep(100);
  ok(/Layer 9 \/ 10/.test(await page.locator('#layerlabel').innerText()), 'arrow keys step through the layers');
  await page.keyboard.press('End'); await sleep(100);
  await page.locator('#legend input[data-t="1"]').uncheck(); await sleep(150);
  const st = await stat();
  ok(st.lit < s0.lit, `hiding "Internal infill" removes pixels (${st.lit} < ${s0.lit})`);
  await page.locator('#legend input[data-t="1"]').check();
  await page.selectOption('#mode', '1'); await sleep(150);
  const sm = await stat();
  ok(sm.hash !== s0.hash, 'colour by height changes the picture');
  await page.screenshot({ path: `${shots}/preview-4-height.png` });

  // missing / unauthorised
  const anon = await browser.newContext(); const ap = await anon.newPage();
  await ap.goto(`${BASE}/preview.html?id=${created.id}`);
  await ap.waitForFunction(() => /log in as staff/i.test(document.getElementById('msg')?.textContent ?? ''), null, { timeout: 10000 });
  ok(true, 'without staff login the viewer asks to log in');
  await ap.goto(`${BASE}/preview.html?id=9999`);
  ap.on('dialog', () => {});
  ok(errors.filter((e) => !/401|404|422/.test(e)).length === 0, `no JavaScript errors${errors.length ? ' (' + errors.join(' | ') + ')' : ''}`);
} catch (e) { fail++; console.error('PREVIEW TEST CRASHED', e, errors); }
finally { await browser.close(); srv.kill(); console.log(fail ? `\n${fail} failed` : '\nViewer test passed'); process.exit(fail ? 1 : 0); }
