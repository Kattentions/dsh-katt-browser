/**
 * Release consistency check.
 *
 * Three hand-maintained numbers must agree for a release to be installable:
 * `package.json` version, the runtime `VERSION` the client reports, and the
 * version listed in the market index. Forgetting one of them ships a plugin
 * that says 0.9.58 but installs as 0.9.57.
 *
 * Usage: node scripts/check-release.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const problems = [];

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (version === '') problems.push('package.json has no version');

const clientPath = path.join(root, 'client.js');
const clientSource = readFileSync(clientPath, 'utf8');
const clientVersion = (clientSource.match(/const VERSION = '([^']+)'/) || [])[1] || '';
if (clientVersion !== version) problems.push('client.js VERSION is ' + (clientVersion || 'missing') + ', package.json is ' + version);

const indexPath = path.join(root, 'index.json');
const releaseRepo = existsSync(indexPath);
if (!releaseRepo) {
  console.log('source checkout (no index.json): checked package/client versions only');
} else {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const row = (index.plugins || []).find((plugin) => plugin.name === 'dsh-katt-browser');
  const listed = row && row.versions && row.versions.length > 0 ? String(row.versions[0].version || '') : '';
  if (listed !== version) problems.push('index.json lists ' + (listed || 'nothing') + ', package.json is ' + version);
}

if (releaseRepo) {
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'LICENSE', 'scripts/check-contracts.mjs']) {
    if (!existsSync(path.join(root, required))) problems.push('missing required file: ' + required);
  }
}

if (problems.length > 0) {
  console.error('release metadata is inconsistent:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log('release metadata OK: v' + version + ' (package, client and index agree)');
