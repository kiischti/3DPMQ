import fs from 'node:fs';
import readline from 'node:readline';
import { bgcodeTextBlocks } from './bgcode.js';

/**
 * Toolpath extraction for the 3D preview. A sliced file contains no model, only the path of the nozzle,
 * so the preview draws the extrusion moves (what will actually be printed), like a slicer's preview does.
 * Handles G0/G1 and G2/G3 arcs, absolute/relative XYZ and E (G90/G91, M82/M83), G92, inches (G20),
 * and the ";TYPE:" feature comments of PrusaSlicer and Cura.
 */
export const MAX_SEGMENTS = 1_500_000;
const MAX_TYPES = 31;

export interface Toolpath {
  count: number;
  segs: Float32Array;      // x1 y1 z1 x2 y2 z2 per segment
  types: Uint8Array;       // index into typeNames
  typeNames: string[];
  layers: number[];        // distinct Z values, ascending
  bbox: { min: [number, number, number]; max: [number, number, number] };
  truncated: boolean;
  truncatedAtZ: number | null;
}

class PathBuilder {
  private cap = 1 << 16;
  private f = new Float32Array(this.cap * 6);
  private t = new Uint8Array(this.cap);
  count = 0;
  full = false;
  typeNames: string[] = [];
  private typeIndex = new Map<string, number>();
  private cur = -1;
  private layers = new Set<number>();
  private min: [number, number, number] = [Infinity, Infinity, Infinity];
  private max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  private x = 0; private y = 0; private z = 0; private e = 0;
  private absXYZ = true; private absE = true; private scale = 1;
  private tail = '';

  private setType(name: string) {
    const key = name.trim().slice(0, 60);
    let i = this.typeIndex.get(key);
    if (i === undefined) {
      if (this.typeNames.length >= MAX_TYPES) { this.cur = this.indexOf('Other'); return; }
      i = this.typeNames.length; this.typeNames.push(key); this.typeIndex.set(key, i);
    }
    this.cur = i;
  }
  private indexOf(name: string) {
    let i = this.typeIndex.get(name);
    if (i === undefined) { i = this.typeNames.length; this.typeNames.push(name); this.typeIndex.set(name, i); }
    return i;
  }

  private push(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) {
    if (this.full) return;
    if (this.count >= MAX_SEGMENTS) { this.full = true; this.stoppedAtZ = z2; return; }
    if (this.count === this.cap) {
      this.cap *= 2;
      const nf = new Float32Array(this.cap * 6); nf.set(this.f); this.f = nf;
      const nt = new Uint8Array(this.cap); nt.set(this.t); this.t = nt;
    }
    const o = this.count * 6;
    this.f[o] = x1; this.f[o + 1] = y1; this.f[o + 2] = z1; this.f[o + 3] = x2; this.f[o + 4] = y2; this.f[o + 5] = z2;
    if (this.cur < 0) this.cur = this.indexOf('(no feature type)');
    this.t[this.count++] = this.cur;
    if (x1 < this.min[0]) this.min[0] = x1; if (x2 < this.min[0]) this.min[0] = x2;
    if (y1 < this.min[1]) this.min[1] = y1; if (y2 < this.min[1]) this.min[1] = y2;
    if (z1 < this.min[2]) this.min[2] = z1; if (z2 < this.min[2]) this.min[2] = z2;
    if (x1 > this.max[0]) this.max[0] = x1; if (x2 > this.max[0]) this.max[0] = x2;
    if (y1 > this.max[1]) this.max[1] = y1; if (y2 > this.max[1]) this.max[1] = y2;
    if (z1 > this.max[2]) this.max[2] = z1; if (z2 > this.max[2]) this.max[2] = z2;
    this.layers.add(Math.round(z2 * 1000) / 1000);
  }
  private stoppedAtZ: number | null = null;

  line(raw: string): void {
    if (this.full) return;
    let code = raw;
    const sc = raw.indexOf(';');
    if (sc >= 0) {
      code = raw.slice(0, sc);
      const m = /^\s*TYPE:\s*(.+?)\s*$/.exec(raw.slice(sc + 1));
      if (m) this.setType(m[1]);
    }
    code = code.trim();
    if (!code) return;
    const m = /^(?:N\d+\s*)?([GgMm])\s*(\d+)/.exec(code);
    if (!m) return;
    const letter = m[1].toUpperCase(), num = parseInt(m[2], 10);
    if (letter === 'M') {
      if (num === 82) this.absE = true; else if (num === 83) this.absE = false;
      return;
    }
    const rest = code.slice(m[0].length);
    switch (num) {
      case 0: case 1: this.move(rest); break;
      case 2: case 3: this.arc(rest, num === 2); break;
      case 20: this.scale = 25.4; break;
      case 21: this.scale = 1; break;
      case 90: this.absXYZ = true; break;
      case 91: this.absXYZ = false; break;
      case 92: this.setPosition(rest); break;
      default: break;
    }
  }

  private words(rest: string): Record<string, number> {
    const w: Record<string, number> = {};
    for (const m of rest.matchAll(/([A-Za-z])\s*(-?\d*\.?\d+)/g)) w[m[1].toUpperCase()] = parseFloat(m[2]);
    return w;
  }

