import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, UPLOAD_DIR, audit, db, getRules, getSecret, setRules, type Rules } from './db.js';
import {
  detectFormat, hasErrors, modelEquals, parseMeta, scanFile, validate,
  type FilamentLite, type GcodeMeta, type Issue, type PrinterLite, type ScanResult,
} from './gcode.js';
import { PrusaLink, type JobInfo, type PrinterStatus } from './prusalink.js';
import { SOURCE_URL, VERSION } from './version.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const POLL_MS = parseInt(process.env.POLL_MS ?? '5000', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB ?? '500', 10);
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? '30', 10);
const STAFF_PASSWORD = process.env.STAFF_PASSWORD ?? 'changeme';
if (STAFF_PASSWORD === 'changeme') console.warn('WARNING: STAFF_PASSWORD is not set, using the insecure default "changeme".');
const SECRET = getSecret();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ db helpers
type Row = Record<string, any>;
const all = <T = Row>(sql: string, ...p: any[]): T[] => db.prepare(sql).all(...p) as unknown as T[];
const get = <T = Row>(sql: string, ...p: any[]): T | undefined => db.prepare(sql).get(...p) as unknown as T | undefined;
const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
const nowIso = () => new Date().toISOString();

const AVAILABLE_STATES = new Set(['IDLE', 'READY', 'FINISHED', 'STOPPED']);
const ACTIVE_STATES = new Set(['PRINTING', 'PAUSED', 'BUSY', 'ATTENTION']);

// ------------------------------------------------------------------ printer runtime state
interface Runtime { online: boolean; status?: PrinterStatus; job?: JobInfo | null; error?: string; seen?: number }
const runtime = new Map<number, Runtime>();
const links = new Map<string, PrusaLink>();

function linkFor(p: Row): PrusaLink {
  const key = [p.id, p.base_url, p.username, p.password, p.storage].join('|');
  let l = links.get(key);
  if (!l) {
    for (const k of links.keys()) if (k.startsWith(`${p.id}|`)) links.delete(k);
    l = new PrusaLink({ base_url: p.base_url, username: p.username, password: p.password, storage: p.storage });
    links.set(key, l);
  }
  return l;
}

