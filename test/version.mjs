// Release consistency check: the version must be the same in package.json, package-lock.json (two places)
// and the newest numbered entry of CHANGELOG.md. Plain Node, no dependencies. Run by `npm test`.
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const top = /^## \[(\d+\.\d+\.\d+)\]/m.exec(fs.readFileSync('CHANGELOG.md', 'utf8'))?.[1];
const problems = [];
if (lock.version !== pkg.version) problems.push(`package-lock.json "version" is ${lock.version}, package.json says ${pkg.version}`);
if (lock.packages?.['']?.version !== pkg.version) problems.push(`package-lock.json packages[""].version is ${lock.packages?.['']?.version}, package.json says ${pkg.version}`);
if (top !== pkg.version) problems.push(`newest CHANGELOG.md entry is ${top}, package.json says ${pkg.version}`);
if (problems.length) { console.error('Version mismatch:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log(`version ${pkg.version}: package.json, package-lock.json and CHANGELOG.md agree`);
