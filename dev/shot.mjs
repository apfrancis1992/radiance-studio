/* dev/shot.mjs -- docs/screenshot.png, against dev/mock-upstream.py so it looks like a session
 * rather than an empty form. Pass --no-generate to skip the song and just show the form.
 *
 *   dev/run.sh &   node dev/shot.mjs
 */

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8090/';
const OUT = new URL('../docs/screenshot.png', import.meta.url).pathname;
const OUT_SETTINGS = new URL('../docs/settings.png', import.meta.url).pathname;
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium']
  .filter(p => p && existsSync(p))[0];
const generate = !process.argv.includes('--no-generate');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.click('#example');
if (generate) {
  await page.click('#go');
  await page.waitForSelector('#takes .take', { timeout: 60000 });
}
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: OUT, fullPage: true });

/* The settings panel too: it is where the deploy's defaults can be overruled from the browser. */
await page.click('#settings');
await new Promise(r => setTimeout(r, 300));
await page.screenshot({ path: OUT_SETTINGS });          // the viewport only: the backdrop is the point
await browser.close();
console.log(OUT);
console.log(OUT_SETTINGS);