// ------------------------------------------------------------------ staff auth (HMAC-signed cookie)
const sign = (s: string) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(name: string): string {
  const body = Buffer.from(JSON.stringify({ n: name, e: Date.now() + 12 * 3600 * 1000 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readToken(tok: string | undefined): string | null {
  if (!tok) return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const expect = sign(body);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    return o.e > Date.now() ? String(o.n) : null;
  } catch { return null; }
}
function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
const staffOf = (req: Request) => readToken(cookie(req, 'mq_staff'));
function requireStaff(req: Request, res: Response, next: NextFunction) {
  const s = staffOf(req);
  if (!s) return void res.status(401).json({ error: 'Staff login required' });
  (req as any).staff = s;
  next();
}
const loginFails = new Map<string, { n: number; t: number }>();

// ------------------------------------------------------------------ view helpers
function filamentRow(id: number | null | undefined): FilamentLite | undefined {
  return id ? get<FilamentLite>('SELECT * FROM filaments WHERE id = ?', id) : undefined;
}
const allPrinters = () => all<Row>('SELECT * FROM printers ORDER BY name');
const printerLite = (): PrinterLite[] => allPrinters() as unknown as PrinterLite[];

function eligiblePrinters(r: Row): Row[] {
  const meta: GcodeMeta = JSON.parse(r.meta_json);
  return allPrinters().filter((p) =>
    p.enabled &&
    modelEquals(meta.printerModel, p.model) &&
    (p.nozzle == null || meta.nozzleDiameter === undefined || Math.abs(p.nozzle - meta.nozzleDiameter) < 0.001) &&
    p.loaded_filament_id === r.filament_id);
}

function printerAvailable(p: Row): boolean {
  const rt = runtime.get(p.id);
  if (!p.enabled || !rt?.online || !rt.status?.printer?.state) return false;
  if (!AVAILABLE_STATES.has(rt.status.printer.state)) return false;
  return !get('SELECT 1 FROM requests WHERE printer_id = ? AND status IN (\'printing\',\'uploading\')', p.id);
}

function queueOrder(): Row[] {
  return all(`SELECT * FROM requests WHERE status = 'approved' ORDER BY priority DESC, approved_at ASC, id ASC`);
}

function requestView(r: Row, staff: boolean, queuePos?: number) {
  const f = filamentRow(r.filament_id);
  const pr = r.printer_id ? get<Row>('SELECT name FROM printers WHERE id = ?', r.printer_id) : undefined;
  const rt = r.printer_id ? runtime.get(r.printer_id) : undefined;
  const base: Row = {
    id: r.id, created_at: r.created_at, user_name: r.user_name,
    filament: f ? { id: f.id, material: f.material, colour_name: f.colour_name, colour_hex: f.colour_hex } : null,
    file_name: r.file_name, grams: r.grams, seconds: r.seconds, status: r.status,
    reject_reason: r.reject_reason, priority: r.priority, printer_id: r.printer_id, printer_name: pr?.name ?? null,
    started_at: r.started_at, finished_at: r.finished_at, queue_position: queuePos ?? null,
    progress: r.status === 'printing' ? (rt?.status?.job?.progress ?? r.last_progress) : r.status === 'done' ? 100 : null,
    error: r.error,
  };
  if (staff) {
    const eligible = r.status === 'approved' ? eligiblePrinters(r) : [];
    Object.assign(base, {
      user_email: r.user_email, notes: r.notes, meta: JSON.parse(r.meta_json), issues: JSON.parse(r.issues_json),
      reviewed_by: r.reviewed_by, file_size: r.file_size,
      eligible: eligible.map((p) => ({ id: p.id, name: p.name, available: printerAvailable(p) })),
    });
  }
  return base;
}

function printerView(p: Row, staff: boolean) {
  const rt = runtime.get(p.id);
  const running = get<Row>('SELECT id, user_name, file_name, last_progress FROM requests WHERE printer_id = ? AND status IN (\'printing\',\'uploading\')', p.id);
  const f = filamentRow(p.loaded_filament_id);
  const st = rt?.status;
  const v: Row = {
    id: p.id, name: p.name, model: p.model, nozzle: p.nozzle, enabled: !!p.enabled, auto_start: !!p.auto_start,
    bed_clear: !!p.bed_clear, loaded_filament: f ?? null,
    online: !!rt?.online, error: rt?.online ? null : rt?.error ?? null,
    state: rt?.online ? st?.printer?.state ?? 'UNKNOWN' : 'OFFLINE',
    temp_nozzle: st?.printer?.temp_nozzle ?? null, target_nozzle: st?.printer?.target_nozzle ?? null,
    temp_bed: st?.printer?.temp_bed ?? null, target_bed: st?.printer?.target_bed ?? null,
    progress: st?.job?.progress ?? null, time_remaining: st?.job?.time_remaining ?? null, time_printing: st?.job?.time_printing ?? null,
    job_id: st?.job?.id ?? null,
    current: running ? { request_id: running.id, user_name: running.user_name, file_name: running.file_name } : null,
    available: printerAvailable(p),
  };
  if (staff) Object.assign(v, { base_url: p.base_url, username: p.username, storage: p.storage, has_password: !!p.password });
  return v;
}

function snapshot(staff: boolean) {
  const queue = queueOrder();
  const pos = new Map(queue.map((r, i) => [r.id, i + 1]));
  const rows = all<Row>(`SELECT * FROM requests ORDER BY
      CASE status WHEN 'printing' THEN 0 WHEN 'uploading' THEN 0 WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
      priority DESC, id DESC LIMIT 300`);
  return {
    printers: allPrinters().map((p) => printerView(p, staff)),
    requests: rows.map((r) => requestView(r, staff, pos.get(r.id))),
    server_time: nowIso(),
  };
}

// ------------------------------------------------------------------ SSE
const clients = new Set<{ res: Response; staff: boolean }>();
function broadcast() {
  if (!clients.size) return;
  const pub = JSON.stringify(snapshot(false));
  let stf: string | null = null;
  for (const c of clients) {
    if (c.staff && stf === null) stf = JSON.stringify(snapshot(true));
    c.res.write(`event: update\ndata: ${c.staff ? stf : pub}\n\n`);
  }
}

// ------------------------------------------------------------------ job control
const fileExt = (name: string) => (detectFormat(name) === 'bgcode' ? '.bgcode' : '.gcode');

function finishRequest(r: Row, status: 'done' | 'failed' | 'cancelled', error = '') {
  run('UPDATE requests SET status = ?, finished_at = ?, error = ? WHERE id = ?', status, nowIso(), error, r.id);
  if (r.printer_id) run('UPDATE printers SET bed_clear = 0 WHERE id = ?', r.printer_id);
  audit('system', `job-${status}`, r.id, error);
}

async function startJob(id: number, printerId: number, actor: string, ignoreFilament = false): Promise<void> {
  const r = get<Row>('SELECT * FROM requests WHERE id = ?', id);
  const p = get<Row>('SELECT * FROM printers WHERE id = ?', printerId);
  if (!r || !p) throw httpError(404, 'Request or printer not found');
  if (r.status !== 'approved') throw httpError(409, `Request is ${r.status}, not approved`);
  if (!printerAvailable(p)) throw httpError(409, 'Printer is not available (offline, busy or needs attention)');
  const meta: GcodeMeta = JSON.parse(r.meta_json);
  if (!modelEquals(meta.printerModel, p.model)) throw httpError(409, `File is for ${meta.printerModel}, printer is ${p.model}`);
  if (!ignoreFilament && p.loaded_filament_id !== r.filament_id) throw httpError(409, 'The requested filament is not loaded on this printer');
  const claimed = run(`UPDATE requests SET status = 'uploading', printer_id = ?, error = '' WHERE id = ? AND status = 'approved'`, printerId, id);
  if (Number(claimed.changes) !== 1) throw httpError(409, 'Request was already started');
  audit(actor, 'start', id, `printer ${p.name}`);
  broadcast();
  const remote = `MQ${id}${fileExt(r.file_name)}`;
  // upload + start runs in the background; it can take minutes for big files
  void (async () => {
    try {
      await linkFor(p).upload(r.file_path, remote, true);
      run(`UPDATE requests SET status = 'printing', started_at = ?, remote_name = ?, seen_printing = 0, last_progress = 0 WHERE id = ?`, nowIso(), remote, id);
      run('UPDATE printers SET bed_clear = 0 WHERE id = ?', printerId);
      audit('system', 'uploaded', id, remote);
    } catch (e: any) {
      run(`UPDATE requests SET status = 'approved', printer_id = NULL, error = ? WHERE id = ?`, `Start failed: ${e.message}`, id);
      audit('system', 'start-failed', id, e.message);
    }
    broadcast();
  })();
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

async function pollPrinter(p: Row) {
  const link = linkFor(p);
  try {
    const status = await link.status();
    let job: JobInfo | null = null;
    if (status.job?.id !== undefined) { try { job = await link.job(); } catch { /* optional */ } }
    runtime.set(p.id, { online: true, status, job, seen: Date.now() });
  } catch (e: any) {
    runtime.set(p.id, { online: false, error: e.message, seen: runtime.get(p.id)?.seen });
  }
}

function reconcile() {
  for (const r of all<Row>(`SELECT * FROM requests WHERE status = 'printing'`)) {
    const rt = r.printer_id ? runtime.get(r.printer_id) : undefined;
    const state = rt?.status?.printer?.state;
    if (!rt?.online || !state) continue;
    if (ACTIVE_STATES.has(state)) {
      const prog = rt.status?.job?.progress ?? r.last_progress;
      run('UPDATE requests SET seen_printing = 1, last_progress = ? WHERE id = ?', prog, r.id);
      continue;
    }
    const sinceStart = Date.now() - new Date(r.started_at).getTime();
    if (!r.seen_printing && sinceStart < 120_000) continue; // printer has not picked up the job yet
    if (state === 'FINISHED' || ((state === 'IDLE' || state === 'READY') && r.last_progress >= 98)) finishRequest(r, 'done');
    else if (state === 'STOPPED') finishRequest(r, 'failed', 'Print was stopped');
    else if (state === 'ERROR') finishRequest(r, 'failed', 'Printer reported an error');
    else finishRequest(r, 'failed', 'Print ended before completion');
  }
}

function autoDispatch() {
  for (const p of allPrinters()) {
    if (!p.auto_start || !p.bed_clear || !printerAvailable(p)) continue;
    const next = queueOrder().find((r) => eligiblePrinters(r).some((e) => e.id === p.id));
    if (next) startJob(next.id, p.id, 'auto').catch((e) => console.warn('auto start failed:', e.message));
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await Promise.all(allPrinters().filter((p) => p.enabled).map(pollPrinter));
    reconcile();
    autoDispatch();
  } catch (e) { console.error('tick failed', e); }
  finally { ticking = false; broadcast(); }
}

function cleanup() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  for (const r of all<Row>(`SELECT id, file_path FROM requests WHERE status IN ('done','failed','rejected','cancelled') AND COALESCE(finished_at, created_at) < ? AND file_path != ''`, cutoff)) {
    fs.rm(r.file_path, { force: true }, () => {});
    run(`UPDATE requests SET file_path = '' WHERE id = ?`, r.id);
  }
}

// ------------------------------------------------------------------ intake
async function analyse(file: Express.Multer.File, filamentId: number | undefined, rules: Rules) {
  let meta: GcodeMeta | null = null;
  let scan: ScanResult | null = null;
  let parseError: string | undefined;
  const fmt = detectFormat(file.originalname);
  if (fmt) {
    try {
      meta = parseMeta(file.path, file.originalname);
      scan = await scanFile(file.path, file.originalname);
    } catch (e: any) { parseError = e.message; }
  }
  const issues = validate(meta, scan, rules, {
    fileName: file.originalname, fileSize: file.size, filament: filamentRow(filamentId), printers: printerLite(), parseError,
  });
  return { meta, scan, issues };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(12).toString('hex')),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});
const discard = (f?: Express.Multer.File) => { if (f) fs.rm(f.path, { force: true }, () => {}); };

// ------------------------------------------------------------------ app
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

// ---- public
app.get('/api/config', (_req, res) => {
  const rules = getRules();
  res.json({
    version: VERSION, source_url: SOURCE_URL || null,
    rules: { ...rules },
    filaments: all('SELECT * FROM filaments WHERE in_stock = 1 ORDER BY material, colour_name'),
    printer_models: [...new Set(allPrinters().filter((p) => p.enabled).map((p) => p.model).filter(Boolean))],
  });
});

app.get('/api/state', (req, res) => res.json(snapshot(!!staffOf(req))));

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const c = { res, staff: !!staffOf(req) };
  clients.add(c);
  res.write(`event: update\ndata: ${JSON.stringify(snapshot(c.staff))}\n\n`);
  const ka = setInterval(() => res.write(': ka\n\n'), 25_000);
  req.on('close', () => { clearInterval(ka); clients.delete(c); });
});

