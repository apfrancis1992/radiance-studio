#!/usr/bin/env node
/* dev/check-page.mjs -- the two ways this page breaks silently: a `getElementById` for an id the
 * markup does not have, and an import for something the module does not export. Neither a syntax
 * check nor a browser-less build catches either one. Run it as `node dev/check-page.mjs`.
 */

import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/app.js');
const problems = [];

const EXPORT = /^export\s+(?:async\s+)?function\s*\*?\s*(\w+)|^export\s+class\s+(\w+)|^export\s+const\s+(\w+)/gm;
const exportsOf = (source) =>
  new Set([...source.matchAll(EXPORT)].map(m => m[1] || m[2] || m[3]).filter(Boolean));

const modules = { 'store.js': read('../public/store.js'), 'audio.js': read('../public/audio.js') };

/* Every id the page declares, against every id app.js asks for. */
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const asked = new Set([...app.matchAll(/\bel\('([^']+)'\)/g)].map(m => m[1]));
for (const id of asked) if (!declared.has(id)) problems.push(`app.js asks for #${id}, index.html has no such id`);

/* An id the markup points at itself -- a `<label for>`, a datalist's `list`, an `aria-labelledby`,
 * an in-page link -- is used, just not from JavaScript. */
const wiredUp = (id) => ['for', 'list', 'aria-labelledby'].some(a => html.includes(`${a}="${id}"`))
  || html.includes(`href="#${id}"`);
for (const id of declared) {
  if (!asked.has(id) && !wiredUp(id)) problems.push(`index.html declares #${id} and nothing uses it`);
}

/* `import {a, b} from './x.js'` has to name things x.js exports. */
for (const m of app.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/([\w.]+)'/g)) {
  const source = modules[m[2]];
  if (!source) { problems.push(`app.js imports from ./${m[2]}, which is not there`); continue; }
  const exports = exportsOf(source);
  for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
    if (!exports.has(name)) problems.push(`app.js imports ${name} from ${m[2]}, which does not export it`);
  }
}

/* `store.x` has to be in store.js (`store.js` in the import line is not a call). */
const storeExports = exportsOf(modules['store.js']);
for (const m of app.matchAll(/\bstore\.(\w+)/g)) {
  if (m[1] !== 'js' && !storeExports.has(m[1])) {
    problems.push(`app.js calls store.${m[1]}, which store.js does not export`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`page ok: ${asked.size} ids wired, ${storeExports.size} store exports, no dangling imports`);
