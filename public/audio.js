/* audio.js -- the parts of the wire format a browser cannot be handed directly.
 *
 * MiniMax-Music3 answers /v1/audio/speech either as one wav file, which an <audio> element plays
 * on its own, or as Server-Sent Events carrying base64 PCM: `speech.audio.delta` with a window of
 * 16-bit little-endian samples (interleaved, 44.1 kHz stereo), `speech.audio.done` with the usage,
 * `speech.audio.error` with why it stopped. So what is left to do here is:
 *
 *   - read the events out of the byte stream;
 *   - play each window the moment it lands, one after the last, which is the whole point of
 *     streaming: the first window arrives in seconds and the song is finished about as fast as it
 *     plays, so a six minute song costs six minutes of waiting for the last bar, not for the first;
 *   - write the same samples back out as a wav, for the download link and for the take's history.
 */

/** base64 from an event's `audio` field, as bytes. */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Interleaved 16-bit PCM bytes into one Float32Array per channel. */
export function pcmToChannels(bytes, channels) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = 2 * channels;
  const frames = Math.floor(bytes.byteLength / width);
  const out = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      out[c][f] = view.getInt16(f * width + c * 2, true) / 0x8000;
    }
  }
  return out;
}

/** The pieces of PCM a song arrived in, as one wav file that states its own length. */
export function pcmToWav(parts, sampleRate, channels) {
  const bytes = parts.reduce((n, p) => n + p.length, 0);
  const head = new ArrayBuffer(44);
  const v = new DataView(head);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, channels, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true); v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, bytes, true);
  return new Blob([head, ...parts], { type: 'audio/wav' });
}

/** The bytes of an SSE stream, one parsed `data:` object at a time. The events carry no `id:` and
 *  nothing re-reads them, so the event name is read out of the JSON `type` field, which radiance
 *  fills in alongside the `event:` line. */
export async function* sseEvents(body, signal) {
  const reader = body.getReader();
  const decode = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal?.aborted) { await reader.cancel(); return; }
      buffer += decode.decode(value, { stream: true });
      let m;
      while ((m = buffer.match(/\r?\n\r?\n/))) {
        const raw = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const event = parseEvent(raw);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(raw) {
  let data = '';
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;                 // a comment, a keepalive
    if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
  }
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

/** One AudioContext, its analyser, and the single input every sound runs through, so the meter
 *  below the player is the same meter whatever is playing -- a song arriving in windows, or a take
 *  out of the history through the <audio> element. */
export class Graph {
  constructor() {
    this.ctx = null;
    this.input = null;
    this.analyser = null;
    this.failed = false;
  }

  /** @param rate the sample rate of the audio about to arrive */
  ensure(rate) {
    if (this.ctx || this.failed) return this.ctx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      // Asked for at the model's own rate so the windows need no resampling; a browser that
      // refuses the rate gets one at its hardware rate and pcmToChannels' output is resampled.
      try { this.ctx = new Ctx({ sampleRate: rate }); } catch { this.ctx = new Ctx(); }
      this.input = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.72;
      this.input.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch {
      this.failed = true;
      return null;
    }
    return this.ctx;
  }

  resume() { return this.ctx && this.ctx.state !== 'running' ? this.ctx.resume() : Promise.resolve(); }
}

/** Plays the windows of one song as they arrive, each starting exactly where the last ends. */
export class WindowPlayer {
  constructor(graph, sampleRate, channels) {
    this.graph = graph;
    this.rate = sampleRate;
    this.channels = channels;
    this.next = 0;
    this.sources = [];
    this.seconds = 0;
    this.stopped = false;
  }

  /** One `speech.audio.delta` window, as interleaved 16-bit PCM. */
  push(bytes) {
    if (this.stopped || !this.graph.ctx) return;
    const data = pcmToChannels(bytes, this.channels);
    if (!data[0].length) return;
    const ctx = this.graph.ctx;
    const buf = ctx.createBuffer(this.channels, Math.floor(data[0].length * ctx.sampleRate / this.rate), ctx.sampleRate);
    const stretch = ctx.sampleRate / this.rate;
    for (let c = 0; c < this.channels; c++) {
      const src = data[c];
      if (stretch === 1) { buf.copyToChannel(src, c); continue; }
      const out = buf.getChannelData(c);                    // linear, at the boundaries of a window
      for (let i = 0; i < out.length; i++) {
        const p = i / stretch, i0 = Math.floor(p), i1 = Math.min(src.length - 1, i0 + 1);
        out[i] = src[i0] + (src[i1] - src[i0]) * (p - i0);
      }
    }
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.graph.input);
    // A gap means playback ran dry (a window late from a busy GPU); restart just ahead of now
    // rather than trying to paper over it.
    this.next = Math.max(this.next, ctx.currentTime + 0.01);
    node.start(this.next);
    this.next += buf.duration;
    this.sources.push(node);
    this.seconds += bytes.length / (2 * this.channels * this.rate);
  }

  /** True once every window pushed so far has played out. */
  async drain() {
    if (!this.graph.ctx || this.stopped) return;
    const left = this.next - this.graph.ctx.currentTime;
    if (left > 0) await new Promise(r => setTimeout(r, left * 1000));
  }

  stop() {
    this.stopped = true;
    for (const n of this.sources) { try { n.stop(); } catch { /* already finished */ } }
    this.sources = [];
  }
}

/** Drives the meter off the analyser, and stops drawing when nothing is playing. */
export class Meter {
  constructor(canvas, graph) {
    this.canvas = canvas;
    this.graph = graph;
    this.ctx2d = canvas.getContext('2d');
    this.bins = null;
    this.raf = 0;
  }

  start() {
    if (this.raf || !this.graph.analyser) return;
    const bins = this.graph.analyser.frequencyBinCount;
    this.bins = new Uint8Array(bins);
    const draw = () => {
      this.raf = requestAnimationFrame(draw);
      this.graph.analyser.getByteFrequencyData(this.bins);
      this.paint();
    };
    this.raf = requestAnimationFrame(draw);
  }

  stop() {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  paint() {
    const { canvas: c, ctx2d: g, bins } = this;
    const bars = 72, step = Math.floor(bins.length / bars);
    g.clearRect(0, 0, c.width, c.height);
    const w = c.width / bars;
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += bins[i * step + j];
      const v = sum / step / 255;
      const h = Math.max(2, Math.pow(v, 0.85) * c.height);
      g.fillStyle = `rgba(${Math.round(150 + 60 * v)}, ${Math.round(120 + 20 * v)}, 255, ${0.25 + 0.75 * v})`;
      g.fillRect(i * w + 1, (c.height - h) / 2, w - 2, h);
    }
  }
}
