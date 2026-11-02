/**
 * Reader for Prusa binary G-code (.bgcode), written from the libbgcode specification
 * (doc/specifications.md) and cross-checked against Prusa's own encoder (see test/bgcode.ts).
 *
 *   file header : "GCDE" | version u32 | checksum type u16 (0 none, 1 CRC32)         little endian
 *   block       : type u16 | compression u16 | uncompressed size u32 | [compressed size u32 if compression != 0]
 *                 | parameters (2 bytes; 6 for thumbnails) | data | [CRC32 u32 if checksum type 1]
 *   block types : 0 file metadata, 1 G-code, 2 slicer metadata, 3 printer metadata, 4 print metadata, 5 thumbnail
 *   compression : 0 none, 1 deflate (zlib), 2 heatshrink window 11 / lookahead 4, 3 heatshrink 12 / 4
 *   G-code encoding (block parameter): 0 plain ASCII, 1 MeatPack, 2 MeatPack that keeps comments
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LineScanner, type ScanResult } from './scan.js';

const MAX_BLOCK_BYTES = 64 * 1024 * 1024; // sanity limit for one decoded block (PrusaSlicer writes ~64 KiB blocks)

// ---------------------------------------------------------------- Heatshrink (atomicobject/heatshrink, LZSS)
/** Bit stream is MSB first. Tag bit 1 = literal byte; tag bit 0 = back-reference (index, count). Window starts zero-filled. */
export function heatshrinkDecode(src: Buffer, windowBits: number, lookaheadBits: number, outSize: number): Buffer {
  const out = Buffer.alloc(outSize);
  const totalBits = src.length * 8;
  let bi = 0;
  const bits = (n: number): number => {
    if (bi + n > totalBits) return -1;
    let v = 0;
    for (let i = 0; i < n; i++, bi++) v = (v << 1) | ((src[bi >> 3] >> (7 - (bi & 7))) & 1);
    return v;
  };
  let o = 0;
  while (o < outSize) {
    const tag = bits(1);
    if (tag < 0) break;
    if (tag === 1) {
      const b = bits(8);
      if (b < 0) break;
      out[o++] = b;
    } else {
      const idx = bits(windowBits);
      const cnt = bits(lookaheadBits);
      if (idx < 0 || cnt < 0) break;
      const off = idx + 1, n = cnt + 1;
      for (let k = 0; k < n && o < outSize; k++, o++) out[o] = o - off >= 0 ? out[o - off] : 0;
    }
  }
  if (o !== outSize) throw new Error(`heatshrink data ended early (${o} of ${outSize} bytes)`);
  return out;
}

// ---------------------------------------------------------------- MeatPack (port of libbgcode's MeatPack::unbinarize)
/** Two characters per byte via a 4-bit table; nibble 0xF means "the real character follows as a full byte". */
export function meatpackDecode(src: Buffer): Buffer {
  let packing = false, noSpaces = false, cmdActive = false;
  let cmdCount = 0, fullQueue = 0, charBuf = 0;
  const raw: number[] = [];
  // like Prusa's decoder, collapse consecutive newlines (the encoder pads odd-length lines with one)
  const out = { push(c: number) { if (c === 0x0a && raw.length && raw[raw.length - 1] === 0x0a) return; raw.push(c); } };
  const ch = (n: number): number => {
    if (n <= 9) return 0x30 + n;
    switch (n) {
      case 10: return 0x2e;                    // .
      case 11: return noSpaces ? 0x45 : 0x20;  // E (no-spaces mode) or space
      case 12: return 0x0a;                    // \n
      case 13: return 0x47;                    // G
      case 14: return 0x58;                    // X
      default: return 0;
    }
  };
  const command = (c: number) => {
    if (c === 251) packing = true;
    else if (c === 250) packing = false;
    else if (c === 249) packing = false;       // reset all
    else if (c === 247) noSpaces = true;
    else if (c === 246) noSpaces = false;      // 248 (query) and unknown commands: ignored
  };
  const rx = (c: number) => {
    if (!packing) { out.push(c); return; }
    if (fullQueue > 0) {
      out.push(c);
      if (charBuf > 0) { out.push(charBuf); charBuf = 0; }
      fullQueue--;
      return;
    }
    const firstFull = (c & 0x0f) === 0x0f, secondFull = (c & 0xf0) === 0xf0;
    const a = firstFull ? 0 : ch(c & 0x0f), b = secondFull ? 0 : ch((c >> 4) & 0x0f);
    if (firstFull) {
      fullQueue++;
      if (secondFull) fullQueue++; else charBuf = b;
    } else {
      out.push(a);
      if (a !== 0x0a) { if (secondFull) fullQueue++; else out.push(b); }
    }
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === 0xff) {
      if (cmdCount > 0) { cmdActive = true; cmdCount = 0; } else cmdCount++;
    } else if (cmdActive) {
      command(c); cmdActive = false;
    } else {
      if (cmdCount > 0) { rx(0xff); cmdCount = 0; }
      rx(c);
    }
  }
  return Buffer.from(raw);
}

// ---------------------------------------------------------------- blocks
export interface BgBlock { type: number; compression: number; uncompressed: number; compressed: number; params: Buffer; dataStart: number; end: number }

