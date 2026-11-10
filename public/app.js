/* app.js -- the page: what you write, the request it turns into, and the takes that came back.
 *
 * One request per song, to llama-swap's /v1/audio/speech with the model named in the body; the
 * container's nginx adds the key and does not buffer, so a streamed song reaches this page as
 * radiance writes it. Everything here is the form, the player, and the history -- see audio.js for
 * the wire format and store.js for where takes live afterwards.
 */

import * as store from './store.js';
import { base64ToBytes, pcmToWav, sseEvents, Graph, WindowPlayer, Meter } from './audio.js';

const el = (id) => document.getElementById(id);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* /config.json is the container's environment, quoted on every field, so nothing here can be
 * broken by a value that is not a number. */
const cfg = await fetch('config.json').then(r => (r.ok ? r.json() : {})).catch(() => ({}));
const CONF = {
  model: cfg.model || '',
  title: cfg.title || 'radiance studio',
  stream: cfg.stream !== 'false',
  maxDuration: clamp(Number(cfg.maxDuration) || 360, 5, 360),
  defaultDuration: 30,
  requestTimeout: Number(cfg.requestTimeout) || 1800,
};
CONF.defaultDuration = clamp(Number(cfg.defaultDuration) || 30, 5, CONF.maxDuration);

/* ─────────────────────────────────────── the widgets ─────────────────────────────────────── */

const ui = {
  model: el('model'), status: el('status'), statusText: el('statusText'), unload: el('unload'),
  form: el('form'), lyrics: el('lyrics'), lyricsCount: el('lyricsCount'), tags: el('tags'),
  genre: el('genre'), bpm: el('bpm'), mood: el('mood'),
  vocals: el('vocals'), instruments: el('instruments'), instructions: el('instructions'),
  rawToggle: el('rawToggle'), instHint: el('instHint'),
  durationRange: el('durationRange'), durationOut: el('durationOut'), noLength: el('noLength'),
  seed: el('seed'), dice: el('dice'), steps: el('steps'), guidance: el('guidance'),
  stream: el('stream'),
  go: el('go'), stop: el('stop'), elapsed: el('elapsed'), statusLine: el('statusLine'),
  error: el('error'), example: el('example'),
  nowTitle: el('nowTitle'), nowMeta: el('nowMeta'), audio: el('audio'), download: el('download'),
  recall: el('recall'), reroll: el('reroll'), viz: el('viz'),
  takes: el('takes'), takesHint: el('takesHint'), clear: el('clear'), storage: el('storage'),
  title: el('title'), about: el('about'),
};

document.title = `${CONF.title} · MiniMax-Music3`;
ui.title.textContent = CONF.title;

const graph = new Graph();
const meter = new meterOrNop();
const state = { db: null, takes: [], busy: false, ctrl: null, started: 0, ticker: 0, current: null, url: '', elementSource: null, draftModel: '' };

function meterOrNop() {
  try { return new Meter(ui.viz, graph); } catch { return { start() {}, stop() {} }; }
}

/* ─────────────────────────────────────── the form ─────────────────────────────────────── */

/* Section tags the model was trained to read, inserted where the caret is. */
const SECTIONS = ['[intro]', '[verse]', '[pre-chorus]', '[chorus]', '[bridge]', '[instrumental]', '[outro]'];
for (const tag of SECTIONS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = tag;
  b.addEventListener('click', () => insertAtCaret(ui.lyrics, `${ui.lyrics.value ? '\n' : ''}${tag}\n`));
  ui.tags.appendChild(b);
}

function insertAtCaret(area, text) {
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? start;
  area.setRangeText(text, start, end, 'end');
  area.focus();
  sync();
}

ui.lyrics.addEventListener('input', sync);
for (const input of [ui.genre, ui.bpm, ui.mood, ui.vocals, ui.instruments]) input.addEventListener('input', sync);

/* The five style fields spell one line, in the shape the model was trained on; "edit as one line"
 * hands that line to you and stops deriving it. */
