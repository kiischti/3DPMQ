/** Browser smoke test (Playwright/Chromium): drives the real UI and saves screenshots to test/shots. Run: npx tsx test/ui.ts */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startMock } from '../mock/mock-prusalink.js';
import { writeSamples } from './make-samples.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 3912, BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-ui-'));
const samples = writeSamples(path.join(dataDir, 'samples'));
const shots = path.resolve('test/shots'); fs.mkdirSync(shots, { recursive: true });
let fail = 0;
const ok = (c: unknown, m: string) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const m1 = await startMock(8081, { printSeconds: 20 });
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/server.ts'],
  { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STAFF_PASSWORD: 'pw', POLL_MS: '500' }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { if ((await fetch(BASE + '/api/config').catch(() => null))?.ok) break; await sleep(250); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d: any) => d.accept('Not enough detail')); // confirm()/prompt()

try {
  // staff setup through the UI: login, add a printer, load filament
  await page.goto(`${BASE}/#/staff`);
  await page.fill('#sn', 'Philippe'); await page.fill('#sp', 'pw'); await page.click('#login button');
  await page.waitForSelector('text=logged in as Philippe');
  await page.click('button[data-t=printers]');
  await page.waitForSelector('text=Add printer');
  const form = page.locator('form[data-form=printer][data-id=""]');
  await form.locator('[name=name]').fill('MK4S-Lab');
  await form.locator('[name=base_url]').fill('http://localhost:8081');
  await form.locator('[name=password]').fill('test');
  await form.locator('[name=model]').fill('MK4S');
  await form.locator('[data-act=ptest]').click();
  await page.waitForSelector('text=connected, state IDLE');
  ok(true, 'UI: printer connection test shows IDLE');
  await form.locator('button.primary').click();
  await page.waitForSelector('h3:has-text("MK4S-Lab")');
  await page.locator('select[data-act=loaded]').selectOption({ label: 'PLA Red' });
  await page.screenshot({ path: `${shots}/staff-printers.png` });

  // user flow in a fresh context (no staff cookie)
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const user = await ctx.newPage();
  user.on('pageerror', (e: Error) => errors.push('user: ' + e.message));
  user.on('console', (m: any) => { if (m.type() === 'error') errors.push('user: ' + m.text()); });
  await user.goto(BASE);
  await user.setInputFiles('#file', samples['too-hot.gcode']);
  await user.waitForSelector('.issue.error');
  ok(await user.locator('#send').isDisabled(), 'UI: send disabled for a file with errors');
  await user.screenshot({ path: `${shots}/submit-error.png` });

  await user.setInputFiles('#file', samples['good-red.gcode']);
  await user.waitForSelector('text=File passed the automatic checks');
  const chosen = await user.locator('#filament option:checked').textContent();
  ok(/PLA – Red/.test(chosen ?? ''), `UI: nearest filament preselected from G-code colour (${chosen})`);
  await user.fill('#name', 'Alice Example'); await user.fill('#notes', 'Please print slowly');
  await user.screenshot({ path: `${shots}/submit-ok.png` });
  await user.click('#send');
  await user.waitForSelector('table td:has-text("Alice Example")');
  ok(true, 'UI: request appears in the public queue');
  ok(await user.locator('button[data-act=cancel]').count() === 1, 'UI: submitter sees a Cancel button for own request');
  await user.screenshot({ path: `${shots}/queue.png` });

  // staff reviews and starts
  await page.click('a[data-r=staff]'); await page.click('button[data-t=review]');
  await page.waitForSelector('text=Please print slowly');
  await page.screenshot({ path: `${shots}/staff-review.png` });
  await page.click('button[data-act=approve]');
  await page.click('button[data-t=ready]');
  await page.waitForSelector('button[data-act=start]');
  await page.click('button[data-act=start]');
  await page.waitForFunction(() => document.body.innerText.includes('Ready to print (0)'), null, { timeout: 15000 });
  ok(m1.state.uploads.length === 1, 'UI: Start uploads the file to the printer');
  await user.click('a[data-r=printers]');
  await user.waitForSelector('.pill.PRINTING', { timeout: 15000 });
  await sleep(1500);
  await user.screenshot({ path: `${shots}/printers.png` });
  ok(await user.locator('text=Alice Example').count() >= 1, 'UI: printers page shows who is printing');
  await page.click('button[data-t=rules]'); await page.waitForSelector('text=Save rules');
  await page.screenshot({ path: `${shots}/staff-rules.png` });
  await page.click('button[data-t=filaments]'); await page.waitForSelector('text=Add');
  await page.screenshot({ path: `${shots}/staff-filaments.png` });
  ok(errors.length === 0, `UI: no JavaScript errors${errors.length ? ' -> ' + errors.join(' | ') : ''}`);
} catch (e) { fail++; console.error('UI TEST CRASHED', e, errors); }
finally { await browser.close(); srv.kill(); await m1.close(); console.log(fail ? `\n${fail} failed` : '\nUI smoke test passed'); process.exit(fail ? 1 : 0); }
