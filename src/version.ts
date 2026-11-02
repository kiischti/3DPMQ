import fs from 'node:fs';

/** Single source of truth for the version: package.json (works from src/ and from dist/, also in Docker). */
export const VERSION: string = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'; }
  catch { return 'unknown'; }
})();

/** Optional link to the source code (AGPL section 13 asks hosted modified copies to offer it). */
export const SOURCE_URL: string = (process.env.SOURCE_URL ?? '').trim();