function compose() {
  const sentence = (s, tail = '.') => `${s.trim().replace(/[.,;]+$/, '')}${tail}`;
  const parts = [];
  if (ui.genre.value.trim()) parts.push(`Genre: ${ui.genre.value.trim()}.`);
  if (ui.bpm.value) parts.push(`BPM: ${clamp(Math.round(Number(ui.bpm.value)), 40, 220)}.`);
  if (ui.mood.value.trim()) parts.push(sentence(ui.mood.value));
  if (ui.vocals.value.trim()) parts.push(`Vocals: ${ui.vocals.value.trim()}.`);
  if (ui.instruments.value.trim()) parts.push(`Instruments: ${ui.instruments.value.trim()}.`);
  return parts.join(' ');
}

function sync() {
  if (!raw()) ui.instructions.value = compose();
  ui.lyricsCount.textContent = `${ui.lyrics.value.length} chars`;
  saveDraft();
}

/* The form is kept in localStorage, because losing a afternoon's lyrics to a reload is the worst
 * thing a page like this can do. The takes are in IndexedDB; this is only what is being typed. */
const DRAFT = 'radiance-studio.draft';
let draftTimer = 0;

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFT, JSON.stringify({
        lyrics: ui.lyrics.value, raw: raw(), instructions: ui.instructions.value,
        genre: ui.genre.value, bpm: ui.bpm.value, mood: ui.mood.value, vocals: ui.vocals.value,
        instruments: ui.instruments.value, duration: ui.durationRange.value,
        noLength: ui.noLength.checked, seed: ui.seed.value, steps: ui.steps.value,
        guidance: ui.guidance.value, stream: ui.stream.checked, model: ui.model.value,
      }));
    } catch { /* private mode, or a full quota: the takes matter more than the draft */ }
  }, 300);
}

function restoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch { return false; }
  if (!d) return false;
  if (d.raw) ui.rawToggle.click();                       // the fields and the textarea swap roles
  for (const [key, node] of Object.entries({
    lyrics: ui.lyrics, instructions: ui.instructions, genre: ui.genre, bpm: ui.bpm, mood: ui.mood,
    vocals: ui.vocals, instruments: ui.instruments, seed: ui.seed, steps: ui.steps,
    guidance: ui.guidance,
  })) if (typeof d[key] === 'string') node.value = d[key];
  if (typeof d.duration === 'string') ui.durationRange.value = d.duration;
  if (typeof d.noLength === 'boolean') ui.noLength.checked = d.noLength;
  if (typeof d.stream === 'boolean') ui.stream.checked = d.stream;
  state.draftModel = d.model || '';
  return true;
}

const raw = () => ui.rawToggle.getAttribute('aria-pressed') === 'true';

ui.rawToggle.addEventListener('click', () => {
  const on = raw();
  ui.rawToggle.setAttribute('aria-pressed', on ? 'false' : 'true');
  ui.rawToggle.textContent = on ? 'edit as one line' : 'back to the fields';
  ui.instructions.readOnly = !on;
  for (const input of [ui.genre, ui.bpm, ui.mood, ui.vocals, ui.instruments]) input.disabled = on;
  ui.instHint.textContent = on
    ? 'Sent as `instructions` exactly as written. The model reads it as plain text: genre, tempo, key, mood, vocals, instruments.'
    : 'Sent as `instructions`. The model reads it as plain text: genre, tempo, key, mood, vocals, instruments.';
  sync();
});

ui.durationRange.max = String(CONF.maxDuration);
ui.durationRange.value = String(CONF.defaultDuration);
function syncDuration() {
  ui.durationOut.textContent = ui.noLength.checked ? 'to the end' : `${ui.durationRange.value} s`;
  ui.durationRange.disabled = ui.noLength.checked;
}
ui.durationRange.addEventListener('input', () => { syncDuration(); saveDraft(); });
ui.noLength.addEventListener('change', () => { syncDuration(); saveDraft(); });
for (const input of [ui.seed, ui.steps, ui.guidance, ui.stream]) input.addEventListener('change', saveDraft);
ui.model.addEventListener('change', saveDraft);

