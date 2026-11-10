#!/usr/bin/env python3
"""A stand-in for llama-swap holding MiniMax-Music3, so the page can be built and clicked without
a GPU. It answers the four routes the container proxies and writes a real song: a chord that
changes every window, at the model's own rate and channel count, in the same shapes radiance uses.

    dev/mock-upstream.py [--port 8123] [--windows 6] [--delay 1.0] [--seed-out 4242]

--windows x --delay is how a long song is simulated: each window is 8 s of audio and arrives
`delay` seconds after the last, which is the rhythm radiance keeps when it renders a song at about
the speed it plays.
"""

import argparse
import base64
import json
import math
import struct
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RATE, CHANNELS = 44100, 2
WINDOW_FRAMES, LATER_FRAMES, FRAME_RATE = 200, 100, 25   # 8 s first, then 4 s at a time
MODEL = "minimax-music3"


def pcm(seconds, freq):
    """16-bit little-endian interleaved stereo: a detuned triad, fading at the edges."""
    n = int(seconds * RATE)
    out = bytearray(n * 2 * CHANNELS)
    for i in range(n):
        t = i / RATE
        env = min(1.0, t / 0.05, (seconds - t) / 0.2)
        s = (math.sin(2 * math.pi * freq * t) + 0.6 * math.sin(2 * math.pi * freq * 1.5 * t)
             + 0.4 * math.sin(2 * math.pi * freq * 1.005 * t)) * 0.25 * env
        v = int(max(-1, min(1, s)) * 32767)
        for c in range(CHANNELS):                      # a slight stereo tilt
            vv = int(v * (0.9 if c else 1.1))
            struct.pack_into("<h", out, (i * CHANNELS + c) * 2, vv)
    return bytes(out)


def wav(bytes_in):
    head = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(bytes_in), b"WAVE", b"fmt ", 16,
                       1, CHANNELS, RATE, RATE * CHANNELS * 2, CHANNELS * 2, 16, b"data", len(bytes_in))
    return head + bytes_in


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    opts = None

    def log_message(self, fmt, *args):
        print(f"[mock] {self.command} {self.path} -- {fmt % args}", flush=True)

    def _send(self, code, body=b"", ctype="application/json", extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _chunk(self, text):
        """One HTTP/1.1 chunk. BaseHTTPRequestHandler does no framing of its own, and a proxy
        (unlike curl) refuses a body that claims to be chunked and is not."""
        data = text.encode()
        self.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, json.dumps({"status": "ok", "model": MODEL}).encode())
        elif self.path.startswith("/running"):
            self._send(200, json.dumps([{"id": MODEL, "public_id": MODEL}]).encode())
        elif self.path.startswith("/v1/models"):
            data = {"object": "list", "data": [
                {"id": MODEL, "object": "model", "owned_by": "llama-swap"},
                {"id": "some-chat-model", "object": "model", "owned_by": "llama-swap"}]}
            self._send(200, json.dumps(data).encode())
        else:
            self._send(404, json.dumps({"error": {"message": f"no route {self.path}"}}).encode())

    def do_POST(self):
        if self.path.startswith("/api/models/unload"):
            return self._send(200, json.dumps({"status": "unloaded"}).encode())
        if not self.path.startswith("/v1/audio/speech"):
            return self._send(404, json.dumps({"error": {"message": f"no route {self.path}"}}).encode())

        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or b"{}") or b"{}")
        if body.get("model") != MODEL:
            return self._send(404, json.dumps({"error": {
                "message": f"model '{body.get('model')}' not found", "type": "invalid_request_error",
                "param": "model"}}).encode())
        for field in ("input", "instructions"):
            if not str(body.get(field, "")).strip():
                return self._send(400, json.dumps({"error": {
                    "message": f"this model needs {field}, as a non-empty string",
                    "type": "invalid_request_error", "param": field}}).encode())
        duration = body.get("duration") or 30
        seed = body.get("seed", self.opts.seed_out)
        sse = bool(body.get("stream")) or body.get("stream_format") == "sse"
        if sse and body.get("response_format", "pcm") != "pcm":
            return self._send(400, json.dumps({"error": {
                "message": "an event carries raw PCM; set response_format pcm",
                "type": "invalid_request_error", "param": "response_format",
                "supported": ["pcm"]}}).encode())

        windows = max(1, min(self.opts.windows, int(math.ceil(duration * FRAME_RATE / LATER_FRAMES))))
        seconds = (WINDOW_FRAMES + (windows - 1) * LATER_FRAMES) / FRAME_RATE
        headers = [("X-Seed", str(seed)), ("X-Audio-Sample-Rate", str(RATE)), ("X-Audio-Channels", str(CHANNELS))]

        if not sse:
            time.sleep(self.opts.delay)
            audio = b"".join(pcm(seconds / windows, 196 * (1.0 + i * 0.12)) for i in range(windows))
            return self._send(200, wav(audio) if body.get("response_format", "wav") == "wav" else audio,
                              "audio/wav" if body.get("response_format", "wav") == "wav" else "audio/pcm",
                              headers)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        frames = WINDOW_FRAMES
        sent = 0
        try:
            for i in range(windows):
                time.sleep(self.opts.delay)
                chunk = pcm(frames / FRAME_RATE, 196 * (1.0 + i * 0.12))
                sent += len(chunk)
                event = {"type": "speech.audio.delta", "audio": base64.b64encode(chunk).decode(),
                         "response_format": "pcm", "sample_rate": RATE, "channels": CHANNELS}
                self._chunk(f"event: speech.audio.delta\ndata: {json.dumps(event)}\n\n")
                frames = LATER_FRAMES
            frames_out = sent // (2 * CHANNELS)
            done = {"type": "speech.audio.done",
                    "usage": {"input_tokens": 128, "output_tokens": frames_out // FRAME_RATE,
                              "total_tokens": 128 + frames_out // FRAME_RATE}}
            self._chunk(f"event: speech.audio.done\ndata: {json.dumps(done)}\n\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.log_message("the page hung up")
        self.close_connection = True


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--windows", type=int, default=6)
    ap.add_argument("--delay", type=float, default=1.0, help="seconds each window takes to arrive")
    ap.add_argument("--seed-out", type=int, default=4242)
    Handler.opts = ap.parse_args()
    print(f"[mock] llama-swap-ish on http://127.0.0.1:{Handler.opts.port} ({MODEL}, "
          f"{Handler.opts.windows} windows, {Handler.opts.delay}s apart)")
    ThreadingHTTPServer(("127.0.0.1", Handler.opts.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
