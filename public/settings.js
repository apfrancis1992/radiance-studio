/* settings.js -- what the container was deployed with, and what this browser chose instead.
 *
 * /config.json is the deployment's answer (it is nginx returning the environment it started with),
 * and it is what a browser that has never been here sees. The Settings panel lets a browser disagree
 * and remember it, in localStorage, per browser: the stack's environment stays the default, and a
 * redeploy with a different MODEL or MAX_DURATION becomes the new starting point for a browser that
 * never changed that one.
 *
 * Nothing here is a secret and nothing here reaches the proxy except the model id -- which was always
 * in the request body -- and the `X-Upstream` header, which the container only honours for a url the
 * operator put in UPSTREAM_OPTIONS. So changing these needs a reload of the page, not a rebuild or a
 * redeploy, and it cannot make the container talk to a llama-swap nobody deployed it with.
 */

const KEY = 'radiance-studio.settings';

/* MiniMax-Music3 counts length in frames, 25 a second, and holds 9000 of them: six minutes. The
 * slider's ceiling cannot be raised past that by configuration, only lowered. */
export const MODEL_MAX_SECONDS = 360;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const bool = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : String(v) !== 'false');

/* /config.json, coerced. nginx quotes every field, so a value that is not a number arrives as a
 * string and still has to end up inside the range the model and the page can use. */
export function deployed(cfg) {
  const maxDuration = clamp(Math.round(Number(cfg.maxDuration) || MODEL_MAX_SECONDS), 5, MODEL_MAX_SECONDS);
  const options = Array.isArray(cfg.upstreamOptions)
    ? cfg.upstreamOptions.filter(o => o && typeof o.url === 'string' && /^https?:\/\//.test(o.url))
      .map(o => ({ url: o.url, label: String(o.label || o.url) }))
    : [];
  return {
    model: String(cfg.model || ''),
    title: String(cfg.title || 'radiance studio'),
    stream: bool(cfg.stream, true),
    maxDuration,
    defaultDuration: clamp(Math.round(Number(cfg.defaultDuration) || 30), 5, maxDuration),
    requestTimeout: clamp(Math.round(Number(cfg.requestTimeout) || 1800), 10, 7200),
    upstream: '',                        // '' is the proxy's own UPSTREAM_URL, which it already knows
    upstreamOptions: options,
    upstreamDefault: String(cfg.upstream || ''),
    version: String(cfg.version || ''),
  };
}

/* A change from localStorage, run through the same clamps, so a hand-edited entry cannot ask for a
 * nine-minute song or a zero-second wait. `upstreamOptions`/`version`/`upstreamDefault` describe the
 * deployment and are never stored. */
function clean(over, base) {
  const out = {};
  if (typeof over.model === 'string') out.model = over.model.trim();
  if (typeof over.title === 'string' && over.title.trim()) out.title = over.title.trim().slice(0, 60);
  if (typeof over.stream === 'boolean') out.stream = over.stream;
  if (over.maxDuration !== undefined) {
    out.maxDuration = clamp(Math.round(Number(over.maxDuration) || base.maxDuration), 5, MODEL_MAX_SECONDS);
  }
  if (over.defaultDuration !== undefined) {
    const cap = Math.round(Number(over.maxDuration)) || out.maxDuration || base.maxDuration;
    out.defaultDuration = clamp(Math.round(Number(over.defaultDuration) || base.defaultDuration), 5, cap);
  }
  if (over.requestTimeout !== undefined) {
    out.requestTimeout = clamp(Math.round(Number(over.requestTimeout) || base.requestTimeout), 10, 7200);
  }
  if (typeof over.upstream === 'string') {
    const urls = base.upstreamOptions.map(o => o.url);
    out.upstream = urls.includes(over.upstream) ? over.upstream : '';
  }
  return out;
}

const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
};
const write = (o) => {
  try { localStorage.setItem(KEY, JSON.stringify(o)); return true; } catch { return false; }
};

let base = {}, over = {}, values = {};
const listeners = [];

export function init(cfg) {
  base = deployed(cfg);
  over = clean(read(), base);
  values = { ...base, ...over };
  return values;
}

export function get() { return values; }
export function deployedValues() { return base; }

export function set(patch) {
  over = { ...over, ...clean(patch, base) };
  write(over);
  values = { ...base, ...over };
  listeners.forEach(fn => fn(values));
  return values;
}

export function reset() {
  over = {};
  write(over);
  values = { ...base };
  listeners.forEach(fn => fn(values));
  return values;
}

/* Which settings this browser changed, for the panel to mark -- and for the footer to say so, since
 * "the page says 360 and the stack says 30" is a confusing thing to debug without it. */
export function changedKeys() { return Object.keys(over); }
export function isChanged(key) { return key in over; }
export function onChange(fn) { listeners.push(fn); }
