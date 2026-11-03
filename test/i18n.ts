// Translation completeness: every language has exactly the same keys and {placeholders}, and every key the
// code asks for exists. Run with: tsx test/i18n.ts
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const langs = ['en', 'fr', 'de'];
const dict: Record<string, Record<string, string>> = {};
for (const l of langs) dict[l] = JSON.parse(fs.readFileSync(path.join(root, 'public', 'lang', `${l}.json`), 'utf8'));
let bad = 0, n = 0;
const ok = (c: unknown, m: string) => { n++; if (!c) { bad++; console.error('FAIL', m); } };
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

// 1. same keys, same placeholders, nothing empty
const enKeys = Object.keys(dict.en).sort();
for (const l of langs.slice(1)) {
  const ks = Object.keys(dict[l]).sort();
  ok(JSON.stringify(ks) === JSON.stringify(enKeys), `${l}: key set differs from en (missing: ${enKeys.filter((k) => !(k in dict[l])).join(', ')}; extra: ${ks.filter((k) => !(k in dict.en)).join(', ')})`);
}
for (const k of enKeys) for (const l of langs) {
  const v = dict[l][k];
  if (v === undefined) continue;
  ok(typeof v === 'string' && v.trim() !== '', `${l}:${k} is empty`);
  ok(ph(v) === ph(dict.en[k]), `${l}:${k} placeholders {${ph(v)}} differ from en {${ph(dict.en[k])}}`);
  ok(/<[^>]+>/.test(v) === /<[^>]+>/.test(dict.en[k]), `${l}:${k} HTML markup differs from en`);
}
// translations really are translations (a few spot checks that catch an untranslated copy)
for (const k of ['nav.submit', 'form.send', 'staff.login']) { ok(dict.fr[k] !== dict.en[k], `fr:${k} is not translated`); ok(dict.de[k] !== dict.en[k], `de:${k} is not translated`); }

// 2. every key used by the client code exists
const has = (k: string) => k in dict.en || `${k}.one` in dict.en;
for (const f of ['app.js', 'preview.js']) {
  for (const m of read('public', f).matchAll(/\b(?:t|th)\('([\w.\-]*[\w\-])'/g)) ok(has(m[1]), `${f}: unknown key ${m[1]}`);
}
for (const f of ['index.html', 'preview.html']) {
  for (const m of read('public', f).matchAll(/data-i18n[\w-]*="([\w.\-]+)"/g)) ok(has(m[1]), `${f}: unknown key ${m[1]}`);
  for (const m of read('public', f).matchAll(/data-title="([\w.\-]+)"/g)) ok(has(m[1]), `${f}: unknown title key ${m[1]}`);
}
// dynamic label families: every value that can occur has a label
for (const v of ['pending', 'approved', 'uploading', 'printing', 'done', 'rejected', 'cancelled', 'failed', 'IDLE', 'READY', 'FINISHED', 'STOPPED', 'PRINTING', 'PAUSED', 'BUSY', 'ATTENTION', 'OFFLINE', 'ERROR', 'UNKNOWN', 'DISABLED']) ok(has(`status.${v}`), `missing status.${v}`);
for (const v of ['student', 'staff', 'other']) ok(has(`role.${v}`), `missing role.${v}`);
for (const v of ['pause', 'resume', 'stop']) ok(has(`act.${v}`), `missing act.${v}`);

// 3. every code the server can send exists (errors: err.<code>, validation issues: iss.<key>)
for (const f of ['server.ts', 'people.ts']) {
  for (const m of read('src', f).matchAll(/httpError\(\d+,\s*'(\w+)'/g)) ok(has(`err.${m[1]}`), `${f}: unknown error code ${m[1]}`);
  for (const m of read('src', f).matchAll(/msg\('err\.(\w+)'/g)) ok(has(`err.${m[1]}`), `${f}: unknown error code ${m[1]}`);
  for (const m of read('src', f).matchAll(/\bmk\('(?:error|warn|info)',\s*'([\w-]+)'/g)) ok(has(`iss.${m[1]}`), `${f}: unknown issue ${m[1]}`);
}
for (const line of read('src', 'gcode.ts').split('\n').filter((l) => /\b(?:err|warn|info)\(/.test(l))) {
  for (const m of line.matchAll(/'([a-z]+(?:-[a-z]+)*)'/g)) if (m[1] !== 'printer-model') ok(has(`iss.${m[1]}`), `gcode.ts: unknown issue ${m[1]}`);
}
// 4. every key in en.json is used somewhere (finds stale keys); dynamic families are exempt
const code = ['public/app.js', 'public/preview.js', 'public/index.html', 'public/preview.html', 'src/server.ts', 'src/people.ts', 'src/gcode.ts'].map((p) => read(p)).join('\n');
for (const k of enKeys) {
  const base = /\.(one|other)$/.test(k) && `${k.replace(/\.(one|other)$/, '')}.${k.endsWith('.one') ? 'other' : 'one'}` in dict.en ? k.replace(/\.(one|other)$/, '') : k;
  if (/^(status|role|type|act|err|iss)\./.test(base)) continue;
  ok(code.includes(`'${base}'`) || code.includes(`"${base}"`), `unused key ${base}`);
}

console.log(`${n - bad}/${n} i18n checks passed`);
if (bad) process.exit(1);
