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

const m1 = await startMock(8081, { printSeconds: 6 });
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
  await page.waitForFunction(() => { const t = document.querySelector('[data-role=ptest-out]')?.textContent ?? ''; return t && t !== 'Testing…'; }, null, { timeout: 15000 });
  const testOut = await page.locator('[data-role=ptest-out]').first().innerText();
  if (!/connected, state IDLE/.test(testOut)) throw new Error(`printer test said: ${testOut}`);
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
  ok(/3DPMQ v\d+\.\d+\.\d+ · AGPL/.test(await user.locator('#foot').innerText()), `UI: version shown in the footer (${await user.locator('#foot').innerText()})`);
  await user.setInputFiles('#file', samples['too-hot.gcode']);
  await user.waitForSelector('.issue.error');
  ok(await user.locator('#send').isDisabled(), 'UI: send disabled for a file with errors');
  await user.screenshot({ path: `${shots}/submit-error.png` });

  await user.setInputFiles('#file', samples['good-red.gcode']);
  await user.waitForSelector('text=File passed the automatic checks');
  const chosen = await user.locator('#filament option:checked').textContent();
  ok(/PLA – Red/.test(chosen ?? ''), `UI: nearest filament preselected from G-code colour (${chosen})`);
  // class field: a dropdown inside the same input; the very first class is simply typed and created
  await user.click('.combo-arrow');
  ok(/No classes yet/.test(await user.locator('.combo-list').innerText()), 'UI: class dropdown is empty before the first class exists');
  await user.keyboard.press('Escape');
  await user.fill('#name', 'Alice Example'); await user.fill('#email', 'alice@example.org'); await user.fill('#class', '2CE');
  await user.fill('#what', 'A cable clip'); await user.fill('#use', 'Keeps cables tidy on my desk');
  ok(/New class: “2CE”/.test(await user.locator('.combo-list').innerText()), 'UI: typing a new class shows the "new class" hint'); await user.fill('#notes', 'Please print slowly');
  await user.screenshot({ path: `${shots}/submit-ok.png` });
  await user.click('#send');
  await user.waitForSelector('table td:has-text("Alice Example")');
  ok(true, 'UI: request appears in the public queue');
  ok(await user.locator('button[data-act=cancel]').count() === 1, 'UI: submitter sees a Cancel button for own request');
  await user.screenshot({ path: `${shots}/queue.png` });

  // staff reviews and starts
  await page.click('a[data-r=staff]'); await page.click('button[data-t=review]');
  await page.waitForSelector('text=Please print slowly');
  // 3D preview: opens a window of a quarter of the screen's area (half width, half height)
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('a[data-act=preview]')]);
  await popup.waitForFunction(() => (window as any).__preview, null, { timeout: 30000 });
  const scr = await page.evaluate(() => ({ sw: screen.availWidth, sh: screen.availHeight })); // the opener's screen is the reference
  const dims = { ...(await popup.evaluate(() => ({ w: innerWidth, h: innerHeight, url: location.pathname + location.search }))), ...scr };
  ok(/\/preview\.html\?id=\d+/.test(dims.url), `UI: preview opens in a new window (${dims.url})`);
  ok(Math.abs(dims.w - dims.sw / 2) <= dims.sw * 0.08 && Math.abs(dims.h - dims.sh / 2) <= dims.sh * 0.12, `UI: preview window is half the screen's width and height (${dims.w}x${dims.h} of ${dims.sw}x${dims.sh})`);
  await popup.screenshot({ path: `${shots}/preview-popup.png` });
  await popup.close();
  await page.screenshot({ path: `${shots}/staff-review.png` });
  await page.click('button[data-act=approve]');
  await page.click('button[data-t=ready]');
  await page.waitForSelector('button[data-act=start]');
  await page.click('button[data-act=start]');
  await page.waitForFunction(() => document.body.innerText.includes('Ready to print (0)'), null, { timeout: 15000 });
  for (let i = 0; i < 40 && m1.state.uploads.length < 1; i++) await sleep(250); // the upload finishes shortly after the queue count drops
  ok(m1.state.uploads.length === 1, 'UI: Start uploads the file to the printer');
  await user.click('a[data-r=printers]');
  await user.waitForSelector('.pill.PRINTING', { timeout: 15000 });
  await sleep(1500);
  await user.screenshot({ path: `${shots}/printers.png` });
  ok(await user.locator('text=Alice Example').count() >= 1, 'UI: printers page shows who is printing');
  // a second request, refused by staff and then cleared from the list
  await user.click('a[data-r=submit]');
  await user.setInputFiles('#file', samples['good.gcode']);
  await user.waitForSelector('text=File passed the automatic checks');
  await user.fill('#name', 'Bob Sample'); await user.fill('#email', 'bob@example.org'); await user.fill('#what', 'A plant pot'); await user.fill('#use', 'Decoration');
  await user.click('.combo-arrow');
  await user.waitForSelector('.combo-list li[data-v="2CE"]');
  ok(await user.locator('.combo-list li[data-v="2CE"]').count() === 1, 'UI: the class created by the first request is now in the dropdown');
  await user.screenshot({ path: `${shots}/class-dropdown.png` });
  await user.keyboard.press('Escape');
  await user.fill('#class', '3GE');
  ok(/New class: “3GE”/.test(await user.locator('.combo-list').innerText()), 'UI: a second new class is offered as new');
  await user.screenshot({ path: `${shots}/class-new.png` });
  await user.keyboard.press('Escape');
  await user.click('#send'); await user.waitForSelector('table td:has-text("Bob Sample")');
  await page.click('button[data-t=review]'); await page.waitForSelector('text=From');
  await page.click('button[data-act=reject]');
  await page.waitForSelector('text=Refused and cancelled (1)');
  await page.screenshot({ path: `${shots}/staff-refused.png` });
  await page.click('button[data-act=refclear]');
  await page.waitForFunction(() => !document.body.innerText.includes('Refused and cancelled'), null, { timeout: 8000 });
  ok(true, 'UI: refused request cleared from the list');
  // people: list, edit, statistics, add
  for (let i = 0; i < 80; i++) { // wait (max 40 s) until the mock printer has finished the job
    if (await page.evaluate(async () => (await (await fetch('/api/state')).json()).requests.some((r: any) => r.status === 'done'))) break;
    await sleep(500);
  }
  await page.click('button[data-t=people]'); await page.waitForSelector('#p-table td:has-text("Alice Example")');
  ok(await page.locator('#p-table tr:has-text("Alice Example") td:has-text("PLA")').count() >= 1, `UI: finished print shows in the statistics (${(await page.locator('#p-table tr:has-text("Alice Example")').innerText()).replace(/\s+/g, ' ')})`);
  ok(await page.locator('#p-table td:has-text("alice@example.org")').count() === 1 && await page.locator('#p-table td:has-text("2CE")').count() >= 1, 'UI: people list shows e-mail and class');
  ok(await page.locator('#p-table td:has-text("Bob Sample")').count() === 1, 'UI: second person was created too');
  await page.locator('#p-table tr:has-text("Alice Example") button[data-act=pedit]').click();
  await page.waitForSelector('#p-detail form[data-form=person]');
  await page.screenshot({ path: `${shots}/staff-people.png`, fullPage: true });
  // person editor: pick an existing class from the dropdown ...
  await page.locator('#p-detail .combo-arrow').click();
  await page.waitForSelector('#p-detail .combo-list li[data-v="3GE"]');
  ok(await page.locator('#p-detail .combo-list li[data-v="2CE"]').count() === 1 && await page.locator('#p-detail .combo-list li[data-v="3GE"]').count() === 1, 'UI: person editor offers all existing classes');
  await page.locator('#p-detail .combo-list li[data-v="3GE"]').click();
  ok(await page.locator('#p-detail input[name=class]').inputValue() === '3GE', 'UI: choosing a class fills the same field');
  await page.locator('#p-detail button.primary').click();
  await page.waitForFunction(() => /Alice Example[\s\S]*3GE/.test(document.querySelector('#p-table')?.innerText ?? ''), null, { timeout: 8000 });
  ok(true, 'UI: chosen class shows in the list');
  // ... or type a new one
  await page.locator('#p-table tr:has-text("Alice Example") button[data-act=pedit]').click();
  await page.waitForSelector('#p-detail form[data-form=person]');
  await page.locator('#p-detail input[name=class]').fill('4GE');
  await page.locator('#p-detail button.primary').click();
  await page.waitForFunction(() => document.querySelector('#p-table')?.innerText.includes('4GE'), null, { timeout: 8000 });
  ok(true, 'UI: a new class typed in the editor is saved');
  await page.locator('#p-classes summary').click();
  await page.screenshot({ path: `${shots}/staff-classes.png`, fullPage: true });
  ok(await page.locator('#p-classes tr:has-text("4GE")').count() === 1 && await page.locator('#p-classes tr:has-text("2CE")').count() === 1, 'UI: the Classes card lists all classes with their people');
  await page.fill('#p-q', 'bob'); await page.waitForFunction(() => !document.querySelector('#p-table')?.innerText.includes('Alice'), null, { timeout: 8000 });
  ok(await page.locator('#p-table tr:has-text("Bob Sample")').count() === 1, 'UI: search filters the list');
  await page.fill('#p-q', ''); await page.waitForSelector('#p-table td:has-text("Alice Example")');
  await page.click('button[data-act=pnew]');
  await page.locator('#p-detail input[name=name]').fill('Sam Staff'); await page.locator('#p-detail input[name=email]').fill('sam@example.org');
  await page.locator('#p-detail select[name=role]').selectOption('staff');
  await page.locator('#p-detail button.primary').click();
  await page.waitForSelector('#p-table td:has-text("Sam Staff")');
  ok(true, 'UI: staff member added');
  await page.click('button[data-t=rules]'); await page.waitForSelector('text=Save rules');
  await page.screenshot({ path: `${shots}/staff-rules.png` });
  await page.click('button[data-t=filaments]'); await page.waitForSelector('text=Add');
  await page.screenshot({ path: `${shots}/staff-filaments.png` });
  // ---- languages: English is the default; French and German are selectable on the page itself
  ok(await user.locator('#lang').inputValue() === 'en' && await user.locator('html').getAttribute('lang') === 'en', 'UI: English is the default language');
  ok((await user.locator('#lang option').allInnerTexts()).join('|') === 'English|Français|Deutsch', 'UI: the language selector offers English, French and German');
  await user.goto(`${BASE}/#/submit`);
  await user.selectOption('#lang', 'fr');
  await user.waitForSelector('nav a:has-text("Envoyer une impression")');
  ok(await user.locator('html').getAttribute('lang') === 'fr', 'UI: <html lang> follows the language');
  ok(await user.locator('label[for=what]').innerText() === 'Que voulez-vous imprimer ? *' && await user.locator('label[for=use]').innerText() === 'À quoi servira l’objet ? *', 'UI: the two mandatory questions are in French');
  await user.reload(); await user.waitForSelector('nav a:has-text("File d’attente")');
  ok(await user.locator('#lang').inputValue() === 'fr', 'UI: the chosen language is remembered after a reload');
  await user.selectOption('#lang', 'de');
  await user.waitForSelector('nav a:has-text("Warteschlange")');
  ok(/Klasse \*/.test(await user.locator('label[for=class]').innerText()) && /Druck einreichen/.test(await user.locator('h1').innerText()), 'UI: the submit page is in German');
  await user.setInputFiles('#file', samples['too-hot.gcode']);
  await user.waitForSelector('.issue.error');
  ok(/Düsentemperatur/.test(await user.locator('.issue.error').first().innerText()), `UI: validation messages from the server are shown in German (${(await user.locator('.issue.error').first().innerText()).slice(0, 60)})`);
  await user.screenshot({ path: `${shots}/submit-de.png`, fullPage: true });
  await user.selectOption('#lang', 'fr');
  await user.waitForSelector('nav a:has-text("Envoyer")');
  await user.goto(`${BASE}/#/queue`); await user.waitForSelector('h1:has-text("File d’attente d’impression")');
  ok(await user.locator('th:has-text("Statut")').count() === 1, 'UI: the queue page is in French');
  await user.selectOption('#lang', 'en'); await user.waitForSelector('h1:has-text("Print queue")');
  ok(/3DPMQ v\d+\.\d+\.\d+ · AGPL/.test(await user.locator('#foot').innerText()), 'UI: footer translated back to English');
  // staff area and the 3D viewer window
  await page.selectOption('#lang', 'fr');
  await page.waitForSelector('button[data-t=people]:has-text("Personnes")');
  ok(/Règles/.test(await page.locator('.tabs').innerText()) && /connecté en tant que Philippe/.test(await page.locator('#root').innerText()), 'UI: the staff area is in French');
  await page.click('button[data-t=people]'); await page.waitForSelector('#p-table td:has-text("Alice Example")');
  await page.screenshot({ path: `${shots}/staff-people-fr.png`, fullPage: true });
  ok(/Élève/.test(await page.locator('#p-table').innerText()) && await page.locator('th:has-text("Plastique imprimé")').count() === 1, 'UI: people table and roles are in French');
  const pvCtx = await browser.newContext(); const pv = await pvCtx.newPage();
  await pv.goto(`${BASE}/preview.html?id=1`); // same origin, so it shares the language the staff chose (here: set directly)
  await pv.evaluate(() => localStorage.setItem('mq_lang', 'fr')); await pv.reload();
  await pv.waitForFunction(() => document.title === 'Aperçu 3D – 3DPMQ', null, { timeout: 8000 });
  ok(await pv.locator('html').getAttribute('lang') === 'fr', 'UI: the 3D viewer window uses the selected language too');
  await pvCtx.close();
  await page.selectOption('#lang', 'en'); await page.waitForSelector('button[data-t=people]:has-text("People")');
  ok(true, 'UI: staff area back to English');
  ok(errors.length === 0, `UI: no JavaScript errors${errors.length ? ' -> ' + errors.join(' | ') : ''}`);
} catch (e) { fail++; console.error('UI TEST CRASHED', e, errors); }
finally { await browser.close(); srv.kill(); await m1.close(); console.log(fail ? `\n${fail} failed` : '\nUI smoke test passed'); process.exit(fail ? 1 : 0); }
