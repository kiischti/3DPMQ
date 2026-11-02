/** End-to-end test: real server process + two mock PrusaLink printers. Run: npm test */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from '../mock/mock-prusalink.js';
import { writeSamples } from './make-samples.js';

const PORT = 3911, BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-test-'));
const samples = writeSamples(path.join(dataDir, 'samples'));
let pass = 0, fail = 0;
const ok = (c: unknown, msg: string) => { if (c) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function api(method: string, url: string, body?: any, form?: FormData) {
  const r = await fetch(BASE + url, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const txt = await r.text(); let data: any = {}; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  return { status: r.status, data };
}
const form = (file: string, fields: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(samples[file])]), file);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};
const codes = (d: any) => (d.issues as any[]).map((i) => i.code);
async function waitFor(fn: () => Promise<boolean>, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250); } return false; }

const m1 = await startMock(8081, { printSeconds: 4 });
const m2 = await startMock(8082, { printSeconds: 4 });
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/server.ts'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, STAFF_PASSWORD: 'pw', POLL_MS: '400' }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning|trace-warnings/.test(s)) process.stderr.write(s); });
await waitFor(async () => (await fetch(BASE + '/api/config').catch(() => null))?.ok === true, 20000);

try {
  console.log('\nValidation');
  const cfg = (await api('GET', '/api/config')).data;
  const pla = cfg.filaments.find((f: any) => f.material === 'PLA' && f.colour_name === 'Black');
  const red = cfg.filaments.find((f: any) => f.colour_name === 'Red');
  const petg = cfg.filaments.find((f: any) => f.material === 'PETG' && f.colour_name === 'Black');

  // staff + printers
  ok((await api('POST', '/api/staff/login', { password: 'nope' })).status === 401, 'wrong staff password rejected');
  ok((await api('POST', '/api/staff/login', { password: 'pw', name: 'Tester' })).status === 200, 'staff login');
  ok((await api('GET', '/api/staff/rules')).status === 200, 'staff endpoint reachable with cookie');
  const staffCookie = cookie;
  cookie = ''; ok((await api('GET', '/api/staff/rules')).status === 401, 'staff endpoint blocked without cookie'); cookie = staffCookie;

  const p1 = (await api('POST', '/api/staff/printers', { name: 'MK4S-A', base_url: 'http://localhost:8081', username: 'maker', password: 'test', model: 'MK4S', nozzle: 0.4, enabled: true })).data.id;
  const p2 = (await api('POST', '/api/staff/printers', { name: 'MK4S-B', base_url: 'http://localhost:8082', username: 'maker', password: 'WRONG', model: 'MK4S', nozzle: 0.4, enabled: true })).data.id;
  ok(typeof p1 === 'number' && typeof p2 === 'number', 'printers created');
  const t1 = (await api('POST', '/api/staff/printers/test', { base_url: 'http://localhost:8081', username: 'maker', password: 'test', storage: 'usb', model: 'MK4S', name: 'x' })).data;
  ok(t1.ok && t1.state === 'IDLE', `digest auth against mock works (state ${t1.state})`);
  const t2 = (await api('POST', '/api/staff/printers/test', { base_url: 'http://localhost:8082', username: 'maker', password: 'WRONG', storage: 'usb', model: 'MK4S', name: 'x' })).data;
  ok(!t2.ok && /Unauthorized/.test(t2.error), 'wrong printer password reported');
  await api('PUT', `/api/staff/printers/${p2}`, { name: 'MK4S-B', base_url: 'http://localhost:8082', username: 'maker', password: 'test', model: 'MK4S', nozzle: 0.4, enabled: true });

  const v = async (file: string, fid?: number) => (await api('POST', '/api/validate', undefined, form(file, fid ? { filamentId: String(fid) } : {}))).data;
  let r = await v('good.gcode', pla.id);
  ok(r.ok && r.meta.printerModel === 'MK4S' && r.meta.filamentTypes[0] === 'PLA' && r.meta.seconds === 4325 && Math.abs(r.meta.grams - 12.34) < 0.01, `good.gcode parsed (model ${r.meta.printerModel}, ${r.meta.seconds}s, ${r.meta.grams}g)`);
  ok(r.meta.filamentColours[0] === '#FF8000' && r.meta.layerHeight === 0.2 && r.meta.nozzleDiameter === 0.4, 'colour / layer height / nozzle parsed');
  r = await v('good.bgcode', pla.id);
  ok(r.ok && r.meta.format === 'bgcode' && r.meta.printerModel === 'MK4S' && r.meta.seconds === 4325 && r.meta.filamentColours[0] === '#FF8000' && /PrusaSlicer/.test(r.meta.generator),
    `real .bgcode (Prusa encoder, heatshrink + MeatPack) parsed: ${r.meta.printerModel}, ${r.meta.filamentTypes}, ${r.meta.seconds}s, ${r.meta.grams}g`);
  ok(!codes(r).includes('unscanned') && !codes(r).includes('bgcode-unscanned'), '.bgcode content is scanned (no "unscanned" warning)');
  ok((await v('deflate.bgcode', pla.id)).ok, '.bgcode with deflate blocks accepted');
  ok(codes(await v('hot.bgcode', pla.id)).includes('nozzle-temp'), '.bgcode: nozzle temperature inside compressed G-code is enforced');
  ok(codes(await v('too-hot.gcode', petg.id)).includes('nozzle-temp'), 'nozzle temp over limit rejected');
  ok(codes(await v('too-heavy.gcode', pla.id)).includes('too-heavy'), 'too heavy rejected');
  ok(codes(await v('too-long.gcode', pla.id)).includes('too-long'), 'too long rejected');
  ok(codes(await v('abs.gcode')).includes('material-not-allowed'), 'ABS not allowed');
  ok(codes(await v('wrong-printer.gcode', pla.id)).includes('printer-model'), 'wrong printer model rejected');
  ok(codes(await v('wrong-nozzle.gcode', pla.id)).includes('nozzle'), 'wrong nozzle rejected');
  ok(codes(await v('cura.gcode', pla.id)).includes('slicer'), 'non-PrusaSlicer file rejected');
  ok(codes(await v('forbidden.gcode', pla.id)).includes('forbidden-gcode'), 'M502/M500/M997 rejected');
  ok(codes(await v('pauses.gcode', pla.id)).includes('pauses') && (await v('pauses.gcode', pla.id)).ok, 'M600 only warns');
  ok(codes(await v('multicolor.gcode', pla.id)).includes('multi-material'), 'multi-material rejected');
  ok(codes(await v('nometa.gcode', pla.id)).includes('no-metadata'), 'file without metadata rejected');
  ok(codes(await v('notgcode.stl')).includes('file-type'), 'STL rejected with hint to slice');
  ok(codes(await v('good.gcode', petg.id)).includes('filament-mismatch'), 'selected filament must match sliced material');

  console.log('\nSubmission, review, printing');
  const sub = async (file: string, name: string, fid: number) => api('POST', '/api/requests', undefined, form(file, { name, email: '', filamentId: String(fid), notes: 'test' }));
  const bad = await sub('too-heavy.gcode', 'Alice', pla.id);
  ok(bad.status === 422 && codes(bad.data).includes('too-heavy'), 'invalid submission refused with reasons (422)');
  ok((await sub('good.gcode', 'A', pla.id)).status === 422, 'name too short refused');
  const a = await sub('good.gcode', 'Alice', pla.id);
  ok(a.status === 201 && a.data.cancel_token, 'valid submission accepted');
  const b = await sub('good-red.gcode', 'Bob', red.id);
  const c = await sub('petg.gcode', 'Carol', petg.id);
  ok(b.status === 201 && c.status === 201, 'more submissions accepted');
  cookie = '';
  const pub = (await api('GET', '/api/state')).data;
  ok(pub.requests.length === 3 && !('user_email' in pub.requests[0]) && !('meta' in pub.requests[0]) && !pub.printers.some((p: any) => 'base_url' in p || 'password' in p), 'public state hides email, metadata and printer credentials');
  ok((await api('POST', `/api/staff/requests/${a.data.id}/approve`)).status === 401, 'approval needs staff');
  cookie = staffCookie;

  // Alice's request can't start before approval
  ok((await api('POST', `/api/staff/requests/${a.data.id}/start`, { printerId: p1 })).status === 409, 'cannot start unapproved request');
  ok((await api('POST', `/api/staff/requests/${a.data.id}/approve`)).status === 200, 'approve Alice');
  ok((await api('POST', `/api/staff/requests/${b.data.id}/approve`)).status === 200, 'approve Bob');
  ok((await api('POST', `/api/staff/requests/${c.data.id}/reject`, { reason: 'Please use PLA' })).status === 200, 'reject Carol');
  ok((await api('POST', `/api/staff/requests/${c.data.id}/reject`, {})).status === 400, 'reject needs a reason');

  // filament not loaded -> strict start refused
  ok((await api('POST', `/api/staff/requests/${a.data.id}/start`, { printerId: p1 })).status === 409, 'start refused while requested filament is not loaded');
  await api('POST', `/api/staff/printers/${p1}/loaded`, { filamentId: pla.id });
  await api('POST', `/api/staff/printers/${p2}/loaded`, { filamentId: red.id });
  await sleep(900);
  const elig = (await api('GET', '/api/state')).data.requests.find((x: any) => x.id === a.data.id).eligible;
  ok(elig.length === 1 && elig[0].id === p1 && elig[0].available, 'Alice eligible only on printer A (filament loaded)');
  ok((await api('POST', `/api/staff/requests/${a.data.id}/start`, { printerId: p1 })).status === 202, 'manual start accepted');
  ok(await waitFor(async () => m1.state.uploads.length === 1 && m1.state.uploads[0].name === `MQ${a.data.id}.gcode`), `file uploaded to printer as MQ${a.data.id}.gcode (${m1.state.uploads[0]?.size} bytes)`);
  ok(m1.state.uploads[0].size === fs.statSync(samples['good.gcode']).size, 'uploaded byte count equals file size');
  ok(await waitFor(async () => (await api('GET', '/api/state')).data.requests.find((x: any) => x.id === a.data.id).status === 'printing'), 'status -> printing');
  ok((await api('POST', `/api/staff/requests/${a.data.id}/start`, { printerId: p1 })).status === 409, 'cannot start twice');
  ok(await waitFor(async () => (await api('GET', '/api/state')).data.requests.find((x: any) => x.id === a.data.id).status === 'done', 20000), 'status -> done after printer FINISHED');
  const pr = (await api('GET', '/api/state')).data.printers.find((p: any) => p.id === p1);
  ok(pr.bed_clear === false, 'bed_clear reset after finished job');

  console.log('\nAuto-start and cancel');
  await api('PUT', `/api/staff/printers/${p2}`, { name: 'MK4S-B', base_url: 'http://localhost:8082', username: 'maker', password: '', model: 'MK4S', nozzle: 0.4, enabled: true, auto_start: true });
  await api('POST', `/api/staff/printers/${p2}/bed-clear`, { clear: true });
  ok(await waitFor(async () => m2.state.uploads.length === 1, 10000), 'auto-start sent Bob\'s job to printer B after "bed is clear"');
  ok(await waitFor(async () => (await api('GET', '/api/state')).data.requests.find((x: any) => x.id === b.data.id).status === 'done', 20000), 'Bob done');

  const d = await sub('good.gcode', 'Dave', pla.id);
  cookie = '';
  const cancel2 = await api('POST', `/api/requests/${d.data.id}/cancel`, { token: 'wrong' });
  ok(cancel2.status === 403, 'cancel with wrong token refused');
  ok((await api('POST', `/api/requests/${d.data.id}/cancel`, { token: d.data.cancel_token })).status === 200, 'submitter can cancel with token');
  cookie = staffCookie;

  console.log('\nLimits');
  await api('PUT', '/api/staff/rules', { maxActivePerUser: 1 });
  await sub('good.gcode', 'Erin', pla.id);
  const e2 = await sub('good.gcode', 'erin', pla.id);
  ok(e2.status === 422 && codes(e2.data).includes('active-limit'), 'per-user open-request limit (case-insensitive name)');
  await api('PUT', '/api/staff/rules', { maxActivePerUser: 3, monthlyGramQuota: 20 });
  const f1 = await sub('good.gcode', 'Frank', pla.id);
  const f2 = await sub('good.gcode', 'Frank', pla.id);
  ok(f1.status === 201 && f2.status === 422 && codes(f2.data).includes('quota'), 'monthly gram quota enforced');

  const csv = await fetch(BASE + '/api/staff/export.csv', { headers: { Cookie: staffCookie } });
  ok(csv.ok && (await csv.text()).split('\n').length > 5, 'CSV export');
  ok((await api('GET', '/api/staff/audit')).data.length > 10, 'audit log written');
  const leftovers = fs.readdirSync(path.join(dataDir, 'uploads')).length;
  ok(leftovers === 6, `rejected/validated uploads are not left on disk (${leftovers} files = accepted requests only)`);
} catch (e) {
  fail++; console.error('TEST CRASHED', e);
} finally {
  srv.kill(); await m1.close(); await m2.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
