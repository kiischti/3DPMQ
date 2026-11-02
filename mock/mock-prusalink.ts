/**
 * A small fake PrusaLink (v1 API, HTTP Digest auth) for development and tests.
 *   npm run mock            -> printers on :8081 and :8082 (user "maker", password "test")
 * It simulates: idle -> upload -> printing (progress) -> finished, plus pause/resume/stop.
 * It is written from the PrusaLink openapi.yaml, so it is only as accurate as that reading.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface Mock { port: number; close(): Promise<void>; state: { state: string; progress: number; file: string; jobId: number; uploads: { name: string; size: number }[] } }

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

export function startMock(port: number, opts: { user?: string; pass?: string; printSeconds?: number } = {}): Promise<Mock> {
  const user = opts.user ?? 'maker', pass = opts.pass ?? 'test', total = opts.printSeconds ?? 6;
  const realm = 'Printer API';
  const nonces = new Set<string>();
  const st = { state: 'IDLE', progress: 0, file: '', jobId: 0, uploads: [] as { name: string; size: number }[] };
  let timer: NodeJS.Timeout | null = null;

  const startPrint = (name: string) => {
    st.jobId++; st.file = name; st.progress = 0; st.state = 'PRINTING';
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (st.state !== 'PRINTING') return;
      st.progress += 100 / (total * 4);
      if (st.progress >= 100) { st.progress = 100; st.state = 'FINISHED'; clearInterval(timer!); }
    }, 250);
  };

  const challenge = (res: http.ServerResponse) => {
    const nonce = crypto.randomBytes(12).toString('hex'); nonces.add(nonce);
    res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth", opaque="op", algorithm=MD5`, 'Content-Length': '0' });
    res.end();
  };
  const authorised = (req: http.IncomingMessage): boolean => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Digest ')) return false;
    const f: Record<string, string> = {};
    for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) f[m[1]] = m[2] ?? m[3];
    if (f.username !== user || !nonces.has(f.nonce)) return false;
    const ha1 = md5(`${user}:${realm}:${pass}`), ha2 = md5(`${req.method}:${f.uri}`);
    return f.response === md5(`${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
  };

  const server = http.createServer((req, res) => {
    if (!authorised(req)) { req.resume(); return challenge(res); }
    const url = new URL(req.url!, 'http://x');
    const json = (code: number, o?: unknown) => { const b = o === undefined ? '' : JSON.stringify(o); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); };
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/v1/info') return json(200, { hostname: 'mock', serial: 'MOCK123', nozzle_diameter: 0.4 });
    if (req.method === 'GET' && p === '/api/v1/status') {
      const active = st.state === 'PRINTING' || st.state === 'PAUSED';
      return json(200, {
        printer: { state: st.state, temp_nozzle: active ? 215 : 24, target_nozzle: active ? 215 : 0, temp_bed: active ? 60 : 23, target_bed: active ? 60 : 0, axis_z: 12.3, flow: 100, speed: 100 },
        ...(active || st.state === 'FINISHED' ? { job: { id: st.jobId, progress: st.progress, time_remaining: Math.round((100 - st.progress) / 100 * total), time_printing: Math.round(st.progress / 100 * total) } } : {}),
      });
    }
    if (req.method === 'GET' && p === '/api/v1/job') {
      if (st.state === 'IDLE') { res.writeHead(204); return void res.end(); }
      return json(200, { id: st.jobId, state: st.state, progress: st.progress, file: { name: st.file, display_name: st.file } });
    }
    const f = /^\/api\/v1\/files\/([^/]+)\/(.+)$/.exec(p);
    if (f && req.method === 'PUT') {
      const name = decodeURIComponent(f[2]); let size = 0;
      if (st.state === 'PRINTING') { req.resume(); return json(409, { message: 'busy' }); }
      req.on('data', (c) => { size += c.length; });
      req.on('end', () => {
        st.uploads.push({ name, size });
        if (req.headers['print-after-upload'] === '?1') startPrint(name);
        json(201);
      });
      return;
    }
    if (f && req.method === 'POST') { if (st.state === 'PRINTING') return json(409); startPrint(decodeURIComponent(f[2])); return json(204); }
    const j = /^\/api\/v1\/job\/(\d+)(?:\/(pause|resume))?$/.exec(p);
    if (j) {
      if (+j[1] !== st.jobId) return json(404);
      if (req.method === 'PUT' && j[2] === 'pause') { st.state = 'PAUSED'; return json(204); }
      if (req.method === 'PUT' && j[2] === 'resume') { st.state = 'PRINTING'; return json(204); }
      if (req.method === 'DELETE') { st.state = 'STOPPED'; return json(204); }
    }
    json(404, { message: 'not found' });
  });

  return new Promise((resolve) => server.listen(port, () => resolve({
    port, state: st,
    close: () => new Promise((r) => { if (timer) clearInterval(timer); server.closeAllConnections(); server.close(() => r()); }),
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secs = parseInt(process.env.PRINT_SECONDS ?? '30', 10);
  await startMock(8081, { printSeconds: secs });
  await startMock(8082, { printSeconds: secs });
  console.log('Mock PrusaLink printers on http://localhost:8081 and :8082  (maker / test)');
}
