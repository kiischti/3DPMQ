import fs from 'node:fs';
import readline from 'node:readline';

export interface ScanResult {
  scanned: boolean;                // false only when the G-code could not be decoded
  lines: number;
  maxNozzleTemp: number;
  maxBedTemp: number;
  flagged: Record<string, number>; // command -> count
  filamentChanges: number;         // M600 / M0 / M1 style pauses
}

// Commands that change printer settings / firmware / PID or stop the machine hard.
const FLAG = new Set(['M997', 'M500', 'M501', 'M502', 'M503', 'M301', 'M303', 'M112', 'M999', 'M92', 'M906', 'M913', 'M122', 'M355']);

/** Checks G-code line by line. Used for plain .gcode and for the decoded blocks of .bgcode. */
export class LineScanner {
  readonly res: ScanResult = { scanned: true, lines: 0, maxNozzleTemp: 0, maxBedTemp: 0, flagged: {}, filamentChanges: 0 };

  pushLine(raw: string): void {
    this.res.lines++;
    const semi = raw.indexOf(';');
    const line = (semi >= 0 ? raw.slice(0, semi) : raw).trim().toUpperCase();
    if (!line) return;
    const m = /^(?:N\d+\s*)?([GM]\d+(?:\.\d+)?)/.exec(line);
    if (!m) return;
    const cmd = m[1];
    if (cmd === 'M104' || cmd === 'M109') {
      const s = /\bS(-?[\d.]+)/.exec(line);
      if (s) this.res.maxNozzleTemp = Math.max(this.res.maxNozzleTemp, parseFloat(s[1]));
    } else if (cmd === 'M140' || cmd === 'M190') {
      const s = /\bS(-?[\d.]+)/.exec(line);
      if (s) this.res.maxBedTemp = Math.max(this.res.maxBedTemp, parseFloat(s[1]));
    } else if (cmd === 'M600' || cmd === 'M0' || cmd === 'M1' || cmd === 'M601') {
      this.res.filamentChanges++;
    } else if (FLAG.has(cmd)) {
      this.res.flagged[cmd] = (this.res.flagged[cmd] ?? 0) + 1;
    }
  }

  /** Feed decoded text that may end in the middle of a line; the tail is kept for the next call. */
  private tail = '';
  pushText(text: string): void {
    const parts = (this.tail + text).split('\n');
    this.tail = parts.pop() ?? '';
    for (const p of parts) this.pushLine(p);
  }
  finish(): ScanResult {
    if (this.tail) { this.pushLine(this.tail); this.tail = ''; }
    return this.res;
  }
}

export async function scanAscii(file: string): Promise<ScanResult> {
  const sc = new LineScanner();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const raw of rl) sc.pushLine(raw);
  return sc.finish();
}
