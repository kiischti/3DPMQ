// Server side of the translation system. The server only ever builds ENGLISH text (for logs, API
// clients and as a fallback); every error and validation issue also carries a stable `code` and
// `params`, and the web page translates those into the selected language (public/lang/*.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'lang');
export const LANGS = ['en', 'fr', 'de'] as const;
export type Params = Record<string, string | number>;

export function loadDict(lang: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8'));
}
const en = loadDict('en');

/** Fill {placeholders}; with a numeric `n` the key's `.one` / `.other` variant is chosen. */
export function msg(key: string, params: Params = {}): string {
  let tpl = en[key];
  if (tpl === undefined && typeof params.n === 'number') tpl = en[`${key}.${params.n === 1 ? 'one' : 'other'}`];
  if (tpl === undefined) return key;
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
}

export function httpError(status: number, code: string, params: Params = {}) {
  return Object.assign(new Error(msg(`err.${code}`, params)), { status, code, params });
}
