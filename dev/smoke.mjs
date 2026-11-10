/* dev/smoke.mjs -- drives the page in a real browser against dev/mock-upstream.py, so a change can
 * be checked end to end (form -> proxy -> SSE windows -> wav -> IndexedDB -> reload) without a GPU.
 *
 *   dev/run.sh &                       # the container and the mock
 *   npm install                        # puppeteer-core, the only dependency, dev-only
 *   node dev/smoke.mjs
 *
 * It looks for Chrome at $CHROME, then the usual Linux paths.
 */

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8090/';
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .filter(p => p && existsSync(p))[0];

const checks = [];
const ok = (name, cond, detail = '') => {
  checks.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail && !cond ? ` -- ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--mute-audio'],
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
// A resource that 404s is logged by the browser itself; the error-path test below provokes one
// on purpose, so only the page's own failures are worth failing on.
page.on('console', m => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) consoleErrors.push(m.text());
});

const text = (sel) => page.$eval(sel, e => e.textContent.trim()).catch(() => '');
const value = (sel) => page.$eval(sel, e => e.value);
const visible = (sel) => page.$eval(sel, e => !e.hidden && getComputedStyle(e).display !== 'none').catch(() => false);
const click = async (sel) => { await page.click(sel); await new Promise(r => setTimeout(r, 120)); };
const set = async (sel, v) => page.$eval(sel, (e, v2) => {
  const proto = e.tagName === 'INPUT' && e.type === 'range' ? HTMLInputElement.prototype : null;
  if (proto) Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v2); else e.value = v2;
  e.dispatchEvent(new Event('input', { bubbles: true }));
}, v);
const rows = () => page.$$eval('#takes .take', els => els.map(e => ({
  seed: e.querySelector('.t-seed b').textContent,
  title: e.querySelector('.t-title').textContent,
})));

try {
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 15000 });

  /* The model list came through the proxy from llama-swap, and the music one was picked. */
  const models = await page.$$eval('#model option', els => els.map(e => e.value));
  ok('the model list came from /v1/models', models.includes('minimax-music3'), models.join(','));
  ok('the music model is the one selected', (await value('#model')) === 'minimax-music3', await value('#model'));
  ok('llama-swap says the model is loaded', (await text('#statusText')).includes('loaded'), await text('#statusText'));

  /* The example fills the form and the style fields spell one instructions line. */
  await click('#example');
  ok('an example fills the lyrics', (await value('#lyrics')).includes('[chorus]'));
  const inst = await value('#instructions');
  ok('the style fields compose into `instructions`',
    inst.startsWith('Genre: acoustic pop. BPM: 96.') && inst.includes('Vocals: soft female lead.'), inst);

  /* A streamed song: windows arrive over SSE, are played as they land, and are stored as a wav. */
  await set('#durationRange', '30');
  await click('#go');
  await page.waitForFunction(() => document.querySelectorAll('#takes .take').length > 0, { timeout: 40000 });
  let list = await rows();
  ok('a streamed take appears in the list', list.length === 1, JSON.stringify(list));
  ok('the seed the server answered with is the one recorded', list[0].seed === '4242', list[0].seed);
  ok('the player has the song', (await page.$eval('#audio', e => e.src)).startsWith('blob:'));
  ok('the download is offered', (await text('#download')).length > 0 && await visible('#download'));
  ok('the take says what it is', (await text('#nowMeta')).includes('44100 Hz')
    && (await text('#nowMeta')).includes('stereo'), await text('#nowMeta'));
  ok('the wav is real, not a header', (await text('#storage')).includes('MB'), await text('#storage'));

  /* It survives a reload: IndexedDB, not a variable. */
  await page.reload({ waitUntil: 'networkidle2' });
  list = await rows();
  ok('the take is still there after a reload', list.length === 1, JSON.stringify(list));
  ok('the lyrics survived it too', (await value('#lyrics')).includes('[chorus]'),
    await value('#lyrics'));

  /* The whole-file route: no SSE, one wav at the end, and a seed we chose is echoed back. */
  await page.$eval('#stream', e => { e.checked = false; });
  await set('#seed', '1234');
  await click('#go');
  await page.waitForFunction(() => document.querySelectorAll('#takes .take').length > 1, { timeout: 40000 });
  list = await rows();
  ok('a whole-file take appears too', list.length === 2, JSON.stringify(list));
  ok('a seed we gave comes back unchanged', list[0].seed === '1234', list[0].seed);

  /* A refusal from the route names the field, in the page's own words or the server's. */
  await page.select('#model', 'some-chat-model');
  await click('#go');
  await page.waitForFunction(() => !document.getElementById('error').hidden, { timeout: 20000 });
  ok('an error from the model reaches the page',
    (await text('#error')).includes('not found'), await text('#error'));

  /* And a form the model would refuse is caught before anything is sent. */
  await page.select('#model', 'minimax-music3');
  await set('#lyrics', '   ');
  await click('#go');
  ok('empty lyrics are caught before the request', (await text('#error')).includes('lyrics'), await text('#error'));

  ok('the page threw nothing of its own', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  ok(`the run reached the end (${e.message})`, false);
} finally {
  await browser.close();
}

const failed = checks.filter(c => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed against ${BASE}`);
process.exit(failed.length ? 1 : 0);
