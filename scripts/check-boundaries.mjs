/**
 * Cross-session boundary check.
 *
 * The client half runs in one page that hosts every session's sidebar panel, so
 * "iterate all tabs/webviews and act" is the classic way to leak one session's
 * state into another. This script flags such iterations when the surrounding
 * code shows no session scoping and performs a mutating call nearby.
 *
 * It is deliberately a heuristic: the goal is to make a reviewer look, not to
 * prove correctness. False positives should be silenced by scoping the code.
 *
 * Usage: node scripts/check-boundaries.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
/* An optional path argument makes it easy to test the heuristic itself. */
const clientPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'client.js');
const lines = readFileSync(clientPath, 'utf8').split('\n');

const ITERATIONS = [
  "document.querySelectorAll('webview')",
  'document.querySelectorAll("webview")',
  'browserTabs()',
];
/* Patterns that actually scope an iteration; a bare "session" word (tab.sessionId)
   is not enough, or every action would look scoped. */
const SCOPE_PATTERNS = [
  /ownerSession\(/,
  /visibleSession\(/,
  /callerSession/,
  /\bkeep\b/,
  /tabKeyOf/,
  /describeBrowserTab/,
  /=== session\b/,
  /session\s*===/,
  /!session\b/,
];
const MUTATIONS = ['closeIn(', 'activateTab(', '.loadURL(', 'openTab(', '.remove()', '.click()'];
const READ_ONLY_HINTS = ['out.', 'probe', 'diagnose', 'viewStates', 'viewSessions', 'browserTabs ='];

const findings = [];
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (!ITERATIONS.some((needle) => line.includes(needle))) continue;
  /* Plain list/map reads are fine even without a session filter. */
  if (/browserTabs\(\)\s*\.\s*(length|map|filter|find|some|slice|sort)\b/.test(line)) continue;
  const windowStart = Math.max(0, index - 4);
  const windowEnd = Math.min(lines.length, index + 6);
  const context = lines.slice(windowStart, windowEnd).join('\n');
  if (SCOPE_PATTERNS.some((pattern) => pattern.test(context))) continue;
  if (READ_ONLY_HINTS.some((hint) => context.includes(hint))) continue;
  const mutation = MUTATIONS.find((needle) => context.includes(needle));
  if (!mutation) continue;
  findings.push({ line: index + 1, source: line.trim(), mutation });
}

if (findings.length > 0) {
  console.error('possible cross-session actions without a session scope:');
  for (const finding of findings) {
    console.error('  client.js:' + finding.line + ' (' + finding.mutation + ') ' + finding.source);
  }
  console.error('\nScope the iteration by session (ownerSession / callerSession) or annotate why it is safe.');
  process.exit(1);
}

console.log('client.js cross-session boundary check: OK (' + lines.length + ' lines scanned)');
