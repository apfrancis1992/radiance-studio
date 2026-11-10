#!/usr/bin/env node
/* dev/check-page.mjs -- the ways this page breaks silently: a `getElementById` for an id the markup
 * does not have, an id in the markup that nothing reaches, and an import or a `mod.thing` for
 * something the module does not export. Neither a syntax check nor a browser-less build catches any
 * of the three, and all three fail at run time in front of a GPU. Run it as `node dev/check-page.mjs`.
 */

import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../public/index.html');
const modules = {
  'store.js': read('../public/store.js'),
  'audio.js': read('../public/audio.js'),
  'settings.js': read('../public/settings.js'),
};
const app = read('../public/app.js');
/* The modules the page's own code can reach: an id only settings.js asks for is still asked for. */
const page = [app, modules['settings.js']].join('\n');
const problems = [];

const EXPORT = /^export\s+(?:async\s+)?function\s*\*?\s*(\w+)|^export\s+class\s+(\w+)|^export\s+const\s+(\w+)/gm;
const exportsOf = (source) =>
  new Set([...source.matchAll(EXPORT)].map(m => m[1] || m[2] || m[3]).filter(Boolean));

/* Every id the page declares, against every id the page's code asks for. */
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const asked = new Set([...page.matchAll(/\bel\('([^']+)'\)/g)].map(m => m[1]));
for (const id of asked) if (!declared.has(id)) problems.push(`the page asks for #${id}, index.html has no such id`);

/* An id the markup points at itself -- a `<label for>`, a datalist's `list`, an `aria-labelledby`,
 * an in-page link -- is used, just not from JavaScript. */
const wiredUp = (id) => ['for', 'list', 'aria-labelledby'].some(a => html.includes(`${a}="${id}"`))
  || html.includes(`href="#${id}"`);
for (const id of declared) {
  if (!asked.has(id) && !wiredUp(id)) problems.push(`index.html declares #${id} and nothing uses it`);
}

/* `import {a, b} from './x.js'` has to name things x.js exports. */
for (const m of page.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/([\w.]+)'/g)) {
  const source = modules[m[2]];
  if (!source) { problems.push(`the page imports from ./${m[2]}, which is not there`); continue; }
  const exports = exportsOf(source);
  for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
    if (!exports.has(name)) problems.push(`the page imports ${name} from ${m[2]}, which does not export it`);
  }
}

/* `store.open()` and `settings.get()` have to be in their modules. The import line itself reads
 * `./store.js`, so the `js` that matches there is not a call and is let through. */
for (const [file, alias] of Object.entries({ 'store.js': 'store', 'settings.js': 'settings' })) {
  const exports = exportsOf(modules[file]);
  for (const m of page.matchAll(new RegExp(`(?<![.\\w])${alias}\\.(\\w+)`, 'g'))) {
    if (m[1] !== 'js' && !exports.has(m[1])) {
      problems.push(`the page calls ${alias}.${m[1]}, which ${file} does not export`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const total = new Set([...Object.values(modules)].flatMap(s => [...exportsOf(s)]));
console.log(`page ok: ${asked.size} ids wired, ${total.size} module exports, no dangling imports`);