ui.dice.addEventListener('click', () => { ui.seed.value = String(Math.floor(Math.random() * 1e15)); });

const EXAMPLES = [
  {
    lyrics: '[intro]\n[verse]\nMorning light filtering through the pine\nI left the door open behind me\nAnd the road took the shape of a river\n[pre-chorus]\nNothing out here is asking me to be on time\n[chorus]\nSoftly the world begins to breathe\nSoftly the world begins to breathe\n[verse]\nHalf of the trees I do not know their names\nHalf of the songs I know them all\n[chorus]\nSoftly the world begins to breathe\n[outro]',
    genre: 'acoustic pop', bpm: 96, mood: 'warm and intimate', vocals: 'soft female lead',
    instruments: 'nylon guitar, brushed drums, low strings', duration: 60,
  },
  {
    lyrics: '[intro]\n[verse]\nSignal from a dead satellite\nFalls through nine kilometres of rain\nI have been holding this transmission\nSince before you knew my name\n[chorus]\nTransmit, transmit\nI am still transmitting\n[bridge]\nIf anyone is listening\nAnswer in the static, answer in the static\n[outro]',
    genre: 'synthwave', bpm: 118, mood: 'cold, wide, a little hopeful', vocals: 'husky male lead',
    instruments: 'analog synths, gated reverb drums', duration: 90,
  },
];
let exampleAt = 0;
ui.example.addEventListener('click', () => {
  const e = EXAMPLES[exampleAt++ % EXAMPLES.length];
  ui.lyrics.value = e.lyrics;
  ui.genre.value = e.genre; ui.bpm.value = String(e.bpm); ui.mood.value = e.mood;
  ui.vocals.value = e.vocals; ui.instruments.value = e.instruments;
  ui.noLength.checked = false;
  ui.durationRange.value = String(clamp(e.duration, 5, CONF.maxDuration));
  sync(); syncDuration();
});

/* Ctrl/Cmd+Enter from either text box is the keyboard version of the button. */
for (const area of [ui.lyrics, ui.instructions]) {
  area.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); ui.form.requestSubmit(); }
  });
}

/* What the form says, checked the way the route checks it, so a refusal names the field before a
 * card is woken up. The server has the last word either way. */
function readForm() {
  const input = ui.lyrics.value.trim();
  const instructions = ui.instructions.value.trim();
  if (!input) return { error: 'The lyrics are required: the model sings `input`.' };
  if (!instructions) return { error: 'Describe the song: this model needs `instructions`.' };
  const seed = ui.seed.value === '' ? -1 : Math.trunc(Number(ui.seed.value));
  if (!Number.isFinite(seed) || seed < -1) return { error: 'The seed is an integer, or -1 for a fresh one.' };
  const steps = Math.trunc(Number(ui.steps.value) || 30);
  if (steps < 1 || steps > 1000) return { error: '`num_inference_steps` is an integer from 1 to 1000.' };
  const guidance = Number(ui.guidance.value) || 1.7;
  if (guidance < 1 || guidance > 30) return { error: '`guidance_scale` is a number from 1 to 30.' };
  const duration = ui.noLength.checked ? null : Math.round(Number(ui.durationRange.value));
  if (!duration || duration < 1 || duration > CONF.maxDuration) {
    return { error: `The length is ${CONF.maxDuration} seconds at most, or nothing at all.` };
  }
  return {
    body: {
      model: ui.model.value,
      input,
      instructions,
      response_format: ui.stream.checked ? 'pcm' : 'wav',
      ...(ui.stream.checked ? { stream: true } : {}),
      ...(duration ? { duration } : {}),
      ...(seed >= 0 ? { seed } : {}),
      num_inference_steps: steps,
      guidance_scale: guidance,
    },
    params: { duration, seed, steps, guidance, stream: ui.stream.checked },
  };
}

/* ─────────────────────────────────────── llama-swap ─────────────────────────────────────── */

/* The model list, its health line, and what it currently has loaded. All three are llama-swap's
 * own endpoints, which the container proxies beside the OpenAI ones. */
