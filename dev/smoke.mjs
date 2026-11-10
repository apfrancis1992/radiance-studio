/* dev/smoke.mjs -- drives the page in a real browser against dev/mock-upstream.py, so a change can
 * be checked end to end (form -> proxy -> SSE windows -> wav -> IndexedDB -> reload) without a GPU.
 *
 *   dev/run.sh &                       # the container and the two mock llama-swaps
 *   npm install                        # puppeteer-core, the only dependency, dev-only
 *   node dev/smoke.mjs
 *
 * It looks for Chrome at $CHROME, then the usual Linux paths.
 *
 * The mock refuses a request the way radiance does -- same fields, bounds and messages -- so the
 * part below that talks to the route directly (through the container's proxy, on purpose) is checking
 * the page's requests against what the real model would accept, not against a permissive stand-in.
 */

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8090/';
const OTHER = process.env.OTHER || 'http://127.0.0.1:8124';
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .filter(p => p && existsSync(p))[0];

const checks = [];
const ok = (name, cond, detail = '') => {
  checks.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail && !cond ? ` -- ${detail}` : ''}`);
};

/* Both the container and its upstream have to be answering before a page failure means anything;
 * a slow docker start otherwise reads as a broken page. */
async function ready(url, seconds = 40) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch { /* not yet */ }
    if (Date.now() > until) return false;
    await new Promise(r => setTimeout(r, 400));
  }
}

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
const change = async (sel, v) => {
  await page.$eval(sel, (e, v2) => {
    if (v2 === undefined) e.checked = !e.checked; else e.value = v2;
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
  await new Promise(r => setTimeout(r, 200));
};
const rows = () => page.$$eval('#takes .take', els => els.map(e => ({
  seed: e.querySelector('.t-seed b').textContent,
  title: e.querySelector('.t-title').textContent,
  sub: e.querySelector('.t-sub').textContent,
})));
/* The bodies the page really sent, from the horse's mouth: window.fetch is wrapped and asked to keep
 * them, so a check reads the request rather than a re-derivation of what it thinks was sent. */
const record = () => page.evaluate(() => {
  window.__sent = [];
  const f = window.fetch;
  window.fetch = (u, o) => { if (o && o.body) window.__sent.push(String(o.body)); return f(u, o); };
});
const lastBody = async () => {
  const all = await page.evaluate(() => window.__sent || []);
  try { return JSON.parse(all[all.length - 1] || '{}'); } catch { return {}; }
};
/* Ask the route directly, from the page's own origin, and report what the mock says it was sent. */
const probe = (body, headers = {}) => page.evaluate(async (b, h) => {
  const res = await fetch('v1/audio/speech', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b),
  });
  let echo = {};
  try { echo = JSON.parse(res.headers.get('X-Mock-Request') || '{}'); } catch { /* refused before it got there */ }
  let problem = null;
  if (!res.ok) problem = (await res.json().catch(() => null))?.error?.message || `HTTP ${res.status}`;
  return { status: res.status, echo, problem, seed: res.headers.get('X-Seed') };
}, body, headers);

try {
  if (!await ready(`${BASE.replace(/\/$/, '')}/v1/models`)) {
    ok(`${BASE} and its upstream answered`, false, 'gave up waiting; is dev/run.sh running?');
    throw new Error('nothing to test');
  }
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
  ok('the take says it came as windows', (await text('#nowMeta')).includes('via windows'),
    await text('#nowMeta'));

  /* It survives a reload: IndexedDB, not a variable. */
  await page.reload({ waitUntil: 'networkidle2' });
  list = await rows();
  ok('the take is still there after a reload', list.length === 1, JSON.stringify(list));
  ok('the lyrics survived it too', (await value('#lyrics')).includes('[chorus]'),
    await value('#lyrics'));
  await record();                            // from here on, the requests are kept

  /* The length, the seed, the denoiser and the way back are folded away until asked for. Open them. */
  ok('the transport choice is folded into the advanced panel',
    await page.$eval('#transportWhole', e => !e.closest('details').open));
  await click('.adv summary');
  ok('the advanced panel opens', await page.$eval('.adv', e => e.open));

  /* The whole-file route: no SSE, one wav at the end, and a seed we chose is echoed back. */
  await click('#transportWhole');
  await set('#seed', '1234');
  await click('#go');
  await page.waitForFunction(() => document.querySelectorAll('#takes .take').length > 1, { timeout: 40000 });
  list = await rows();
  ok('a whole-file take appears too', list.length === 2, JSON.stringify(list));
  ok('a seed we gave comes back unchanged', list[0].seed === '1234', list[0].seed);
  ok('the list says how that one arrived', list[0].sub.includes('via one wav'), list[0].sub);
  const wholeBody = await lastBody();
  ok('one wav at the end sends neither stream nor stream_format',
    wholeBody.response_format === 'wav' && !('stream' in wholeBody) && !('stream_format' in wholeBody),
    JSON.stringify(wholeBody));
  ok('and it carries the length, the seed and the denoiser\'s two',
    wholeBody.duration === 30 && wholeBody.seed === 1234
    && wholeBody.num_inference_steps === 30 && wholeBody.guidance_scale === 1.7,
    JSON.stringify(wholeBody));

  /* The third transport: the bytes themselves, with a header that has to be rewritten. */
  await click('#transportAudio');
  await click('#go');
  await page.waitForFunction(() => document.querySelectorAll('#takes .take').length > 2, { timeout: 40000 });
  list = await rows();
  ok('a raw-bytes take appears as well', list.length === 3, JSON.stringify(list.map(r => r.sub)));
  ok('and it says it came as raw bytes', list[0].sub.includes('via raw bytes'), list[0].sub);
  ok('its wav is real too', (await text('#storage')).includes('MB'), await text('#storage'));
  const audioBody = await lastBody();
  ok('raw bytes are asked for with stream_format, not stream',
    audioBody.stream_format === 'audio' && !('stream' in audioBody), JSON.stringify(audioBody));

  /* Asked in frames, the request says `max_new_tokens` and not `duration` -- the route refuses both
   * together, so the form has to choose. */
  await page.$eval('#byFrames', e => { e.checked = true; });
  await set('#durationRange', '30');
  await click('#go');
  await page.waitForFunction(() => document.querySelectorAll('#takes .take').length > 3, { timeout: 40000 });
  const framedBody = await lastBody();
  ok('asking in frames sends max_new_tokens = 25 a second',
    framedBody.max_new_tokens === 750 && !('duration' in framedBody), JSON.stringify(framedBody));
  ok('and the take says so', (await rows())[0].sub.includes('asked in frames'),
    JSON.stringify((await rows())[0].sub));

  /* And the transport the deployment defaults to: events, with raw PCM inside them. */
  await page.$eval('#byFrames', e => { e.checked = false; });
  await click('#transportSse');
  await click('#go');
  await page.waitForFunction(() => document.querySelectorAll('#takes .take').length > 4, { timeout: 40000 });
  const sseBody = await lastBody();
  ok('windows are asked for with stream and pcm',
    sseBody.stream === true && sseBody.response_format === 'pcm' && !('stream_format' in sseBody),
    JSON.stringify(sseBody));

  /* What the route itself says about those fields, asked directly, through the container's proxy. */
  const framed = await probe({
    model: 'minimax-music3', input: '[verse]\ntest', instructions: 'Genre: test.',
    max_new_tokens: 750, response_format: 'wav',
  });
  ok('the route takes max_new_tokens and says which seed it used',
    framed.status === 200 && framed.echo.max_new_tokens === 750 && framed.seed === '4242',
    JSON.stringify(framed));
  const both = await probe({
    model: 'minimax-music3', input: 'test', instructions: 'Genre: test.',
    duration: 30, max_new_tokens: 750,
  });
  ok('length as seconds and frames at once is refused', both.status === 400
    && both.problem.includes('not both'), `${both.status} ${both.problem}`);
  const unknown = await probe({
    model: 'minimax-music3', input: 'test', instructions: 'Genre: test.', lyrics_template: 'auto',
  });
  ok('a field radiance does not have is refused, not ignored', unknown.status === 400
    && unknown.problem.includes('lyrics_template'), `${unknown.status} ${unknown.problem}`);
  const badGuidance = await probe({
    model: 'minimax-music3', input: 'test', instructions: 'Genre: test.', guidance_scale: 0.5,
  });
  ok('guidance below 1 is refused the way the route says', badGuidance.status === 400
    && badGuidance.problem.includes('[1, 30]'), `${badGuidance.status} ${badGuidance.problem}`);
  const sseFmt = await probe({
    model: 'minimax-music3', input: 'test', instructions: 'Genre: test.', stream: true,
    response_format: 'wav',
  });
  ok('asking for events with a wav body is refused', sseFmt.status === 400
    && sseFmt.problem.includes('response_format'), `${sseFmt.status} ${sseFmt.problem}`);

  /* Settings: the panel, the browser remembering, and the reset that forgets. */
  await click('#settings');
  ok('the settings dialog is open', await page.$eval('#settingsDialog', d => d.open));
  const dlg = await page.evaluate(() => {
    const r = document.getElementById('settingsDialog').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left),
             screen: innerWidth };
  });
  ok('the dialog fits across the screen', dlg.left >= 0 && dlg.w <= dlg.screen, JSON.stringify(dlg));
  const deployed = await page.evaluate(() => JSON.parse(localStorage.getItem('radiance-studio.settings') || '{}'));
  ok('nothing is changed yet, so the panel says so',
    Object.keys(deployed).length === 0 && (await text('#sNote')).includes('Nothing changed'),
    await text('#sNote'));
  ok('the deployment listed one other llama-swap as a choice',
    (await page.$$eval('#sUpstream option', els => els.map(e => e.value))).includes(OTHER));
  await set('#sTitle', 'studio on the desk');
  await page.$eval('#sTitle', e => e.dispatchEvent(new Event('change', { bubbles: true })));
  ok('the title follows the setting immediately', (await text('#title')) === 'studio on the desk',
    await text('#title'));
  await set('#sMaxDuration', '120');
  await page.$eval('#sMaxDuration', e => e.dispatchEvent(new Event('change', { bubbles: true })));
  await page.reload({ waitUntil: 'networkidle2' });
  ok('a changed setting survives a reload', (await text('#title')) === 'studio on the desk',
    await text('#title'));
  ok('and the length ceiling came with it',
    (await page.$eval('#durationRange', e => e.max)) === '120',
    await page.$eval('#durationRange', e => e.max));
  ok('the footer admits the browser changed things', (await text('#about')).includes('changed here'),
    await text('#about'));
  await click('#settings');
  await click('#settingsReset');
  await page.evaluate(() => document.getElementById('settingsDialog').close());
  ok('reset puts the deployed values back', (await text('#title')) === 'radiance studio',
    await text('#title'));

  /* Choosing the other llama-swap re-points every call, not just the song request. */
  await click('#settings');
  await change('#sUpstream', OTHER);
  await page.waitForFunction(() => [...document.querySelectorAll('#model option')]
    .some(o => o.value === 'minimax-lab'), { timeout: 15000 });
  ok('the model list now comes from the llama-swap the page chose',
    (await page.$$eval('#model option', els => els.map(e => e.value))).includes('minimax-lab'));
  ok('and the pill reports that one: loaded is its own answer',
    (await text('#statusText')).includes('no model loaded'), await text('#statusText'));
  const routed = await probe({
    model: 'minimax-lab', input: 'test', instructions: 'Genre: test.', response_format: 'wav',
  }, { 'X-Upstream': OTHER });
  ok('a song request with that header reaches that server', routed.status === 200,
    `${routed.status} ${routed.problem}`);
  const refused = await probe({
    model: 'minimax-music3', input: 'test', instructions: 'Genre: test.', response_format: 'wav',
  }, { 'X-Upstream': 'http://127.0.0.1:9999' });
  ok('a target the deployment never listed is not used at all', refused.status === 200
    && refused.echo.model === 'minimax-music3', `${refused.status} ${refused.problem}`);
  await click('#settings');
  await change('#sUpstream', '');
  await page.evaluate(() => document.getElementById('settingsDialog').close());

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

  /* Three widths, and nothing that forces the page sideways: the style grid folds to one column,
   * the settings dialog stays inside the screen, the take rows let their buttons drop below. */
  for (const [w, h] of [[390, 844], [768, 900], [1440, 1000]]) {
    await page.setViewport({ width: w, height: h });
    await new Promise(r => setTimeout(r, 300));
    const wide = await page.evaluate(() => {
      const over = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > document.documentElement.clientWidth + 1) {
          over.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : `.${el.className}`}`);
        }
      }
      return { scrolled: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
               first: over.slice(0, 3) };
    });
    ok(`no horizontal overflow at ${w}px`, !wide.scrolled, JSON.stringify(wide));
  }
  await page.setViewport({ width: 1440, height: 1000 });

  ok('the page threw nothing of its own', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  ok(`the run reached the end (${e.message})`, false);
} finally {
  await browser.close();
}

const failed = checks.filter(c => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed against ${BASE}`);
process.exit(failed.length ? 1 : 0);