app.post('/api/validate', upload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  if (!f) return void res.status(400).json({ error: 'No file uploaded' });
  try {
    const fid = req.body.filamentId ? parseInt(req.body.filamentId, 10) : undefined;
    const { meta, issues } = await analyse(f, fid, getRules());
    res.json({ meta, issues, ok: !hasErrors(issues) });
  } finally { discard(f); }
}));

app.post('/api/requests', upload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  if (!f) return void res.status(400).json({ error: 'No file uploaded' });
  let keep = false;
  try {
    const rules = getRules();
    const name = String(req.body.name ?? '').trim().slice(0, 80);
    const email = String(req.body.email ?? '').trim().slice(0, 120);
    const notes = String(req.body.notes ?? '').trim().slice(0, 1000);
    const fid = parseInt(req.body.filamentId, 10);
    const issues0: Issue[] = [];
    if (name.length < 2) issues0.push({ level: 'error', code: 'name', message: 'Please enter your name.' });
    if (rules.requireEmail && !/^\S+@\S+\.\S+$/.test(email)) issues0.push({ level: 'error', code: 'email', message: 'Please enter a valid e-mail address.' });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) issues0.push({ level: 'error', code: 'email', message: 'E-mail address looks invalid.' });
    if (!Number.isFinite(fid) || !filamentRow(fid)) issues0.push({ level: 'error', code: 'filament', message: 'Please choose a filament.' });

    const { meta, issues: issues1 } = await analyse(f, Number.isFinite(fid) ? fid : undefined, rules);
    const issues = [...issues0, ...issues1];

    // per-user limits
    if (name) {
      const active = get<{ n: number }>(`SELECT COUNT(*) AS n FROM requests WHERE lower(user_name) = lower(?) AND status IN ('pending','approved','uploading','printing')`, name)!.n;
      if (rules.maxActivePerUser > 0 && active >= rules.maxActivePerUser) {
        issues.push({ level: 'error', code: 'active-limit', message: `You already have ${active} open requests (limit ${rules.maxActivePerUser}). Wait until one finishes.` });
      }
      if (rules.monthlyGramQuota > 0 && meta?.grams !== undefined) {
        const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
        const used = get<{ g: number | null }>(`SELECT SUM(grams) AS g FROM requests WHERE lower(user_name) = lower(?) AND created_at >= ? AND status NOT IN ('rejected','cancelled')`, name, monthStart)!.g ?? 0;
        if (used + meta.grams > rules.monthlyGramQuota) {
          issues.push({ level: 'error', code: 'quota', message: `Monthly quota exceeded: ${used.toFixed(0)} g used + ${meta.grams.toFixed(0)} g requested > ${rules.monthlyGramQuota} g.` });
        }
      }
    }
    if (hasErrors(issues) || !meta) return void res.status(422).json({ error: 'Validation failed', issues, meta });

    const token = crypto.randomBytes(16).toString('hex');
    const ins = run(
      `INSERT INTO requests(user_name,user_email,filament_id,notes,file_name,file_path,file_size,meta_json,issues_json,grams,seconds,cancel_token)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      name, email, fid, notes, path.basename(f.originalname).slice(0, 200), f.path, f.size,
      JSON.stringify(meta), JSON.stringify(issues), meta.grams ?? null, meta.seconds ?? null, token);
    keep = true;
    const id = Number(ins.lastInsertRowid);
    audit(name, 'submit', id, f.originalname);
    broadcast();
    res.status(201).json({ id, cancel_token: token, issues });
  } finally { if (!keep) discard(f); }
}));

app.post('/api/requests/:id/cancel', wrap((req, res) => {
  const id = parseInt(String(req.params.id), 10);
  const r = get<Row>('SELECT * FROM requests WHERE id = ?', id);
  if (!r) throw httpError(404, 'Not found');
  const staff = staffOf(req);
  const tokenOk = typeof req.body?.token === 'string' && req.body.token === r.cancel_token;
  if (!staff && !tokenOk) throw httpError(403, 'Only the submitter or staff can cancel this request');
  if (!['pending', 'approved'].includes(r.status) && !(staff && ['printing'].includes(r.status))) {
    throw httpError(409, `Cannot cancel a request that is ${r.status}`);
  }
  if (r.status === 'printing') {
    const p = get<Row>('SELECT * FROM printers WHERE id = ?', r.printer_id);
    const jid = runtime.get(r.printer_id)?.status?.job?.id;
    if (p && jid !== undefined) void linkFor(p).stop(jid).catch((e) => console.warn('stop failed', e.message));
  }
  finishRequest(r, 'cancelled', staff ? `Cancelled by ${staff}` : 'Cancelled by submitter');
  broadcast();
  res.json({ ok: true });
}));

// ---- staff
app.post('/api/staff/login', (req, res) => {
  const ip = req.ip ?? 'x';
  const f = loginFails.get(ip);
  if (f && f.n >= 5 && Date.now() - f.t < 10 * 60_000) return void res.status(429).json({ error: 'Too many attempts, try again later' });
  const pw = String(req.body?.password ?? '');
  const a = Buffer.from(crypto.createHash('sha256').update(pw).digest());
  const b = Buffer.from(crypto.createHash('sha256').update(STAFF_PASSWORD).digest());
  if (!crypto.timingSafeEqual(a, b)) {
    loginFails.set(ip, { n: (f && Date.now() - f.t < 10 * 60_000 ? f.n : 0) + 1, t: Date.now() });
    return void res.status(401).json({ error: 'Wrong password' });
  }
  loginFails.delete(ip);
  const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'staff';
  res.setHeader('Set-Cookie', `mq_staff=${encodeURIComponent(makeToken(name))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
  audit(name, 'login');
  res.json({ ok: true, name });
});
app.post('/api/staff/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'mq_staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/staff/me', (req, res) => res.json({ staff: staffOf(req) }));

const staff = express.Router();
staff.use(requireStaff);
const actor = (req: Request) => (req as any).staff as string;

staff.post('/requests/:id/approve', wrap((req, res) => {
  const id = parseInt(String(req.params.id), 10);
  const r = get<Row>('SELECT * FROM requests WHERE id = ?', id);
  if (!r) throw httpError(404, 'Not found');
  if (r.status !== 'pending') throw httpError(409, `Request is ${r.status}`);
  if (!r.file_path || !fs.existsSync(r.file_path)) throw httpError(410, 'G-code file is gone');
  run(`UPDATE requests SET status = 'approved', approved_at = ?, reviewed_by = ? WHERE id = ?`, nowIso(), actor(req), id);
  audit(actor(req), 'approve', id);
  broadcast(); res.json({ ok: true });
}));
staff.post('/requests/:id/reject', wrap((req, res) => {
  const id = parseInt(String(req.params.id), 10);
  const reason = String(req.body?.reason ?? '').trim().slice(0, 500);
  if (!reason) throw httpError(400, 'Please give a reason');
  const r = get<Row>('SELECT * FROM requests WHERE id = ?', id);
  if (!r) throw httpError(404, 'Not found');
  if (!['pending', 'approved'].includes(r.status)) throw httpError(409, `Request is ${r.status}`);
  run(`UPDATE requests SET status = 'rejected', reject_reason = ?, reviewed_by = ?, finished_at = ? WHERE id = ?`, reason, actor(req), nowIso(), id);
  audit(actor(req), 'reject', id, reason);
  broadcast(); res.json({ ok: true });
}));
staff.post('/requests/:id/priority', wrap((req, res) => {
  const id = parseInt(String(req.params.id), 10);
  const delta = Math.max(-10, Math.min(10, parseInt(req.body?.delta ?? '0', 10) || 0));
  run(`UPDATE requests SET priority = priority + ? WHERE id = ? AND status IN ('pending','approved')`, delta, id);
  audit(actor(req), 'priority', id, String(delta));
  broadcast(); res.json({ ok: true });
}));
staff.post('/requests/:id/start', wrap(async (req, res) => {
  await startJob(parseInt(String(req.params.id), 10), parseInt(req.body?.printerId, 10), actor(req), !!req.body?.ignoreFilament);
  res.status(202).json({ ok: true });
}));
staff.get('/requests/:id/file', wrap((req, res) => {
  const r = get<Row>('SELECT * FROM requests WHERE id = ?', parseInt(String(req.params.id), 10));
  if (!r || !r.file_path || !fs.existsSync(r.file_path)) throw httpError(404, 'File not available');
  res.download(r.file_path, r.file_name);
}));
staff.get('/export.csv', (_req, res) => {
  const rows = all<Row>('SELECT r.*, p.name AS printer_name, f.material, f.colour_name FROM requests r LEFT JOIN printers p ON p.id = r.printer_id LEFT JOIN filaments f ON f.id = r.filament_id ORDER BY r.id');
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['id', 'created_at', 'user_name', 'user_email', 'status', 'file_name', 'material', 'colour', 'grams', 'seconds', 'printer', 'started_at', 'finished_at', 'reviewed_by', 'reject_reason', 'error'];
  const lines = rows.map((r) => [r.id, r.created_at, r.user_name, r.user_email, r.status, r.file_name, r.material, r.colour_name, r.grams, r.seconds, r.printer_name, r.started_at, r.finished_at, r.reviewed_by, r.reject_reason, r.error].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="3dpmq-export.csv"');
  res.send([head.join(','), ...lines].join('\n'));
});

// printers
const printerBody = (b: Row) => ({
  name: String(b.name ?? '').trim().slice(0, 60),
  base_url: String(b.base_url ?? '').trim().replace(/\/+$/, ''),
  username: String(b.username ?? 'maker').trim() || 'maker',
  password: b.password === undefined ? undefined : String(b.password),
  storage: String(b.storage ?? 'usb').trim().replace(/^\/+|\/+$/g, '') || 'usb',
  model: String(b.model ?? '').trim().slice(0, 30),
  nozzle: b.nozzle === '' || b.nozzle == null ? null : Number(b.nozzle),
  enabled: b.enabled === undefined ? 1 : b.enabled ? 1 : 0,
  auto_start: b.auto_start ? 1 : 0,
});
function checkPrinter(p: ReturnType<typeof printerBody>) {
  if (!p.name) throw httpError(400, 'Name is required');
  if (!/^https?:\/\/[^\s/]+/.test(p.base_url)) throw httpError(400, 'Address must look like http://192.168.1.50');
  if (p.nozzle !== null && !(p.nozzle > 0 && p.nozzle < 2)) throw httpError(400, 'Nozzle must be between 0 and 2 mm');
}
staff.post('/printers', wrap((req, res) => {
  const p = printerBody(req.body); checkPrinter(p);
  const r = run('INSERT INTO printers(name,base_url,username,password,storage,model,nozzle,enabled,auto_start) VALUES (?,?,?,?,?,?,?,?,?)',
    p.name, p.base_url, p.username, p.password ?? '', p.storage, p.model, p.nozzle, p.enabled, p.auto_start);
  audit(actor(req), 'printer-add', undefined, p.name);
  void tick(); res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
staff.put('/printers/:id', wrap((req, res) => {
  const id = parseInt(String(req.params.id), 10);
  const old = get<Row>('SELECT * FROM printers WHERE id = ?', id);
  if (!old) throw httpError(404, 'Not found');
  const p = printerBody(req.body); checkPrinter(p);
  run('UPDATE printers SET name=?,base_url=?,username=?,password=?,storage=?,model=?,nozzle=?,enabled=?,auto_start=? WHERE id=?',
    p.name, p.base_url, p.username, p.password === undefined || p.password === '' ? old.password : p.password, p.storage, p.model, p.nozzle, p.enabled, p.auto_start, id);
  audit(actor(req), 'printer-edit', undefined, p.name);
  void tick(); res.json({ ok: true });
}));
staff.delete('/printers/:id', wrap((req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (get('SELECT 1 FROM requests WHERE printer_id = ? AND status IN (\'printing\',\'uploading\')', id)) throw httpError(409, 'Printer has a running job');
  run('DELETE FROM printers WHERE id = ?', id);
  runtime.delete(id); audit(actor(req), 'printer-delete', undefined, String(id));
  broadcast(); res.json({ ok: true });
}));
staff.post('/printers/:id/bed-clear', wrap((req, res) => {
  run('UPDATE printers SET bed_clear = ? WHERE id = ?', req.body?.clear === false ? 0 : 1, parseInt(String(req.params.id), 10));
  audit(actor(req), 'bed-clear', undefined, String(req.params.id));
  void tick(); res.json({ ok: true });
}));
staff.post('/printers/:id/loaded', wrap((req, res) => {
  const fid = req.body?.filamentId ? parseInt(req.body.filamentId, 10) : null;
  if (fid !== null && !filamentRow(fid)) throw httpError(400, 'Unknown filament');
  run('UPDATE printers SET loaded_filament_id = ? WHERE id = ?', fid, parseInt(String(req.params.id), 10));
  audit(actor(req), 'filament-loaded', undefined, `${req.params.id}:${fid}`);
  broadcast(); res.json({ ok: true });
}));
staff.post('/printers/:id/:action', wrap(async (req, res) => {
  if (!['pause', 'resume', 'stop'].includes(String(req.params.action))) throw httpError(404, 'Unknown action');
  const p = get<Row>('SELECT * FROM printers WHERE id = ?', parseInt(String(req.params.id), 10));
  if (!p) throw httpError(404, 'Not found');
  const jid = runtime.get(p.id)?.status?.job?.id;
  if (jid === undefined) throw httpError(409, 'No running job on this printer');
  const l = linkFor(p);
  await (String(req.params.action) === 'pause' ? l.pause(jid) : String(req.params.action) === 'resume' ? l.resume(jid) : l.stop(jid));
  audit(actor(req), `printer-${String(req.params.action)}`, undefined, p.name);
  void tick(); res.json({ ok: true });
}));
staff.post('/printers/test', wrap(async (req, res) => {
  const p = printerBody(req.body);
  let pw = p.password ?? '';
  if (req.body?.id && !pw) pw = get<Row>('SELECT password FROM printers WHERE id = ?', parseInt(req.body.id, 10))?.password ?? '';
  const l = new PrusaLink({ base_url: p.base_url, username: p.username, password: pw, storage: p.storage }, 4000);
  try { const s = await l.status(); res.json({ ok: true, state: s.printer?.state ?? 'UNKNOWN' }); }
  catch (e: any) { res.json({ ok: false, error: e.message }); }
}));

// filaments
const filBody = (b: Row) => ({
  material: String(b.material ?? '').trim().toUpperCase().slice(0, 20),
  colour_name: String(b.colour_name ?? '').trim().slice(0, 40),
  colour_hex: /^#[0-9a-fA-F]{6}$/.test(String(b.colour_hex)) ? String(b.colour_hex) : '#cccccc',
  in_stock: b.in_stock === undefined || b.in_stock ? 1 : 0,
});
staff.post('/filaments', wrap((req, res) => {
  const f = filBody(req.body);
  if (!f.material || !f.colour_name) throw httpError(400, 'Material and colour name are required');
  const r = run('INSERT INTO filaments(material,colour_name,colour_hex,in_stock) VALUES (?,?,?,?)', f.material, f.colour_name, f.colour_hex, f.in_stock);
  broadcast(); res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
staff.put('/filaments/:id', wrap((req, res) => {
  const f = filBody(req.body);
  run('UPDATE filaments SET material=?,colour_name=?,colour_hex=?,in_stock=? WHERE id=?', f.material, f.colour_name, f.colour_hex, f.in_stock, parseInt(String(req.params.id), 10));
  broadcast(); res.json({ ok: true });
}));
staff.delete('/filaments/:id', wrap((req, res) => {
  run('DELETE FROM filaments WHERE id = ?', parseInt(String(req.params.id), 10));
  broadcast(); res.json({ ok: true });
}));
staff.get('/filaments', (_req, res) => res.json(all('SELECT * FROM filaments ORDER BY material, colour_name')));

// rules
staff.get('/rules', (_req, res) => res.json(getRules()));
staff.put('/rules', wrap((req, res) => {
  const b = req.body ?? {};
  const n = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const cur = getRules();
  const next: Partial<Rules> = {
    allowedMaterials: Array.isArray(b.allowedMaterials) ? b.allowedMaterials.map((m: any) => String(m).trim().toUpperCase()).filter(Boolean) : cur.allowedMaterials,
    maxHours: n(b.maxHours, cur.maxHours), maxGrams: n(b.maxGrams, cur.maxGrams),
    maxNozzleTemp: n(b.maxNozzleTemp, cur.maxNozzleTemp), maxBedTemp: n(b.maxBedTemp, cur.maxBedTemp),
    maxFileMB: n(b.maxFileMB, cur.maxFileMB), maxActivePerUser: n(b.maxActivePerUser, cur.maxActivePerUser),
    monthlyGramQuota: n(b.monthlyGramQuota, cur.monthlyGramQuota),
    requirePrusaSlicer: b.requirePrusaSlicer ?? cur.requirePrusaSlicer, allowMulticolor: b.allowMulticolor ?? cur.allowMulticolor,
    requireEmail: b.requireEmail ?? cur.requireEmail,
  };
  audit(actor(req), 'rules', undefined, JSON.stringify(next));
  res.json(setRules(next));
}));
staff.get('/audit', (_req, res) => res.json(all('SELECT * FROM audit ORDER BY id DESC LIMIT 200')));
app.use('/api/staff', staff);

// ---- errors
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) return void res.status(413).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_UPLOAD_MB} MB` : err.message });
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
});

// ------------------------------------------------------------------ boot
app.listen(PORT, () => {
  console.log(`3DPMQ v${VERSION} listening on http://localhost:${PORT}  (data: ${DATA_DIR})`);
  void tick();
  setInterval(() => void tick(), POLL_MS);
  setInterval(cleanup, 3600_000);
  cleanup();
});
// jobs left in "uploading" by a crash would block their printer forever: put them back in the queue
run(`UPDATE requests SET status = 'approved', printer_id = NULL, error = 'Server restarted during upload' WHERE status = 'uploading'`);
