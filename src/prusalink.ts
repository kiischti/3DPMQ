import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Minimal PrusaLink v1 client (HTTP Digest auth).
 * Endpoints used (from Prusa-Link-Web spec/openapi.yaml):
 *   GET    /api/v1/status                      printer + job telemetry
 *   GET    /api/v1/job                         current job (204 when none)
 *   PUT    /api/v1/files/{storage}/{path}      upload; headers Print-After-Upload / Overwrite = ?0 | ?1
 *   POST   /api/v1/files/{storage}/{path}      start printing an uploaded file (409 if busy)
 *   PUT    /api/v1/job/{id}/pause | resume
 *   DELETE /api/v1/job/{id}                    stop job
 */
export interface Conn { base_url: string; username: string; password: string; storage: string }

export interface PrinterStatus {
  printer?: {
    state?: string; temp_nozzle?: number; target_nozzle?: number; temp_bed?: number; target_bed?: number;
    axis_z?: number; flow?: number; speed?: number;
  };
  job?: { id?: number; progress?: number; time_remaining?: number; time_printing?: number };
  storage?: unknown;
}
export interface JobInfo {
  id?: number; state?: string; progress?: number; time_remaining?: number; time_printing?: number;
  file?: { name?: string; display_name?: string; path?: string };
}

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

interface DigestState { realm: string; nonce: string; opaque?: string; qop?: string; algorithm: string; nc: number }

const hash = (alg: string, s: string) =>
  crypto.createHash(alg.toLowerCase().startsWith('sha-256') ? 'sha256' : 'md5').update(s).digest('hex');

function parseChallenge(h: string | undefined): DigestState | null {
  if (!h || !/^\s*digest/i.test(h)) return null;
  const f: Record<string, string> = {};
  for (const m of h.replace(/^\s*digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) f[m[1].toLowerCase()] = m[2] ?? m[3];
  if (!f.nonce) return null;
  return { realm: f.realm ?? '', nonce: f.nonce, opaque: f.opaque, qop: f.qop?.split(',')[0].trim(), algorithm: f.algorithm ?? 'MD5', nc: 0 };
}

export class PrusaLink {
  private digest: DigestState | null = null;
  constructor(private conn: Conn, private timeoutMs = 5000) {}

  private authHeader(method: string, uri: string): string | undefined {
    const d = this.digest;
    if (!d) return undefined;
    d.nc++;
    const nc = d.nc.toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ha1 = hash(d.algorithm, `${this.conn.username}:${d.realm}:${this.conn.password}`);
    const ha2 = hash(d.algorithm, `${method}:${uri}`);
    const response = d.qop
      ? hash(d.algorithm, `${ha1}:${d.nonce}:${nc}:${cnonce}:${d.qop}:${ha2}`)
      : hash(d.algorithm, `${ha1}:${d.nonce}:${ha2}`);
    let h = `Digest username="${this.conn.username}", realm="${d.realm}", nonce="${d.nonce}", uri="${uri}", algorithm=${d.algorithm}, response="${response}"`;
    if (d.qop) h += `, qop=${d.qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (d.opaque) h += `, opaque="${d.opaque}"`;
    return h;
  }

  private raw(method: string, uri: string, headers: Record<string, string>, bodyFile?: string, timeoutMs = this.timeoutMs): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const url = new URL(uri, this.conn.base_url);
      const lib = url.protocol === 'https:' ? https : http;
      const auth = this.authHeader(method, url.pathname + url.search);
      const h: Record<string, string> = { ...headers };
      if (auth) h.Authorization = auth;
      const req = lib.request(url, { method, headers: h, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (bodyFile) {
        const s = fs.createReadStream(bodyFile);
        s.on('error', reject);
        s.pipe(req);
      } else req.end();
    });
  }

  async request(method: string, uri: string, headers: Record<string, string> = {}, bodyFile?: string, timeoutMs?: number): Promise<Resp> {
    if (!this.digest) {
      // Fetch a nonce first (cheap GET) so that large uploads need not be sent twice.
      const probe = await this.raw('GET', '/api/v1/info', {}, undefined, timeoutMs);
      this.digest = parseChallenge(probe.headers['www-authenticate'] as string | undefined);
    }
    let r = await this.raw(method, uri, headers, bodyFile, timeoutMs);
    if (r.status === 401) {
      const ch = parseChallenge(r.headers['www-authenticate'] as string | undefined);
      if (ch) {
        this.digest = ch; // stale nonce or first attempt: retry once with a fresh challenge
        r = await this.raw(method, uri, headers, bodyFile, timeoutMs);
      }
    }
    if (r.status === 401) throw new Error('Unauthorized (check PrusaLink username/password)');
    return r;
  }

  private json<T>(r: Resp): T | null {
    if (r.status === 204 || r.body.length === 0) return null;
    return JSON.parse(r.body.toString('utf8')) as T;
  }

  async status(): Promise<PrinterStatus> {
    const r = await this.request('GET', '/api/v1/status');
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    return this.json<PrinterStatus>(r) ?? {};
  }

  async job(): Promise<JobInfo | null> {
    const r = await this.request('GET', '/api/v1/job');
    if (r.status === 204) return null;
    if (r.status !== 200) throw new Error(`job ${r.status}`);
    return this.json<JobInfo>(r);
  }

  private filePath(name: string) {
    return `/api/v1/files/${this.conn.storage}/${encodeURIComponent(name)}`;
  }

  /** Upload a G-code file and optionally start printing right away. Large files can take minutes. */
  async upload(localFile: string, remoteName: string, printAfter: boolean): Promise<void> {
    const size = fs.statSync(localFile).size;
    const r = await this.request('PUT', this.filePath(remoteName), {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'Print-After-Upload': printAfter ? '?1' : '?0',
      Overwrite: '?1',
    }, localFile, 15 * 60 * 1000);
    if (r.status !== 201 && r.status !== 204 && r.status !== 200) {
      throw new Error(`upload failed: HTTP ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
    }
  }

  async startFile(remoteName: string): Promise<void> {
    const r = await this.request('POST', this.filePath(remoteName));
    if (r.status !== 204 && r.status !== 200) throw new Error(`start failed: HTTP ${r.status}`);
  }

  async pause(id: number) { return this.act('PUT', `/api/v1/job/${id}/pause`); }
  async resume(id: number) { return this.act('PUT', `/api/v1/job/${id}/resume`); }
  async stop(id: number) { return this.act('DELETE', `/api/v1/job/${id}`); }

  private async act(method: string, uri: string) {
    const r = await this.request(method, uri);
    if (r.status !== 204 && r.status !== 200) throw new Error(`${method} ${uri} -> HTTP ${r.status}`);
  }
}
