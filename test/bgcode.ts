/**
 * Cross-checks the .bgcode reader against Prusa's own encoder (libbgcode, `bgcode` command line tool).
 *   BGCODE_BIN=/path/to/bgcode npx tsx test/bgcode.ts [input.gcode]
 * For every combination of metadata compression, G-code compression, G-code encoding and checksum the file is
 * encoded by Prusa's tool and decoded by src/bgcode.ts; the decoded commands must equal the original ones.
 * Without BGCODE_BIN only the committed fixtures in test/fixtures are checked (npm test does that too).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeBgcodeText, heatshrinkDecode, meatpackDecode } from '../src/bgcode.js';
import { parseMeta, scanAscii, scanFile } from '../src/gcode.js';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

/** Commands only: strip comments, spaces and blank lines, so encoder re-formatting does not matter. */
const commands = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/;.*/, '').replace(/\s+/g, '').toUpperCase()).filter(Boolean);

async function check(label: string, bgcodeFile: string, originalGcode: string) {
  let decoded = '';
  try { decoded = decodeBgcodeText(bgcodeFile); } catch (e: any) { ok(false, `${label}: decode failed: ${e.message}`); return; }
  const want = commands(fs.readFileSync(originalGcode, 'latin1')), got = commands(decoded);
  // the file's trailing statistics and config comments are not G-code, but "M862.3 P ..." etc. must survive
  const same = want.length === got.length && want.every((l, i) => l === got[i]);
  if (!same) {
    const i = want.findIndex((l, k) => l !== got[k]);
    ok(false, `${label}: commands differ at #${i}: want "${want[i]}" got "${got[i]}" (${want.length} vs ${got.length} lines)`);
    return;
  }
  ok(true, label);
  const sa = await scanAscii(originalGcode), sb = await scanFile(bgcodeFile, 'x.bgcode');
  ok(sb.scanned && sa.maxNozzleTemp === sb.maxNozzleTemp && sa.maxBedTemp === sb.maxBedTemp && sa.filamentChanges === sb.filamentChanges
    && JSON.stringify(sa.flagged) === JSON.stringify(sb.flagged), `${label}: scan result equals the ASCII scan (${sb.maxNozzleTemp}/${sb.maxBedTemp} °C)`);
  const m = parseMeta(bgcodeFile, 'x.bgcode');
  ok(m.printerModel === 'MK4S' && m.filamentTypes[0] === 'PLA' && m.seconds === 4325 && m.grams !== undefined && Math.abs(m.grams - 14.88) < 0.01 && /PrusaSlicer/.test(m.generator),
    `${label}: metadata (model ${m.printerModel}, ${m.filamentTypes}, ${m.seconds}s, ${m.grams}g, ${m.generator})`);
}

// ---- unit checks of the building blocks
{
  // heatshrink: hand-made stream. literal 'A' (1 01000001), backref index 0 count 2 (0 | 00000000000 | 0010) -> "AAA"; window 11, lookahead 4
  const bits = '1' + '01000001' + '0' + '00000000000' + '0010';
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const buf = Buffer.from(padded.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  ok(heatshrinkDecode(buf, 11, 4, 4).toString() === 'AAAA', 'heatshrink: literal + overlapping back-reference');
  let threw = false; try { heatshrinkDecode(buf, 11, 4, 10); } catch { threw = true; }
  ok(threw, 'heatshrink: truncated stream is an error');
  // meatpack: enable packing, then "G1" + "\n" packed, plus a raw escape
  // "G1\n" = [0x1d ('G','1'), 0xcc ('\n' + padding)]; "M0\n" = [0x0f (escape + '0'), 'M', 0xcc]
  const mp = meatpackDecode(Buffer.from([0xff, 0xff, 251, 0x1d, 0xcc, 0x0f, 0x4d, 0xcc]));
  ok(mp.toString() === 'G1\nM0\n', `meatpack: packed pair, padding and escaped character (${JSON.stringify(mp.toString())})`);
}

// ---- fixtures (always) and fresh encoder output (when the tool is available)
const fixtures = path.resolve('test/fixtures');
const bin = process.env.BGCODE_BIN;
const input = process.argv[2] ?? path.join(fixtures, 'sample.gcode');

if (fs.existsSync(fixtures)) {
  for (const f of fs.readdirSync(fixtures).filter((n) => /^sample-.*\.bgcode$/.test(n) && n !== 'sample-hot.bgcode').sort()) {
    await check(`fixture ${f}`, path.join(fixtures, f), path.join(fixtures, 'sample.gcode'));
  }
  // same file with "M104 S300" at the end: the temperature check must see inside the compressed blocks
  const hot = await scanFile(path.join(fixtures, 'sample-hot.bgcode'), 'x.bgcode');
  ok(hot.scanned && hot.maxNozzleTemp === 300, `fixture sample-hot.bgcode: nozzle temperature found inside compressed G-code (${hot.maxNozzleTemp} °C)`);
  // corruption must be detected by the checksum, and truncation must not crash or pass
  const good = fs.readFileSync(path.join(fixtures, 'sample-slicer-style.bgcode'));
  const tmp = path.join(os.tmpdir(), `bgcode-bad-${process.pid}.bgcode`);
  const flipped = Buffer.from(good); flipped[Math.floor(good.length * 0.6)] ^= 0x55;
  fs.writeFileSync(tmp, flipped);
  await scanFile(tmp, 'x.bgcode').then(() => ok(false, 'corrupted file was accepted'), (e) => ok(/Checksum mismatch/.test(e.message), `corrupted block rejected (${e.message})`));
  fs.writeFileSync(tmp, good.subarray(0, good.length - 1000));
  await scanFile(tmp, 'x.bgcode').then(() => ok(false, 'truncated file was accepted'), (e) => ok(true, `truncated file rejected (${e.message})`));
  fs.rmSync(tmp, { force: true });
}
if (bin && fs.existsSync(bin) && fs.existsSync(input)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgcode-'));
  let n = 0;
  for (const meta of [0, 1, 2, 3]) for (const gc of [0, 1, 2, 3]) for (const enc of [0, 1, 2]) for (const cs of [0, 1]) {
    const name = `m${meta}-g${gc}-e${enc}-c${cs}`;
    const src = path.join(dir, `${name}.gcode`);
    fs.copyFileSync(input, src);
    execFileSync(bin, [src, `--checksum=${cs}`, `--file_metadata_compression=${meta}`, `--print_metadata_compression=${meta}`,
      `--printer_metadata_compression=${meta}`, `--slicer_metadata_compression=${meta}`, `--gcode_compression=${gc}`, `--gcode_encoding=${enc}`], { stdio: 'ignore' });
    await check(name, path.join(dir, `${name}.bgcode`), input);
    n++;
  }
  console.log(`  ${n} encoder combinations checked against Prusa's libbgcode`);
  fs.rmSync(dir, { recursive: true, force: true });
} else console.log('  (BGCODE_BIN not set: encoder cross-check skipped, fixtures only)');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
