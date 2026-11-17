/**
 * Tool-call / driver contract check.
 *
 * The plugin has two drivers behind one `browser` object. Tools call methods on
 * it; a driver that lacks one of those methods fails only when that particular
 * tool is used, which is how `driver: headless` stayed broken for weeks (24 of
 * 39 methods missing, every non-trivial tool threw `TypeError`).
 *
 * This script statically compares the methods the tools call with the methods
 * each driver actually implements, so the gap is visible before release.
 *
 * Usage: node scripts/check-contracts.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const indexSource = readFileSync(path.join(root, 'index.js'), 'utf8');
const hybridSource = readFileSync(path.join(root, 'lib', 'hybrid.js'), 'utf8');
const webviewSource = readFileSync(path.join(root, 'lib', 'webview.js'), 'utf8');
const compatSource = readFileSync(path.join(root, 'lib', 'headless-compat.js'), 'utf8');

/** Every method name the tools invoke on `browser`. */
function toolCalls(source) {
  const names = new Set();
  for (const match of source.matchAll(/browser\.([A-Za-z_$][\w$]*)\s*\(/g)) names.add(match[1]);
  for (const match of source.matchAll(/browser\.([A-Za-z_$][\w$]*)\s*\?\./g)) names.add(match[1]);
  for (const match of source.matchAll(/browser\.([A-Za-z_$][\w$]*)\s*\?\(/g)) names.add(match[1]);
  return names;
}

/** Method names declared in a class block (methods plus getters). */
function classMethods(source, className) {
  const start = source.indexOf('class ' + className + ' {');
  if (start < 0) throw new Error('class ' + className + ' not found');
  let depth = 0;
  let end = start;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const body = source.slice(start, end);
  const names = new Set();
  for (const match of body.matchAll(/^ {2}(?:async )?(?:get )?([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(match[1]);
  for (const match of body.matchAll(/^ {2}(?:get )?([A-Za-z_$][\w$]*)\s*=/gm)) names.add(match[1]);
  return names;
}

/** Methods added to a headless instance by the compatibility layer. */
function compatMethods(source) {
  const names = new Set();
  for (const match of source.matchAll(/instance\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(match[1]);
  for (const match of source.matchAll(/Object\.defineProperty\(instance, '([A-Za-z_$][\w$]*)'/g)) names.add(match[1]);
  return names;
}

const called = toolCalls(indexSource);
const drivers = {
  webview: {
    primary: 'HybridSession',
    methods: new Set([...classMethods(hybridSource, 'HybridSession'), ...classMethods(webviewSource, 'WebviewSession')]),
    runtimeOnly: new Set(),
  },
  headless: {
    primary: 'BrowserSession + headless-compat',
    methods: new Set([...classMethods(indexSource, 'BrowserSession'), ...compatMethods(compatSource)]),
    /* The pooled proxy implements these on the per-session instance handle. */
    runtimeOnly: new Set(['setCallerSession']),
  },
};

let failed = false;
console.log('tools call ' + called.size + ' browser methods: ' + [...called].sort().join(', '));

for (const [name, driver] of Object.entries(drivers)) {
  const missing = [...called]
    .filter((method) => !driver.methods.has(method) && !driver.runtimeOnly.has(method))
    .sort();
  if (missing.length === 0) {
    console.log('\n' + name + ' (' + driver.primary + '): OK, every called method exists');
    continue;
  }
  failed = true;
  console.error('\n' + name + ' (' + driver.primary + '): MISSING ' + missing.length + ' method(s)');
  for (const method of missing) console.error('  - browser.' + method + '()');
}

if (failed) {
  console.error('\nAdd the missing methods (or an explicit unsupported result) before releasing.');
  process.exit(1);
}
console.log('\nAll drivers satisfy the tool contract.');