  private setPosition(rest: string) {
    const w = this.words(rest), k = this.scale;
    if ('X' in w) this.x = w.X * k; if ('Y' in w) this.y = w.Y * k; if ('Z' in w) this.z = w.Z * k; if ('E' in w) this.e = w.E * k;
  }

  private move(rest: string) {
    const w = this.words(rest), k = this.scale;
    const nx = 'X' in w ? (this.absXYZ ? w.X * k : this.x + w.X * k) : this.x;
    const ny = 'Y' in w ? (this.absXYZ ? w.Y * k : this.y + w.Y * k) : this.y;
    const nz = 'Z' in w ? (this.absXYZ ? w.Z * k : this.z + w.Z * k) : this.z;
    let de = 0;
    if ('E' in w) { const ev = w.E * k; if (this.absE) { de = ev - this.e; this.e = ev; } else de = ev; }
    const moved = Math.abs(nx - this.x) + Math.abs(ny - this.y) + Math.abs(nz - this.z) > 1e-4;
    if (de > 1e-6 && moved) this.push(this.x, this.y, this.z, nx, ny, nz);
    this.x = nx; this.y = ny; this.z = nz;
  }

  private arc(rest: string, clockwise: boolean) {
    const w = this.words(rest), k = this.scale;
    const nx = 'X' in w ? (this.absXYZ ? w.X * k : this.x + w.X * k) : this.x;
    const ny = 'Y' in w ? (this.absXYZ ? w.Y * k : this.y + w.Y * k) : this.y;
    const nz = 'Z' in w ? (this.absXYZ ? w.Z * k : this.z + w.Z * k) : this.z;
    let de = 0;
    if ('E' in w) { const ev = w.E * k; if (this.absE) { de = ev - this.e; this.e = ev; } else de = ev; }
    const x0 = this.x, y0 = this.y, z0 = this.z;
    const hasCenter = 'I' in w || 'J' in w;
    if (de > 1e-6 && hasCenter) {
      const cx = x0 + (w.I ?? 0) * k, cy = y0 + (w.J ?? 0) * k, r = Math.hypot(x0 - cx, y0 - cy);
      const a0 = Math.atan2(y0 - cy, x0 - cx);
      let a1 = Math.atan2(ny - cy, nx - cx), sweep = a1 - a0;
      const full = Math.abs(nx - x0) < 1e-4 && Math.abs(ny - y0) < 1e-4;
      if (clockwise) { if (sweep >= 0 || full) sweep -= 2 * Math.PI; } else if (sweep <= 0 || full) sweep += 2 * Math.PI;
      const steps = Math.max(2, Math.min(256, Math.ceil(Math.abs(sweep) * Math.max(r, 0.1) / 0.4)));
      let px = x0, py = y0, pz = z0;
      for (let i = 1; i <= steps; i++) {
        const f = i / steps, a = a0 + sweep * f;
        const qx = i === steps ? nx : cx + r * Math.cos(a), qy = i === steps ? ny : cy + r * Math.sin(a), qz = z0 + (nz - z0) * f;
        this.push(px, py, pz, qx, qy, qz); px = qx; py = qy; pz = qz;
      }
    } else if (de > 1e-6) this.push(x0, y0, z0, nx, ny, nz); // radius form (R) is not supported: draw a straight chord
    this.x = nx; this.y = ny; this.z = nz;
  }

  pushText(text: string) {
    const parts = (this.tail + text).split('\n');
    this.tail = parts.pop() ?? '';
    for (const p of parts) { this.line(p); if (this.full) return; }
  }

  finish(): Toolpath {
    if (this.tail) { this.line(this.tail); this.tail = ''; }
    const n = this.count;
    const empty = n === 0;
    return {
      count: n, segs: this.f.slice(0, n * 6), types: this.t.slice(0, n), typeNames: this.typeNames,
      layers: [...this.layers].sort((a, b) => a - b),
      bbox: empty ? { min: [0, 0, 0], max: [0, 0, 0] } : { min: this.min, max: this.max },
      truncated: this.full, truncatedAtZ: this.full ? this.stoppedAtZ : null,
    };
  }
}

export async function buildToolpath(file: string, binary: boolean): Promise<Toolpath> {
  const b = new PathBuilder();
  let n = 0;
  if (binary) {
    for (const text of bgcodeTextBlocks(file)) {
      b.pushText(text);
      if (b.full) break;
      if (++n % 16 === 0) await new Promise((r) => setImmediate(r));
    }
  } else {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'latin1' }), crlfDelay: Infinity });
    for await (const line of rl) { b.line(line); if (b.full) { rl.close(); break; } }
  }
  return b.finish();
}

/** Binary payload for the viewer: u32 header length | JSON header (padded to 4 bytes) | float32 segments | uint8 types. */
export function encodePreview(tp: Toolpath, info: Record<string, unknown>): Buffer {
  const header = {
    version: 1, count: tp.count, bbox: tp.bbox, layers: tp.layers, types: tp.typeNames,
    truncated: tp.truncated, truncatedAtZ: tp.truncatedAtZ, ...info,
  };
  let json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - ((4 + json.length) % 4)) % 4;
  if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const len = Buffer.alloc(4); len.writeUInt32LE(json.length, 0);
  return Buffer.concat([len, json, Buffer.from(tp.segs.buffer, tp.segs.byteOffset, tp.count * 24), Buffer.from(tp.types.buffer, tp.types.byteOffset, tp.count)]);
}
