/** Existing data (no classes table yet) is upgraded: used classes become entries, spelling is unified. Run: npx tsx test/classes-migration.ts */
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-cm-'));
const db = new DatabaseSync(path.join(dir, '3dpmq.db'));
// the database as version 0.13 left it: users with free-text classes, no classes table
db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', class TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'student', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT '', user_name TEXT NOT NULL DEFAULT '', user_email TEXT NOT NULL DEFAULT '', filament_id INTEGER, notes TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '', file_path TEXT NOT NULL DEFAULT '', file_size INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}', issues_json TEXT NOT NULL DEFAULT '[]', grams REAL, seconds INTEGER, status TEXT NOT NULL DEFAULT 'done', reject_reason TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL DEFAULT '', approved_at TEXT, priority INTEGER NOT NULL DEFAULT 0, printer_id INTEGER, started_at TEXT, finished_at TEXT, last_progress REAL NOT NULL DEFAULT 0, seen_printing INTEGER NOT NULL DEFAULT 0, remote_name TEXT NOT NULL DEFAULT '', cancel_token TEXT NOT NULL DEFAULT 'x', error TEXT NOT NULL DEFAULT '', user_id INTEGER, user_class TEXT NOT NULL DEFAULT '', material TEXT NOT NULL DEFAULT '', printed_grams REAL NOT NULL DEFAULT 0, printed_seconds INTEGER NOT NULL DEFAULT 0, last_time_printing INTEGER NOT NULL DEFAULT 0);
  INSERT INTO settings VALUES ('migrated_users_v1', 'x');
  INSERT INTO users(name, email, class) VALUES ('A', 'a@x.org', '2CE'), ('B', 'b@x.org', '2ce'), ('C', 'c@x.org', ' 10  CE '), ('D', 'd@x.org', ''), ('E', 'e@x.org', '3GE');
  INSERT INTO requests(user_id, user_name, user_class) VALUES (2, 'B', '2ce');`);
db.close();

// opening the database with the current code runs the migration
const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '-e',
  `import { db, classList } from './src/db.ts'; console.log(JSON.stringify({ classes: classList(), users: db.prepare('SELECT id, class FROM users ORDER BY id').all(), req: db.prepare('SELECT user_class FROM requests').all() }));`],
  { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
let fail = 0;
const ok = (c: unknown, m: string) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fail++; };
ok(JSON.stringify(out.classes) === JSON.stringify(['2CE', '3GE', '10 CE']), `classes created from existing people, naturally sorted: ${out.classes.join(', ')}`);
ok(out.users.map((u: any) => u.class).join('|') === '2CE|2CE|10 CE||3GE', `spelling unified, blanks stay blank: ${out.users.map((u: any) => `"${u.class}"`).join(' ')}`);
ok(out.req[0].user_class === '2CE', 'requests follow the unified spelling');
const again = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '-e', `import { classList } from './src/db.ts'; console.log(JSON.stringify(classList()));`], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
ok(JSON.parse(again.stdout.trim().split('\n').pop()!).length === 3, 'starting again does not duplicate anything');
fs.rmSync(dir, { recursive: true, force: true });
console.log(fail ? `${fail} failed` : 'Migration test passed');
process.exit(fail ? 1 : 0);