async function refreshModels() {
  try {
    const res = await fetch('v1/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = (await res.json()).data?.map(m => m.id) ?? [];
    const keep = ui.model.value;
    ui.model.replaceChildren(...ids.map(id => {
      const o = document.createElement('option');
      o.value = id; o.textContent = id; o.title = id;
      return o;
    }));
    ui.model.value = keep && ids.includes(keep) ? keep
      : ids.includes(state.draftModel) ? state.draftModel
      : ids.includes(CONF.model) ? CONF.model
      : ids.find(id => /music/i.test(id)) ?? ids[0] ?? '';
    setStatus(ui.model.value ? 'ok' : 'warn',
      ui.model.value ? `${ids.length} models` : 'no models configured');
    return true;
  } catch (e) {
    setStatus('bad', 'llama-swap unreachable');
    return false;
  }
}

async function refreshStatus() {
  if (state.busy) return;                      // a swap in flight answers nothing useful
  try {
    const [health, running] = await Promise.all([fetch('health'), fetch('running').catch(() => null)]);
    if (!health.ok) throw new Error(String(health.status));
    let loaded = [];
    if (running?.ok) {
      const j = await running.json().catch(() => null);
      loaded = (Array.isArray(j) ? j : j?.running ?? j?.models ?? []).map(m => m.id ?? m).filter(Boolean);
    }
    const mine = loaded.includes(ui.model.value);
    setStatus(mine ? 'ok' : 'warn',
      mine ? `${ui.model.value} loaded`
        : loaded.length ? `${loaded[0]} loaded — a song will swap it`
        : 'no model loaded — a song will load one');
  } catch {
    setStatus('bad', 'llama-swap unreachable');
  }
}

function setStatus(kind, text) {
  ui.status.className = `pill ${kind}`;
  ui.statusText.textContent = text;
}

ui.unload.addEventListener('click', async () => {
  ui.unload.disabled = true;
  try {
    const res = await fetch('api/models/unload', { method: 'POST' });
    line(res.ok ? 'Asked llama-swap to unload every model.' : `llama-swap refused: HTTP ${res.status}`);
  } finally {
    ui.unload.disabled = false;
    setTimeout(refreshStatus, 1500);
  }
});

/* ─────────────────────────────────────── making a song ─────────────────────────────────────── */

ui.form.addEventListener('submit', (ev) => { ev.preventDefault(); generate(); });
ui.stop.addEventListener('click', () => state.ctrl?.abort());

async function generate() {
  if (state.busy) return;
  hideError();
  const from = readForm();
  if (from.error) return fail(from.error);
  const { body, params } = from;
  if (!body.model) return fail('No model to name: llama-swap is not answering /v1/models.');

  state.ctrl = new AbortController();
  setBusy(true);
  const startedAt = Date.now();
  line(params.stream
    ? `Asking ${body.model} for a song. The first window comes once it has 200 frames to denoise.`
    : `Asking ${body.model} for a song. Nothing comes back until the whole song is made.`, true);

  let parts = [], rate = 44100, channels = 2, seed = params.seed, seconds = 0, usage = null;
  let player = null, wav = null;
  try {
    const res = await fetch('v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: state.ctrl.signal,
    });
    if (!res.ok) throw await apiError(res);

    /* X-Seed says which seed was used, given or picked; the audio headers say what the PCM is. */
    const declared = Number(res.headers.get('X-Seed'));
    if (Number.isFinite(declared)) seed = declared;
    rate = Number(res.headers.get('X-Audio-Sample-Rate')) || rate;
    channels = Number(res.headers.get('X-Audio-Channels')) || channels;

    const type = res.headers.get('Content-Type') || '';
    if (params.stream && type.includes('event-stream')) {
      if (graph.ensure(rate)) {
        await graph.resume();
        player = new WindowPlayer(graph, rate, channels);
        meter.start();
      } else {
        line('This browser gave no Web Audio, so the song plays once it is finished.', true);
      }
      for await (const ev of sseEvents(res.body, state.ctrl.signal)) {
        if (ev.type === 'speech.audio.delta') {
          const bytes = base64ToBytes(ev.audio);
          rate = ev.sample_rate || rate;
          channels = ev.channels || channels;
          parts.push(bytes);
          seconds += bytes.length / (2 * channels * rate);
          if (player) player.push(bytes);
          line(`Making it: ${seconds.toFixed(1)} s of audio, ${elapsed(startedAt)} in.`);
        } else if (ev.type === 'speech.audio.error') {
          throw new ApiProblem(ev.error?.message || 'the audio generator failed',
            ev.error?.type, '', ev.error?.code);
        } else if (ev.type === 'speech.audio.done') {
          usage = ev.usage ?? null;
        }
      }
      wav = pcmToWav(parts, rate, channels);
    } else {
      /* The whole song in one body: either a wav to keep as it is, or raw PCM to put a header on. */
      const buf = await res.arrayBuffer();
      const isWav = type.includes('wav');
      seconds = (buf.byteLength - (isWav ? 44 : 0)) / (2 * channels * rate);
      wav = isWav
        ? new Blob([buf], { type: 'audio/wav' })
        : pcmToWav([new Uint8Array(buf)], rate, channels);
    }

    if (!wav.size) throw new ApiProblem('the answer carried no audio', '', '', 'empty');

    const take = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      title: titleOf(body.input, body.instructions),
      model: body.model,
      input: body.input,
      instructions: body.instructions,
      params: { duration: params.duration, seed, steps: params.steps, guidance: params.guidance },
      seed, rate, channels, seconds,
      frames: usage?.output_tokens ?? null,
      bytes: wav.size,
      starred: false,
      blob: wav,
    };
    await saveTake(take);
    show(take, { autoplay: !params.stream });
    const made = `Made in ${elapsed(startedAt)}${params.stream ? ' (streamed)' : ''}`;
    line(`${seconds.toFixed(1)} s of ${body.model}, seed ${seed}. ${made}, ${(wav.size / 1e6).toFixed(1)} MB.`);
    if (player) await player.drain();
    meter.stop();
  } catch (e) {
    player?.stop();
    meter.stop();
    if (e.name === 'AbortError') line('Stopped.');
    else if (e instanceof ApiProblem) showError(e);
    else {
      showError(new ApiProblem(
        `${e.message}. The page waits ${CONF.requestTimeout}s for a byte; a cold model load, a `
        + 'stopped container or a browser that gave up first all look like this.'));
      console.error(e);
    }
  } finally {
    player?.stop();
    state.ctrl = null;
    setBusy(false);
    refreshStatus();
  }
}