function readHeader(fd: number, size: number): { checksum: number } {
  if (size < 10) throw new Error('File too short for binary G-code');
  const hdr = Buffer.alloc(10);
  fs.readSync(fd, hdr, 0, 10, 0);
  if (hdr.toString('latin1', 0, 4) !== 'GCDE') throw new Error('Not a binary G-code file (bad magic)');
  const version = hdr.readUInt32LE(4), checksum = hdr.readUInt16LE(8);
  if (version !== 1) throw new Error(`Unsupported binary G-code version ${version}`);
  if (checksum > 1) throw new Error(`Unknown checksum type ${checksum}`);
  return { checksum };
}

function* blocks(fd: number, size: number, checksum: number): Generator<BgBlock> {
  const csSize = checksum === 1 ? 4 : 0;
  let pos = 10;
  while (pos < size) {
    if (pos + 8 > size) throw new Error('Truncated block header');
    const bh = Buffer.alloc(12);
    fs.readSync(fd, bh, 0, Math.min(12, size - pos), pos);
    const type = bh.readUInt16LE(0), compression = bh.readUInt16LE(2), uncompressed = bh.readUInt32LE(4);
    if (type > 5) throw new Error(`Unknown block type ${type}`);
    if (compression > 3) throw new Error(`Unknown compression ${compression}`);
    const hsize = compression === 0 ? 8 : 12;
    const compressed = compression === 0 ? uncompressed : bh.readUInt32LE(8);
    const psize = type === 5 ? 6 : 2;
    const dataStart = pos + hsize + psize;
    const end = dataStart + compressed + csSize;
    if (end > size) throw new Error('Truncated block');
    if (uncompressed > MAX_BLOCK_BYTES || compressed > MAX_BLOCK_BYTES) throw new Error('Block too large');
    const params = Buffer.alloc(psize);
    fs.readSync(fd, params, 0, psize, pos + hsize);
    yield { type, compression, uncompressed, compressed, params, dataStart, end };
    pos = end;
  }
}

function blockData(fd: number, b: BgBlock, checksum: number): Buffer {
  const raw = Buffer.alloc(b.compressed);
  if (b.compressed) fs.readSync(fd, raw, 0, b.compressed, b.dataStart);
  if (checksum === 1) {
    // CRC32 covers block header, parameters and the (still compressed) data
    const hsize = b.compression === 0 ? 8 : 12;
    const head = Buffer.alloc(hsize + b.params.length);
    fs.readSync(fd, head, 0, hsize, b.dataStart - b.params.length - hsize);
    b.params.copy(head, hsize);
    const stored = Buffer.alloc(4);
    fs.readSync(fd, stored, 0, 4, b.dataStart + b.compressed);
    const crc = zlib.crc32(Buffer.concat([head, raw]));
    if (crc !== stored.readUInt32LE(0)) throw new Error('Checksum mismatch (file is corrupt)');
  }
  switch (b.compression) {
    case 0: return raw;
    case 1: return zlib.inflateSync(raw, { maxOutputLength: Math.max(b.uncompressed, 1) });
    case 2: return heatshrinkDecode(raw, 11, 4, b.uncompressed);
    default: return heatshrinkDecode(raw, 12, 4, b.uncompressed);
  }
}

/** All key=value pairs of the metadata blocks, first occurrence wins; plus the producer string. */
export function readBgcodeMetadata(file: string): { kv: Record<string, string>; generator: string } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const { checksum } = readHeader(fd, size);
    const kv: Record<string, string> = {};
    let generator = '';
    for (const b of blocks(fd, size, checksum)) {
      if (b.type === 1) break; // first G-code block: all metadata is behind us
      if (b.type === 5) continue;
      const data = blockData(fd, b, checksum);
      for (const line of data.toString('utf8').split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (!(k in kv)) kv[k] = v;
        if (k.toLowerCase() === 'producer' && !generator) generator = v;
      }
    }
    return { kv, generator };
  } finally { fs.closeSync(fd); }
}

/** Decodes every G-code block and runs the same line checks as for plain G-code. */
export async function scanBgcode(file: string): Promise<ScanResult> {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const { checksum } = readHeader(fd, size);
    const sc = new LineScanner();
    let n = 0;
    for (const b of blocks(fd, size, checksum)) {
      if (b.type !== 1) continue;
      let data = blockData(fd, b, checksum);
      const enc = b.params.readUInt16LE(0);
      if (enc === 1 || enc === 2) data = meatpackDecode(data);
      else if (enc !== 0) throw new Error(`Unknown G-code encoding ${enc}`);
      sc.pushText(data.toString('latin1'));
      if (++n % 64 === 0) await new Promise((r) => setImmediate(r)); // keep the server responsive on big files
    }
    if (n === 0) throw new Error('Binary G-code contains no G-code blocks');
    return sc.finish();
  } finally { fs.closeSync(fd); }
}

/** For tests: the decoded G-code text of the whole file. */
export function decodeBgcodeText(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const { checksum } = readHeader(fd, size);
    const parts: string[] = [];
    for (const b of blocks(fd, size, checksum)) {
      if (b.type !== 1) continue;
      let data = blockData(fd, b, checksum);
      const enc = b.params.readUInt16LE(0);
      if (enc === 1 || enc === 2) data = meatpackDecode(data);
      parts.push(data.toString('latin1'));
    }
    return parts.join('');
  } finally { fs.closeSync(fd); }
}
