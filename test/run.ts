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
  const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  ok(cfg.version === pkgVersion && /^\d+\.\d+\.\d+/.test(cfg.version), `/api/config reports the version from package.json (${cfg.version})`);
  const pla = cfg.filaments.find((f: any) => f.material === 'PLA' && f.colour_name === 'Black');
  const red = cfg.filaments.find((f: any) => f.colour_name === 'Red');
  const petg = cfg.filaments.find((f: any) => f.material === 'PETG' && f.colour_name === 'Black');

  for (const [file, type] of [['favicon.svg', 'image/svg+xml'], ['logo.svg', 'image/svg+xml'], ['icon-512.png', 'image/png'], ['favicon.ico', 'image/'], ['site.webmanifest', 'manifest']]) {
    const r = await fetch(`${BASE}/${file}`);
    ok(r.ok && (r.headers.get('content-type') ?? '').includes(type), `logo asset /${file} is served (${r.headers.get('content-type')})`);
  }
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
  const emailOf = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.org`;
  const sub = async (file: string, name: string, fid: number, cls = '2CE') => api('POST', '/api/requests', undefined, form(file, { name, email: emailOf(name), class: cls, filamentId: String(fid), notes: 'test' }));
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

  console.log('\nPeople, classes, statistics, clearing');
  await api('PUT', '/api/staff/rules', { monthlyGramQuota: 0, maxActivePerUser: 10 });
  const subx = (file: string, fields: Record<string, string>) => api('POST', '/api/requests', undefined, form(file, { filamentId: String(pla.id), ...fields }));
  cookie = '';
  ok(codes((await subx('good.gcode', { name: 'Hanna', email: '', class: '2CE' })).data).includes('email'), 'e-mail is required');
  ok(codes((await subx('good.gcode', { name: 'Hanna', email: 'not-an-email', class: '2CE' })).data).includes('email'), 'invalid e-mail refused');
  ok(codes((await subx('good.gcode', { name: 'Hanna', email: 'hanna@example.org', class: '' })).data).includes('class'), 'class is required for a new student');
  const h1 = await subx('good.gcode', { name: 'Hanna', email: 'Hanna@Example.org', class: '2CE' });
  ok(h1.status === 201, 'new person created with e-mail and class (e-mail case-insensitive)');
  const h2 = await subx('good.gcode', { name: 'Hannah (typo)', email: 'hanna@example.org', class: '' });
  ok(h2.status === 201, 'known e-mail: class need not be typed again');
  ok(!JSON.stringify(h2.data).includes('Hanna'), 'response to the submitter does not reveal the registered name');
  const pub2 = (await api('GET', '/api/state')).data;
  ok(pub2.requests.every((x: any) => !('user_email' in x) && !('user_class' in x)), 'public state hides e-mail and class');
  ok((await api('GET', '/api/staff/users')).status === 401, 'people list needs staff login');
  ok((await api('GET', '/api/config')).data.classes.includes('2CE'), 'known classes offered to the form');
  cookie = staffCookie;

  let users = (await api('GET', '/api/staff/users')).data as any[];
  const hanna = users.filter((u) => u.email === 'hanna@example.org');
  ok(hanna.length === 1 && hanna[0].name === 'Hanna' && hanna[0].class === '2CE' && hanna[0].requests_total === 2, 'both requests linked to one person; typed name did not overwrite the record');
  const hreq = (await api('GET', '/api/state')).data.requests.find((x: any) => x.id === h2.data.id);
  ok(hreq.user_name === 'Hanna' && hreq.issues.some((i: any) => i.code === 'name-differs'), 'staff see a note that the typed name differs');
  ok((await api('POST', `/api/staff/requests/${h1.data.id}/reject`, { reason: 'test' })).status === 200 && (await api('POST', `/api/staff/requests/${h2.data.id}/reject`, { reason: 'test' })).status === 200, 'Hanna requests rejected (to be cleared later)');

  // statistics of finished prints
  const alice = users.find((u) => u.email === emailOf('Alice'));
  ok(alice && alice.prints === 1 && Math.abs(alice.grams - 12.34) < 0.01 && alice.seconds >= 1 && alice.by_material[0].material === 'PLA', `statistics: Alice printed ${alice?.grams} g PLA in ${alice?.seconds}s`);
  const detail = (await api('GET', `/api/staff/users/${alice.id}`)).data;
  ok(detail.by_month.length === 1 && /^\d{4}-\d{2}$/.test(detail.by_month[0].month) && detail.totals.prints === 1 && detail.requests.length === 1, 'statistics per month and request list');

  // a print that is stopped half way counts partially
  const g = await sub('good.gcode', 'Gina', pla.id);
  await api('POST', `/api/staff/requests/${g.data.id}/approve`);
  await sleep(700);
  ok((await api('POST', `/api/staff/requests/${g.data.id}/start`, { printerId: p1 })).status === 202, 'Gina print started');
  ok(await waitFor(async () => ((await api('GET', '/api/state')).data.requests.find((x: any) => x.id === g.data.id).progress ?? 0) >= 20, 15000), 'Gina print is at 20%+');
  const stopRes = await api('POST', `/api/staff/printers/${p1}/stop`);
  ok(stopRes.status === 200, `stop request accepted (HTTP ${stopRes.status} ${JSON.stringify(stopRes.data)})`);
  ok(await waitFor(async () => (await api('GET', '/api/state')).data.requests.find((x: any) => x.id === g.data.id).status === 'failed', 15000), 'stopped print is marked failed');
  ok((await api('POST', `/api/staff/printers/${p1}/stop`)).status === 409, 'stop with nothing running is a clear 409, not a server error');
  users = (await api('GET', '/api/staff/users')).data;
  const gina = users.find((u) => u.email === emailOf('Gina'));
  ok(gina.prints === 0 && gina.by_material[0].partial === 1 && gina.grams > 0 && gina.grams < 12.34, `partial print counted by progress (${gina.grams} g of 12.34 g)`);

  // overview, filters, CSV
  const st = (await api('GET', '/api/staff/stats')).data;
  ok(st.prints >= 2 && st.by_material.find((m: any) => m.material === 'PLA').grams >= 24.6 && st.by_class.some((c: any) => c.class === '2CE'), `overview: ${st.prints} prints, ${st.grams} g, per material and per class`);
  ok((await api('GET', '/api/staff/users?class=2ce')).data.length === users.length, 'class filter is case-insensitive');
  ok((await api('GET', '/api/staff/users?role=staff')).data.length === 0 && (await api('GET', '/api/staff/users?q=alice')).data.length === 1, 'role filter and search');
  const pcsv = await (await fetch(BASE + '/api/staff/users/export.csv', { headers: { Cookie: staffCookie } })).text();
  ok(pcsv.includes('grams_PLA') && pcsv.includes(emailOf('Alice')), 'people CSV export with per-material columns');

  // staff add and correct people; staff members have the same data
  const sam = await api('POST', '/api/staff/users', { name: 'Sam Staff', email: 'sam@example.org', class: '', role: 'staff', notes: 'lab manager' });
  ok(sam.status === 201, 'staff can add a person');
  ok((await api('POST', '/api/staff/users', { name: 'Sam Two', email: 'SAM@example.org', role: 'student' })).status === 409, 'duplicate e-mail refused');
  ok((await api('POST', '/api/staff/users', { name: 'X', email: 'x@example.org', role: 'student' })).status === 400 && (await api('POST', '/api/staff/users', { name: 'Xavier', email: 'x@example.org', role: 'boss' })).status === 400, 'invalid name / role refused');
  cookie = '';
  ok((await subx('good.gcode', { name: 'Sam Staff', email: 'sam@example.org', class: '' })).status === 201, 'class is not required for a staff member');
  cookie = staffCookie;
  const upd = await api('PUT', `/api/staff/users/${alice.id}`, { name: 'Alice Example', email: 'alice.new@example.org', class: '3GE', role: 'student', notes: 'corrected' });
  ok(upd.status === 200, 'staff can correct a person');
  const areq = (await api('GET', '/api/state')).data.requests.find((x: any) => x.id === a.data.id);
  ok(areq.user_name === 'Alice Example' && areq.user_class === '3GE' && areq.user_email === 'alice.new@example.org', 'correction also shows on the person\'s requests');
  ok((await api('PUT', `/api/staff/users/${alice.id}`, { name: 'Alice Example', email: emailOf('Bob'), class: '3GE', role: 'student' })).status === 409, 'cannot change e-mail to one that is taken');
  ok((await api('GET', `/api/staff/users/${alice.id}`)).data.totals.grams > 12, 'statistics stay with the person after the correction');

  // removing people
  const erin = users.find((u) => u.email === emailOf('Erin')), frank = users.find((u) => u.email === emailOf('Frank'));
  ok((await api('DELETE', `/api/staff/users/${erin.id}`)).status === 409, 'cannot remove a person with open requests');
  for (const r of (await api('GET', '/api/state')).data.requests.filter((x: any) => ['pending', 'approved'].includes(x.status))) await api('POST', `/api/staff/requests/${r.id}/reject`, { reason: 'cleanup' });
  const erinReqId = (await api('GET', '/api/state')).data.requests.find((x: any) => x.user_email === emailOf('Erin')).id;
  ok((await api('DELETE', `/api/staff/users/${erin.id}`)).status === 200, 'person removed (personal data erased)');
  const erinReq = (await api('GET', '/api/state')).data.requests.find((x: any) => x.id === erinReqId);
  ok(erinReq.user_name === 'Deleted user' && erinReq.user_email === '' && erinReq.user_id === null && erinReq.file_name === '(removed)', 'their requests are anonymised');
  const ginaId = gina.id;
  ok((await api('DELETE', `/api/staff/users/${ginaId}?mode=anonymize`)).status === 200, 'person with finished print removed');
  ok((await api('GET', '/api/staff/stats')).data.by_material.find((m: any) => m.material === 'PLA').grams >= st.by_material.find((m: any) => m.material === 'PLA').grams, 'anonymous statistics are kept');
  ok((await api('DELETE', `/api/staff/users/${frank.id}?mode=purge`)).status === 200 && !(await api('GET', '/api/state')).data.requests.some((x: any) => x.user_email === emailOf('Frank')), 'purge also deletes their requests');
  ok(!(await api('GET', '/api/staff/audit')).data.some((x: any) => JSON.stringify(x).includes(emailOf('Erin'))), 'audit log no longer contains the removed person\'s e-mail');

  // clearing refused requests
  const before = (await api('GET', '/api/state')).data.requests;
  const refused = before.filter((x: any) => x.status === 'rejected' || (x.status === 'cancelled' && !x.started_at)).length;
  ok(refused >= 4, `there are ${refused} refused/cancelled requests to clear`);
  const doneReq = before.find((x: any) => x.status === 'done');
  ok((await api('DELETE', `/api/staff/requests/${doneReq.id}`)).status === 409, 'a finished print cannot be deleted');
  const one = before.find((x: any) => x.status === 'rejected');
  ok((await api('DELETE', `/api/staff/requests/${one.id}`)).status === 200, 'a single refused request can be removed');
  cookie = ''; ok((await api('POST', '/api/staff/requests/clear-refused')).status === 401, 'clearing needs staff login'); cookie = staffCookie;
  const cl = await api('POST', '/api/staff/requests/clear-refused');
  ok(cl.status === 200 && cl.data.removed === refused - 1, `all other refused requests cleared (${cl.data.removed})`);
  const after = (await api('GET', '/api/state')).data.requests;
  ok(!after.some((x: any) => x.status === 'rejected' || (x.status === 'cancelled' && !x.started_at)) && after.some((x: any) => x.status === 'done'), 'queue no longer lists refused requests; finished prints stay');

  const csv = await fetch(BASE + '/api/staff/export.csv', { headers: { Cookie: staffCookie } });
  ok(csv.ok && (await csv.text()).split('\n').length >= 3, 'request CSV export');
  ok((await api('GET', '/api/staff/audit')).data.length > 10, 'audit log written');
  const leftovers = fs.readdirSync(path.join(dataDir, 'uploads')).length;
  const rowsLeft = (await api('GET', '/api/state')).data.requests.filter((x: any) => x.file_name !== '(removed)').length;
  ok(leftovers === rowsLeft, `no stray uploads: ${leftovers} files for ${rowsLeft} remaining requests with a file (cleared, rejected and anonymised ones were deleted)`);
} catch (e) {
  fail++; console.error('TEST CRASHED', e);
} finally {
  srv.kill(); await m1.close(); await m2.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