/* A refusal from the form itself, in the same box the server's refusals use. */
function fail(message) {
  showError(new ApiProblem(message));
  line('');
}

/* The answer's error envelope, from either the route's own refusal or whatever the proxy put in
 * its place. */
async function apiError(res) {
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* an nginx error page, or Go's plain text */ }
  const e = j?.error ?? j;
  if (!e?.message) return new ApiProblem(`HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`, '', '', String(res.status));
  return new ApiProblem(e.message, e.type, e.param, e.code, e.supported);
}

class ApiProblem extends Error {
  constructor(message, type = '', param = '', code = '', supported = null) {
    super(message);
    this.name = 'ApiProblem';
    this.type = type; this.param = param; this.code = code; this.supported = supported;
  }
}

function titleOf(lyrics, instructions) {
  const first = lyrics.split('\n').map(s => s.trim()).find(s => s && !s.startsWith('['));
  if (first) return first.length > 64 ? `${first.slice(0, 63)}…` : first;
  return instructions.split('.')[0].slice(0, 64) || 'Untitled';
}

/* ─────────────────────────────────────── the takes ─────────────────────────────────────── */

async function loadStore() {
  try {
    state.db = await store.open();
    state.takes = await store.takes(state.db);
    render();
  } catch (e) {
    ui.storage.textContent = 'no local storage';
    console.error(e);
  }
}

