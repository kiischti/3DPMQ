/** Toolpath extraction for the 3D preview. Run: npx tsx test/preview.ts (also part of npm test) */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildToolpath, encodePreview } from '../src/preview.js';
import { MODEL_SEGMENTS_PER_LAYER, modelGcode } from './make-model.js';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-'));
const write = (name: string, text: string) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };

// ---- geometry of the known model, in all dialects of G-code
for (const [label, opts] of [['relative E', {}], ['absolute E (M82)', { relativeE: false }], ['no spaces (as in binary G-code)', { noSpaces: true }]] as const) {
  const tp = await buildToolpath(write('m.gcode', modelGcode(opts)), false);
  ok(tp.count === 10 * MODEL_SEGMENTS_PER_LAYER, `${label}: ${tp.count} segments, expected ${10 * MODEL_SEGMENTS_PER_LAYER} (retractions and travel moves are not drawn)`);
  ok(near(tp.bbox.min[0], 50) && near(tp.bbox.max[0], 110) && near(tp.bbox.min[1], 50) && near(tp.bbox.max[1], 70) && near(tp.bbox.min[2], 0.2) && near(tp.bbox.max[2], 2.0), `${label}: bounding box ${JSON.stringify(tp.bbox)}`);
  ok(tp.layers.length === 10 && near(tp.layers[0], 0.2, 0.0006) && near(tp.layers[9], 2.0, 0.0006), `${label}: 10 layers`);
  ok(tp.typeNames.join('|') === 'External perimeter|Internal infill|Perimeter', `${label}: feature types ${tp.typeNames.join(', ')}`);
}
// arcs keep their radius: every point of the cylinder is 10 mm from the centre
{
  const tp = await buildToolpath(write('arc.gcode', modelGcode({ layers: 1 })), false);
  let worst = 0;
  for (let i = 0; i < tp.count; i++) if (tp.typeNames[tp.types[i]] === 'Perimeter') worst = Math.max(worst, Math.abs(Math.hypot(tp.segs[i * 6 + 3] - 100, tp.segs[i * 6 + 4] - 60) - 10));
  ok(worst < 0.001, `G2 arc is a true circle (largest radius error ${worst.toFixed(5)} mm)`);
}
// inches (G20)
{
  const tp = await buildToolpath(write('in.gcode', modelGcode({ inches: true, layers: 2 })), false);
  ok(near(tp.bbox.max[0], 110, 0.05) && near(tp.bbox.min[0], 50, 0.05), `G20 inches converted to mm (X ${tp.bbox.min[0].toFixed(2)}..${tp.bbox.max[0].toFixed(2)})`);
}
// edge cases
{
  const empty = await buildToolpath(write('e.gcode', 'G28\nM104 S200\nG1 X10 Y10 F3000\n'), false);
  ok(empty.count === 0 && empty.layers.length === 0, 'file without extrusion gives an empty preview, no crash');
  const junk = await buildToolpath(write('j.gcode', 'hello\n;;;\nG1 Xabc\nG1 X5 Y5 E1\nG1 X6 Y\nM82\n\n'), false);
  ok(junk.count === 1, 'junk lines are ignored');
  const spiral = await buildToolpath(write('s.gcode', 'M83\nG1 X0 Y0 Z0.2\nG1 X10 Y0 Z0.3 E1\nG1 X10 Y10 Z0.4 E1\n'), false);
  ok(spiral.count === 2 && near(spiral.bbox.max[2], 0.4), 'moves that rise while extruding (vase mode) are drawn');
}

// ---- binary G-code gives the same toolpath as plain G-code
{
  const fx = path.resolve('test/fixtures');
  const plain = await buildToolpath(path.join(fx, 'sample.gcode'), false);
  ok(plain.count > 1000, `fixture sample.gcode: ${plain.count} segments`);
  for (const f of ['sample-slicer-style.bgcode', 'sample-deflate.bgcode', 'sample-all-heatshrink12.bgcode', 'sample-heatshrink11-meatpack.bgcode', 'sample-plain-nocrc.bgcode']) {
    const b = await buildToolpath(path.join(fx, f), true);
    const sameBox = [0, 1, 2].every((i) => near(b.bbox.min[i], plain.bbox.min[i], 0.001) && near(b.bbox.max[i], plain.bbox.max[i], 0.001));
    ok(b.count === plain.count && sameBox, `${f}: same ${b.count} segments and bounding box as the plain file`);
  }
  const withComments = await buildToolpath(path.join(fx, 'sample-slicer-style.bgcode'), true);
  ok(withComments.typeNames.includes('Perimeter'), 'binary G-code with comments keeps the feature types');
}

// ---- size limit
{
  const big = await buildToolpath(write('big.gcode', 'M83\n;TYPE:Infill\n' + 'G1 X0 Y0\nG1 X1 Y0 E0.1\nG1 X1 Y1 E0.1\n'.repeat(10)), false);
  ok(big.count === 20 && !big.truncated, 'small file is not truncated');
}

// ---- payload layout read back the way the viewer reads it
{
  const tp = await buildToolpath(write('p.gcode', modelGcode({ layers: 3 })), false);
  const buf = encodePreview(tp, { id: 7, file: 'p.gcode' });
  const hl = buf.readUInt32LE(0), head = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8'));
  ok((4 + hl) % 4 === 0, 'header is padded so the float data is 4-byte aligned');
  ok(head.count === tp.count && head.id === 7 && head.types.length === 3 && head.layers.length === 3, 'header describes the data');
  ok(buf.length === 4 + hl + tp.count * 24 + tp.count, 'payload size = header + 24 bytes per segment + 1 byte per segment');
  const f = new Float32Array(buf.buffer.slice(buf.byteOffset + 4 + hl, buf.byteOffset + 4 + hl + tp.count * 24));
  ok(near(f[0], 50) && near(f[1], 50) && near(f[2], 0.2) && near(f[3], 70), 'first segment decodes to (50,50,0.2) → (70,…)');
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
