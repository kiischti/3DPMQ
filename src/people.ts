import type { NextFunction, Request, Response, Router } from 'express';
import fs from 'node:fs';
import { EMAIL_RE, ROLES, audit, db, normEmail } from './db.js';

type Row = Record<string, any>;
const all = <T = Row>(sql: string, ...p: any[]): T[] => db.prepare(sql).all(...p) as unknown as T[];
const get = <T = Row>(sql: string, ...p: any[]): T | undefined => db.prepare(sql).get(...p) as unknown as T | undefined;
const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

interface Deps {
  wrap: (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => void;
  actor: (req: Request) => string;
  httpError: (status: number, message: string) => Error;
  broadcast: () => void;
}

const OPEN = `('pending','approved','uploading','printing')`;
// A request counts for the statistics when something was printed (finished, or stopped part-way).
const printed = (a = '') => `${a}status IN ('done','failed','cancelled') AND (${a}status = 'done' OR ${a}printed_grams > 0 OR ${a}printed_seconds > 0)`;
const PRINTED = printed();

export interface MaterialStat { material: string; prints: number; partial: number; grams: number; seconds: number }
const round = (n: number) => Math.round((n ?? 0) * 100) / 100;

function materialStats(whereUser?: number): Map<number, MaterialStat[]> {
  const rows = all(
    `SELECT user_id, COALESCE(NULLIF(material, ''), '?') AS material,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS prints,
            SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS partial,
            SUM(printed_grams) AS grams, SUM(printed_seconds) AS seconds
       FROM requests WHERE user_id IS NOT NULL AND ${PRINTED} ${whereUser ? 'AND user_id = ?' : ''}
      GROUP BY user_id, material ORDER BY grams DESC`, ...(whereUser ? [whereUser] : []));
  const m = new Map<number, MaterialStat[]>();
  for (const r of rows) {
    if (!m.has(r.user_id)) m.set(r.user_id, []);
    m.get(r.user_id)!.push({ material: r.material, prints: r.prints, partial: r.partial, grams: round(r.grams), seconds: r.seconds ?? 0 });
  }
  return m;
}

const totals = (by: MaterialStat[] = []) => ({
  prints: by.reduce((a, b) => a + b.prints, 0),
  partial: by.reduce((a, b) => a + b.partial, 0),
  grams: round(by.reduce((a, b) => a + b.grams, 0)),
  seconds: by.reduce((a, b) => a + b.seconds, 0),
});

function userList(q: string, role: string, cls: string): Row[] {
  const where: string[] = [], args: any[] = [];
  if (q) { where.push('(u.name LIKE ? OR u.email LIKE ? OR u.class LIKE ?)'); const like = `%${q.replace(/[%_]/g, '')}%`; args.push(like, like, like); }
  if (role) { where.push('u.role = ?'); args.push(role); }
  if (cls) { where.push(cls === '(none)' ? "u.class = ''" : 'u.class = ? COLLATE NOCASE'); if (cls !== '(none)') args.push(cls); }
  const users = all(
    `SELECT u.*, (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id) AS requests_total,
            (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id AND r.status IN ${OPEN}) AS open_requests,
            (SELECT MAX(r.finished_at) FROM requests r WHERE r.user_id = u.id AND ${printed('r.')}) AS last_print
       FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.name COLLATE NOCASE`, ...args);
  const stats = materialStats();
  return users.map((u) => ({ ...u, by_material: stats.get(u.id) ?? [], ...totals(stats.get(u.id)) }));
}

function validateUser(b: Row, d: Deps, id?: number) {
  const name = String(b.name ?? '').trim().slice(0, 80);
  const email = normEmail(b.email).slice(0, 120);
  const cls = String(b.class ?? '').trim().slice(0, 40);
  const role = String(b.role ?? 'student');
  const notes = String(b.notes ?? '').trim().slice(0, 1000);
  if (name.length < 2) throw d.httpError(400, 'Name is required');
  if (!EMAIL_RE.test(email)) throw d.httpError(400, 'A valid e-mail address is required');
  if (!(ROLES as readonly string[]).includes(role)) throw d.httpError(400, 'Role must be student, staff or other');
  const dup = get<Row>('SELECT id FROM users WHERE email = ? AND id != ?', email, id ?? -1);
  if (dup) throw d.httpError(409, 'Another person already uses this e-mail address');
  return { name, email, class: cls, role, notes };
}

function removeFiles(rows: Row[]) {
  for (const r of rows) if (r.file_path) fs.rm(r.file_path, { force: true }, () => {});
}

export function peopleRoutes(staff: Router, d: Deps) {
  // ---- people
  staff.get('/users', d.wrap((req, res) => {
    res.json(userList(String(req.query.q ?? '').trim(), String(req.query.role ?? ''), String(req.query.class ?? '')));
  }));

  staff.get('/users/export.csv', d.wrap((_req, res) => {
    const users = userList('', '', '');
    const mats = [...new Set(users.flatMap((u) => u.by_material.map((m: MaterialStat) => m.material)))].sort();
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['id', 'name', 'email', 'class', 'role', 'notes', 'created_at', 'requests', 'prints_done', 'grams_total', 'print_hours_total', ...mats.map((m) => `grams_${m}`), ...mats.map((m) => `hours_${m}`)];
    const lines = users.map((u) => {
      const by = new Map<string, MaterialStat>(u.by_material.map((m: MaterialStat) => [m.material, m]));
      return [u.id, u.name, u.email, u.class, u.role, u.notes, u.created_at, u.requests_total, u.prints, u.grams, round(u.seconds / 3600),
        ...mats.map((m) => by.get(m)?.grams ?? 0), ...mats.map((m) => round((by.get(m)?.seconds ?? 0) / 3600))].map(esc).join(',');
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="3dpmq-people.csv"');
    res.send('﻿' + [head.join(','), ...lines].join('\n'));
  }));

  staff.get('/users/:id', d.wrap((req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const u = get<Row>('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw d.httpError(404, 'Not found');
    const by = materialStats(id).get(id) ?? [];
    const months = all(
      `SELECT strftime('%Y-%m', COALESCE(finished_at, created_at)) AS month, COALESCE(NULLIF(material, ''), '?') AS material,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS prints, SUM(printed_grams) AS grams, SUM(printed_seconds) AS seconds
         FROM requests WHERE user_id = ? AND ${PRINTED} GROUP BY month, material ORDER BY month DESC, material`, id)
      .map((r) => ({ ...r, grams: round(r.grams) }));
    const requests = all(
      `SELECT id, created_at, finished_at, status, file_name, material, grams, seconds, printed_grams, printed_seconds, reject_reason
         FROM requests WHERE user_id = ? ORDER BY id DESC LIMIT 100`, id);
    res.json({ user: u, by_material: by, totals: totals(by), by_month: months, requests });
  }));

  staff.post('/users', d.wrap((req, res) => {
    const u = validateUser(req.body ?? {}, d);
    const id = Number(run('INSERT INTO users(name, email, class, role, notes) VALUES (?,?,?,?,?)', u.name, u.email, u.class, u.role, u.notes).lastInsertRowid);
    audit(d.actor(req), 'user-add', undefined, `#${id}`);
    d.broadcast();
    res.status(201).json({ id });
  }));

  staff.put('/users/:id', d.wrap((req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!get('SELECT 1 FROM users WHERE id = ?', id)) throw d.httpError(404, 'Not found');
    const u = validateUser(req.body ?? {}, d, id);
    run("UPDATE users SET name=?, email=?, class=?, role=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", u.name, u.email, u.class, u.role, u.notes, id);
    // keep the copies on the person's requests in step, so queue and history show the corrected data
    run('UPDATE requests SET user_name=?, user_email=?, user_class=? WHERE user_id=?', u.name, u.email, u.class, id);
    audit(d.actor(req), 'user-edit', undefined, `#${id}`);
    d.broadcast();
    res.json({ ok: true });
  }));

  /** mode=anonymize (default): remove the person and all personal data, keep anonymous print statistics.
   *  mode=purge: also delete all of their requests and files. */
  staff.delete('/users/:id', d.wrap((req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const mode = String(req.query.mode ?? 'anonymize') === 'purge' ? 'purge' : 'anonymize';
    const u = get<Row>('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw d.httpError(404, 'Not found');
    const open = get<{ n: number }>(`SELECT COUNT(*) AS n FROM requests WHERE user_id = ? AND status IN ${OPEN}`, id)!.n;
    if (open > 0) throw d.httpError(409, `${u.name} has ${open} open request(s). Reject or cancel them first.`);
    const reqs = all('SELECT id, file_path FROM requests WHERE user_id = ?', id);
    db.exec('BEGIN');
    try {
      removeFiles(reqs);
      if (mode === 'purge') run('DELETE FROM requests WHERE user_id = ?', id);
      else run("UPDATE requests SET user_id = NULL, user_name = 'Deleted user', user_email = '', user_class = '', notes = '', file_name = '(removed)', file_path = '', issues_json = '[]' WHERE user_id = ?", id);
      // scrub the audit trail of this person's name / e-mail as well
      run("UPDATE audit SET actor = '(deleted user)', detail = '' WHERE action = 'submit' AND request_id IN (SELECT id FROM requests WHERE user_id IS NULL AND user_name = 'Deleted user') AND actor = ?", u.name);
      run("DELETE FROM audit WHERE action = 'user-created' AND detail = ?", u.email);
      run('DELETE FROM users WHERE id = ?', id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(d.actor(req), 'user-delete', undefined, `#${id} ${mode}`);
    d.broadcast();
    res.json({ ok: true, mode });
  }));

  // ---- statistics overview
  staff.get('/stats', d.wrap((_req, res) => {
    const byMat = all(
      `SELECT COALESCE(NULLIF(material, ''), '?') AS material, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS prints,
              SUM(printed_grams) AS grams, SUM(printed_seconds) AS seconds FROM requests WHERE ${PRINTED} GROUP BY material ORDER BY grams DESC`)
      .map((r): Row => ({ ...r, grams: round(r.grams) }));
    const byClass = all(
      `SELECT COALESCE(NULLIF(u.class, ''), '(none)') AS class, COUNT(DISTINCT u.id) AS people,
              SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS prints, SUM(r.printed_grams) AS grams, SUM(r.printed_seconds) AS seconds
         FROM users u LEFT JOIN requests r ON r.user_id = u.id AND ${printed('r.')}
        GROUP BY u.class COLLATE NOCASE ORDER BY u.class COLLATE NOCASE`).map((r) => ({ ...r, grams: round(r.grams ?? 0), seconds: r.seconds ?? 0, prints: r.prints ?? 0 }));
    const byMonth = all(
      `SELECT strftime('%Y-%m', COALESCE(finished_at, created_at)) AS month, COALESCE(NULLIF(material, ''), '?') AS material,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS prints, SUM(printed_grams) AS grams, SUM(printed_seconds) AS seconds
         FROM requests WHERE ${PRINTED} GROUP BY month, material ORDER BY month DESC, material LIMIT 120`).map((r) => ({ ...r, grams: round(r.grams) }));
    const people = get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
    res.json({
      people,
      prints: byMat.reduce((a, b) => a + b.prints, 0), grams: round(byMat.reduce((a, b) => a + b.grams, 0)), seconds: byMat.reduce((a, b) => a + (b.seconds ?? 0), 0),
      by_material: byMat, by_class: byClass, by_month: byMonth,
    });
  }));

  // ---- clearing finished-without-printing requests
  const CLEARABLE = `(status = 'rejected' OR (status = 'cancelled' AND started_at IS NULL))`;
  staff.post('/requests/clear-refused', d.wrap((req, res) => {
    const rows = all(`SELECT id, file_path FROM requests WHERE ${CLEARABLE}`);
    removeFiles(rows);
    run(`DELETE FROM requests WHERE ${CLEARABLE}`);
    audit(d.actor(req), 'clear-refused', undefined, `${rows.length} request(s)`);
    d.broadcast();
    res.json({ ok: true, removed: rows.length });
  }));

  staff.delete('/requests/:id', d.wrap((req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const r = get<Row>(`SELECT id, file_path, status, started_at FROM requests WHERE id = ? AND ${CLEARABLE}`, id);
    if (!r) throw d.httpError(409, 'Only refused or cancelled requests that never started can be removed');
    removeFiles([r]);
    run('DELETE FROM requests WHERE id = ?', id);
    audit(d.actor(req), 'request-delete', id);
    d.broadcast();
    res.json({ ok: true });
  }));
}