async function saveTake(take) {
  if (!state.db) return;
  await store.put(state.db, take);
  await store.evict(state.db);
  state.takes = await store.takes(state.db);
  render();
}

function render() {
  ui.takes.replaceChildren(...state.takes.map(takeRow));
  ui.takesHint.hidden = state.takes.length > 0;
  const bytes = state.takes.reduce((n, t) => n + (t.bytes || 0), 0);
  ui.storage.textContent = `${state.takes.length} takes · ${fmtBytes(bytes)}`;
}

function takeRow(take) {
  const li = document.createElement('li');
  li.className = `take${state.current?.id === take.id ? ' playing' : ''}`;
  /* Everything but play needs the database; a browser with IndexedDB turned off still gets the
   * song it made in this page, it just cannot keep it. */
  const kept = () => {
    if (!state.db) line('This browser will not keep takes, so there is nothing to change.');
    return !!state.db;
  };

  const seed = document.createElement('div');
  seed.className = 't-seed';
  seed.innerHTML = 'seed<b></b>';
  seed.querySelector('b').textContent = String(take.seed ?? '—');
  seed.title = 'The seed the server answered with; the same words, length and seed give the same song again.';

  const main = document.createElement('div');
  main.className = 't-main';
  const title = document.createElement('div');
  title.className = 't-title';
  title.textContent = take.title;
  const sub = document.createElement('div');
  sub.className = 't-sub';
  sub.textContent = `${new Date(take.ts).toLocaleString()} · ${take.seconds?.toFixed(0) ?? '?'} s · ${take.model}`
    + `${take.params?.duration ? ` · ${take.params.duration} s asked` : ' · length to the end'}`;
  title.title = take.instructions;
  main.append(title, sub);

  const btns = document.createElement('div');
  btns.className = 't-btns';
  btns.append(
    icon('▶', 'Play', () => show(take, { autoplay: true })),
    icon('♥', 'Keep it (never evicted)', async () => {
      if (!kept()) return;
      take.starred = !take.starred;
      await store.put(state.db, take);
      state.takes = await store.takes(state.db);
      render();
    }, take.starred ? 'on' : ''),
    icon('↺', 'Load into the form', () => recall(take)),
    icon('⟳', 'Same words, new seed', async () => {
      recall(take);
      ui.seed.value = String(Math.floor(Math.random() * 1e15));
      generate();
    }),
    icon('↓', 'Download the wav', () => download(take)),
    icon('✕', 'Delete', async () => {
      if (!kept()) return;
      await store.remove(state.db, take.id);
      if (state.current?.id === take.id) stopNow();
      state.takes = await store.takes(state.db);
      render();
    }),
  );
  li.append(seed, main, btns);
  return li;
}

function icon(text, title, onclick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = text; b.title = title; b.className = cls;
  b.addEventListener('click', onclick);
  return b;
}

function recall(take) {
  ui.lyrics.value = take.input;
  ui.instructions.value = take.instructions;
  ui.model.value = take.model;
  ui.seed.value = String(take.seed ?? -1);
  ui.steps.value = String(take.params?.steps ?? 30);
  ui.guidance.value = String(take.params?.guidance ?? 1.7);
  ui.noLength.checked = !take.params?.duration;
  if (take.params?.duration) ui.durationRange.value = String(clamp(take.params.duration, 5, CONF.maxDuration));
  sync(); syncDuration();
  ui.lyrics.focus();
}

/* Put a take in the player. `autoplay` is why the streaming path passes false: its last window is
 * still playing out of the AudioContext, and taking up the speakers twice is worse than a beat. */
function show(take, { autoplay = true } = {}) {
  state.current = take;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(take.blob);
  ui.audio.src = state.url;
  ui.nowTitle.textContent = take.title;
  ui.nowMeta.textContent = `${take.seconds.toFixed(1)} s · ${take.rate} Hz · ${take.channels === 2 ? 'stereo' : 'mono'}`
    + ` · ${fmtBytes(take.bytes)} · seed ${take.seed ?? '—'} · ${take.model}`;
  ui.download.href = state.url;
  ui.download.download = `${slug(take.title)}-${take.seed ?? 'noseed'}.wav`;
  ui.download.hidden = false;
  ui.recall.hidden = false;
  ui.reroll.hidden = false;
  if (autoplay) playCurrent();
  render();
}

async function playCurrent() {
  routeElementThroughGraph();
  try { await ui.audio.play(); } catch { /* the browser wants a click first */ }
  meter.start();
}

/* A blob URL is same-origin, so the <audio> element can be put through the same analyser the
 * streaming windows use, and one canvas covers both. */
function routeElementThroughGraph() {
  if (state.elementSource || !graph.ensure(Number(state.current?.rate) || 44100)) return;
  state.elementSource = graph.ctx.createMediaElementSource(ui.audio);
  state.elementSource.connect(graph.input);
  ui.audio.addEventListener('play', () => graph.resume());
  ui.audio.addEventListener('pause', () => meter.stop());
  ui.audio.addEventListener('ended', () => meter.stop());
}

function download(take) {
  const url = URL.createObjectURL(take.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(take.title)}-${take.seed ?? 'noseed'}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function stopNow() {
  ui.audio.pause();
  ui.audio.removeAttribute('src');
  ui.audio.load();
  state.current = null;
  ui.nowTitle.textContent = 'Nothing yet';
  ui.nowMeta.textContent = 'Write lyrics, describe the song, and make one.';
  ui.download.hidden = ui.recall.hidden = ui.reroll.hidden = true;
  meter.stop();
}

ui.recall.addEventListener('click', () => state.current && recall(state.current));
ui.reroll.addEventListener('click', () => {
  if (!state.current) return;
  recall(state.current);
  ui.seed.value = String(Math.floor(Math.random() * 1e15));
  generate();
});
ui.clear.addEventListener('click', async () => {
  if (!state.db || !state.takes.length || !confirm('Delete every take this browser saved?')) return;
  await store.wipe(state.db);
  stopNow();
  state.takes = [];
  render();
});
ui.audio.addEventListener('pause', () => meter.stop());
ui.audio.addEventListener('ended', () => meter.stop());

/* ─────────────────────────────────────── the small stuff ─────────────────────────────────────── */

function setBusy(busy) {
  state.busy = busy;
  ui.go.disabled = busy;
  ui.stop.hidden = !busy;
  ui.unload.disabled = busy;
  clearInterval(state.ticker);
  if (busy) {
    state.started = Date.now();
    state.ticker = setInterval(() => { ui.elapsed.textContent = elapsed(state.started); }, 500);
  } else {
    ui.elapsed.textContent = '';
  }
}

function line(text, busy = false) {
  ui.statusLine.textContent = text;
  ui.statusLine.classList.toggle('busy', busy);
}

function showError(problem) {
  const bits = [];
  if (problem.param) bits.push(`field <code>${esc(problem.param)}</code>`);
  if (problem.code) bits.push(`code <code>${esc(problem.code)}</code>`);
  if (problem.type) bits.push(esc(problem.type));
  if (problem.supported?.length) bits.push(`supported: ${problem.supported.map(esc).join(', ')}`);
  ui.error.innerHTML = `<b>The server refused it${bits.length ? ` — ${bits.join(' · ')}` : ''}</b>${esc(problem.message)}`;
  ui.error.hidden = false;
}

function hideError() { ui.error.hidden = true; ui.error.innerHTML = ''; }

function elapsed(ms) { return secs(Date.now() - ms); }
function secs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (s) => (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'song').slice(0, 48);

/* ─────────────────────────────────────── start ─────────────────────────────────────── */

ui.stream.checked = CONF.stream;
restoreDraft();          // what was being typed, if anything
sync();
syncDuration();
loadStore();
ui.about.textContent = `waits ${CONF.requestTimeout}s · up to ${CONF.maxDuration}s a song`;
await refreshModels();
refreshStatus();
setInterval(refreshStatus, 20000);
setInterval(() => { if (!state.busy && !ui.model.value) refreshModels(); }, 60000);
