#!/usr/bin/env python3
"""A stand-in for llama-swap holding MiniMax-Music3, so the page can be built and clicked without a
GPU. It answers the four routes the container proxies and writes a real song: a chord that changes
every window, at the model's own rate and channel count, in the shapes radiance uses -- and it
refuses a bad request the way radiance does.

    dev/mock-upstream.py [--port 8123] [--id minimax-music3] [--windows 6] [--delay 1.0]
                         [--seed-out 4242] [--idle]

--windows x --delay is how a long song is simulated: the first window is 8 s of audio and each one
after is 4 s, arriving `delay` seconds apart, which is the rhythm radiance keeps when it renders a
song at about the speed it plays.

--id names this instance's model, so two mocks on two ports can show a page choosing between two
llama-swaps. --idle answers /running with nothing loaded, which is the other state the pill shows.

The refusals are copied from core/server/audio_gen.cpp and core/server/oai.cpp: the same field names,
the same order, the same wording -- including that a field name comes in front of the reason
(`duration: expected seconds in (0, 360]`) and that a field the model has no use for carries
`code: unsupported_parameter`. A page that only ever pleases this mock has therefore been checked
against what the real route accepts, not against a guess of it. Every accepted request is echoed back
in `X-Mock-Request`, which no real server sends, so dev/smoke.mjs can assert what was actually sent.
"""

import argparse
import base64
import json
import math
import struct
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RATE, CHANNELS = 44100, 2
WINDOW_FRAMES, LATER_FRAMES, FRAME_RATE = 200, 100, 25   # 8 s first, then 4 s at a time
MAX_FRAMES, MAX_STEPS = 9000, 1000                       # six minutes; the denoiser's ceiling
MAX_SECONDS = MAX_FRAMES // FRAME_RATE
KNOWN = (
    "model", "input", "instructions", "voice", "response_format", "speed", "stream",
    "stream_format", "seed", "max_new_tokens", "duration", "num_inference_steps",
    "guidance_scale", "user", "references",
)


class Refused(Exception):
    """A refusal, in the shape `ApiError::dump` writes -- message, type, param, code, and `supported`
    when the field has a set of legal values. radiance puts the field name in front of the reason."""

    def __init__(self, message, param="", code="", supported=None, status=400,
                 etype="invalid_request_error"):
        self.status, self.body = status, {"error": {"message": message, "type": etype,
                                                    "param": param or None, "code": code or None}}
        if supported:
            self.body["error"]["supported"] = supported
        super().__init__(message)


def bad(param, why):
    return Refused(f"{param}: {why}" if param else why, param)


def unsupported(param, why, supported=None):
    return Refused(f"{param}: {why}", param, code="unsupported_parameter", supported=supported)


def check(body, model_id):
    """Every check the route makes, in its order, returning what the song will be: frames, and how
    the bytes are coming back. Raises Refused, or Missing (which is llama-swap's, not radiance's)."""
    if body.get("model") != model_id:                    # llama-swap routes on the name first
        raise Refused(f"model '{body.get('model')}' not found", "model", status=404)
    for field in body:
        if field not in KNOWN:
            raise bad(field, f"'{field}' is not a field of /v1/audio/speech")

    def string(field):
        """radiance's `str`: absent or null is empty, a non-string is a refusal."""
        v = body.get(field)
        if v is None:
            return ""
        if not isinstance(v, str):
            raise bad(field, "expected a string")
        return v

    text = string("input")
    if not text.strip():
        raise bad("input", "the text is required, as a non-empty string")

    stream = body.get("stream")
    if stream is not None and not isinstance(stream, bool):
        raise bad("stream", "expected a boolean")
    sfmt = string("stream_format")
    if sfmt not in ("", "sse", "audio"):
        raise unsupported("stream_format", "a stream is sent as sse or audio", ["sse", "audio"])
    if stream and sfmt == "audio":
        raise bad("stream", "stream sends Server-Sent Events and stream_format audio sends the "
                            "bytes themselves; give one")
    sse, raw = bool(stream) or sfmt == "sse", sfmt == "audio"
    fmt = string("response_format") or ("pcm" if sse else "wav")
    if fmt not in ("wav", "pcm"):
        raise unsupported("response_format", "this server writes wav or pcm", ["wav", "pcm"])
    if sse and fmt != "pcm":
        raise unsupported("response_format", "an event carries raw PCM; set response_format pcm")

    # ---- speech_request, the model's own bound
    inst = string("instructions")
    if not inst.strip():
        raise bad("instructions", "this model needs instructions, as a non-empty string: for a song "
                                  "its genre, mood, vocals and instruments")
    if "speed" in body and body["speed"] is not None:
        if isinstance(body["speed"], bool) or not isinstance(body["speed"], (int, float)) \
                or float(body["speed"]) != 1.0:
            raise unsupported("speed", "this model keeps its own tempo; the instructions set it")

    frames, dur = body.get("max_new_tokens"), body.get("duration")
    if frames is not None and dur is not None:
        raise bad("duration", "give max_new_tokens or duration, not both")
    if frames is not None:
        if isinstance(frames, bool) or not isinstance(frames, int) or not 1 <= frames <= MAX_FRAMES:
            raise bad("max_new_tokens", f"expected an integer in 1..{MAX_FRAMES} (frames, "
                                        f"{FRAME_RATE} a second)")
        length = frames
    elif dur is not None:
        if isinstance(dur, bool) or not isinstance(dur, (int, float)) or not 0 < float(dur) <= MAX_SECONDS:
            raise bad("duration", f"expected seconds in (0, {MAX_SECONDS}]")
        length = max(1, min(MAX_FRAMES, math.ceil(float(dur) * FRAME_RATE)))
    else:
        length = MAX_FRAMES                              # neither: the model's longest

    steps = body.get("num_inference_steps")
    if steps is not None and (isinstance(steps, bool) or not isinstance(steps, int)
                              or not 1 <= steps <= MAX_STEPS):
        raise bad("num_inference_steps", f"expected an integer in 1..{MAX_STEPS}")
    if "guidance_scale" in body and body["guidance_scale"] is not None:
        g = body["guidance_scale"]
        if isinstance(g, bool) or not isinstance(g, (int, float)) or not 1.0 <= float(g) <= 30.0:
            raise bad("guidance_scale", "expected a number in [1, 30]")
    if "seed" in body and body["seed"] is not None:
        if isinstance(body["seed"], bool) or not isinstance(body["seed"], int):
            raise bad("seed", "expected an integer")
    refs = body.get("references")
    if refs is not None:
        if not isinstance(refs, list):
            raise bad("references", 'expected an array of {"audio", "text"}')
        if refs:
            raise unsupported("references", "this model takes no reference audio; its voice is "
                                            "described in the input")
    return {"frames": length, "sse": sse, "raw": raw, "fmt": fmt}


def chosen_seed(body, fallback):
    """radiance: `-1`, null or no seed at all picks one -- 53 bits, so JavaScript reads it exactly --
    and every other integer, zero included, is honoured as given. The mock's "picked" one is fixed so
    a test can assert on it."""
    seed = body.get("seed")
    return fallback if seed is None or seed == -1 else seed


def pcm(seconds, freq):
    """16-bit little-endian interleaved stereo: a detuned triad, faded at both edges."""
    n = int(seconds * RATE)
    out = bytearray(n * 2 * CHANNELS)
    for i in range(n):
        t = i / RATE
        env = min(1.0, t / 0.05, (seconds - t) / 0.2)
        s = (math.sin(2 * math.pi * freq * t) + 0.6 * math.sin(2 * math.pi * freq * 1.5 * t)
             + 0.4 * math.sin(2 * math.pi * freq * 1.005 * t)) * 0.25 * env
        v = int(max(-1, min(1, s)) * 32767)
        for c in range(CHANNELS):                        # a slight stereo tilt
            struct.pack_into("<h", out, (i * CHANNELS + c) * 2, int(v * (0.9 if c else 1.1)))
    return bytes(out)


def wav(bytes_in, unknown_length=False):
    """A RIFF/WAVE header and the samples. A stream's header states no length -- both size fields at
    their maximum, which is how ffmpeg and libsndfile read one -- because it is written first."""
    size = 0xffffffff if unknown_length else 36 + len(bytes_in)
    data = 0xffffffff if unknown_length else len(bytes_in)
    head = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", size, b"WAVE", b"fmt ", 16,
                       1, CHANNELS, RATE, RATE * CHANNELS * 2, CHANNELS * 2, 16, b"data", data)
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

    def _chunk(self, data):
        """One HTTP/1.1 chunk. BaseHTTPRequestHandler does no framing of its own, and a proxy
        (unlike curl) refuses a body that claims to be chunked and is not."""
        if isinstance(data, str):
            data = data.encode()
        self.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, json.dumps({"status": "ok", "model": self.opts.id}).encode())
        elif self.path.startswith("/running"):
            loaded = [] if self.opts.idle else [{"id": self.opts.id, "public_id": self.opts.id}]
            self._send(200, json.dumps(loaded).encode())
        elif self.path.startswith("/v1/models"):
            data = {"object": "list", "data": [
                {"id": self.opts.id, "object": "model", "owned_by": "llama-swap"},
                {"id": "some-chat-model", "object": "model", "owned_by": "llama-swap"}]}
            self._send(200, json.dumps(data).encode())
        else:
            self._send(404, json.dumps({"error": {"message": f"no route {self.path}"}}).encode())

    def do_POST(self):
        if self.path.startswith("/api/models/unload"):
            return self._send(200, json.dumps({"status": "unloaded"}).encode())
        if not self.path.startswith("/v1/audio/speech"):
            return self._send(404, json.dumps({"error": {"message": f"no route {self.path}"}}).encode())

        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0)
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError as e:
            return self._send(400, json.dumps({"error": {"message": f"body is not JSON: {e}",
                                                         "type": "invalid_request_error",
                                                         "param": None, "code": None}}).encode())
        # What the page sent, for the test to read back. Dev scaffolding no real server sends: the
        # header value stays printable and short, so a request full of lyrics does not break it.
        echo = ("X-Mock-Request", "".join(c for c in json.dumps(body, separators=(",", ":"))
                                          if 32 <= ord(c) < 127)[:190])

        try:
            song = check(body, self.opts.id)
        except Refused as e:
            return self._send(e.status, json.dumps(e.body).encode(), extra=[echo])
        seed = chosen_seed(body, self.opts.seed_out)
        windows = max(1, min(self.opts.windows,
                             math.ceil((song["frames"] - WINDOW_FRAMES) / LATER_FRAMES) + 1))
        out_frames = WINDOW_FRAMES + (windows - 1) * LATER_FRAMES
        headers = [("X-Seed", str(seed)), ("X-Audio-Sample-Rate", str(RATE)),
                   ("X-Audio-Channels", str(CHANNELS)), echo]
        fmt = song["fmt"]

        if not (song["sse"] or song["raw"]):
            time.sleep(self.opts.delay)
            audio = b"".join(pcm(out_frames / FRAME_RATE / windows, 196 * (1 + i * 0.12))
                             for i in range(windows))
            return self._send(200, wav(audio) if fmt == "wav" else audio, f"audio/{fmt}", headers)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if song["sse"] else f"audio/{fmt}")
        if song["sse"]:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if song["raw"]:
            self._chunk(wav(b"", unknown_length=True))   # a stream's header, sizes unknown
        sent = 0
        try:
            for i in range(windows):
                time.sleep(self.opts.delay)
                chunk = pcm((WINDOW_FRAMES if i == 0 else LATER_FRAMES) / FRAME_RATE,
                            196 * (1 + i * 0.12))
                sent += len(chunk)
                if song["sse"]:
                    event = {"type": "speech.audio.delta", "audio": base64.b64encode(chunk).decode(),
                             "response_format": "pcm", "sample_rate": RATE, "channels": CHANNELS}
                    self._chunk(f"event: speech.audio.delta\ndata: {json.dumps(event)}\n\n")
                else:
                    self._chunk(chunk)
            if song["sse"]:
                out = sent // (2 * CHANNELS)
                done = {"type": "speech.audio.done",
                        "usage": {"input_tokens": 128, "output_tokens": out // FRAME_RATE,
                                  "total_tokens": 128 + out // FRAME_RATE}}
                self._chunk(f"event: speech.audio.done\ndata: {json.dumps(done)}\n\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.log_message("the page hung up")
        self.close_connection = True


def selftest():
    """The mirror held up to itself: what the route takes, and exactly what it says when it refuses.
    dev/smoke.mjs asserts the same things over the wire in a browser; this needs neither a browser nor
    Docker, so CI can keep the wording honest. Run with `dev/mock-upstream.py --selftest`."""
    base = {"model": "minimax-music3", "input": "[verse]\ntest", "instructions": "Genre: test."}
    accepts = [
        ("a bare request runs to the model's longest", base,
         {"frames": MAX_FRAMES, "sse": False, "raw": False, "fmt": "wav"}),
        ("seconds become frames, 25 a second", {**base, "duration": 30},
         {"frames": 750, "sse": False, "raw": False, "fmt": "wav"}),
        ("frames are taken as given", {**base, "max_new_tokens": 750},
         {"frames": 750, "sse": False, "raw": False, "fmt": "wav"}),
        ("stream means events, and their body is pcm", {**base, "stream": True},
         {"frames": MAX_FRAMES, "sse": True, "raw": False, "fmt": "pcm"}),
        ("stream_format audio means the bytes themselves", {**base, "stream_format": "audio"},
         {"frames": MAX_FRAMES, "sse": False, "raw": True, "fmt": "wav"}),
        ("and the bytes may be a wav", {**base, "stream_format": "audio", "response_format": "pcm"},
         {"frames": MAX_FRAMES, "sse": False, "raw": True, "fmt": "pcm"}),
    ]
    refuses = [
        ("a field the route does not have", {**base, "lyrics_template": "auto"},
         "lyrics_template: 'lyrics_template' is not a field of /v1/audio/speech"),
        ("blank lyrics", {**base, "input": " \n "},
         "input: the text is required, as a non-empty string"),
        ("no instructions", {**base, "instructions": ""},
         "instructions: this model needs instructions, as a non-empty string: for a song its genre, "
         "mood, vocals and instruments"),
        ("seconds and frames together", {**base, "duration": 30, "max_new_tokens": 10},
         "duration: give max_new_tokens or duration, not both"),
        ("more frames than the model holds", {**base, "max_new_tokens": MAX_FRAMES + 1},
         f"max_new_tokens: expected an integer in 1..{MAX_FRAMES} (frames, {FRAME_RATE} a second)"),
        ("longer than six minutes", {**base, "duration": MAX_SECONDS + 1},
         f"duration: expected seconds in (0, {MAX_SECONDS}]"),
        ("guidance below one", {**base, "guidance_scale": 0.5},
         "guidance_scale: expected a number in [1, 30]"),
        ("no denoiser steps", {**base, "num_inference_steps": 0},
         "num_inference_steps: expected an integer in 1..1000"),
        ("a seed that is not a number", {**base, "seed": "42"}, "seed: expected an integer"),
        ("a tempo other than one", {**base, "speed": 1.5},
         "speed: this model keeps its own tempo; the instructions set it"),
        ("reference audio", {**base, "references": [{"audio": "x", "text": "y"}]},
         "references: this model takes no reference audio; its voice is described in the input"),
        ("events with a wav body", {**base, "stream": True, "response_format": "wav"},
         "response_format: an event carries raw PCM; set response_format pcm"),
        ("stream and stream_format both", {**base, "stream": True, "stream_format": "audio"},
         "stream: stream sends Server-Sent Events and stream_format audio sends the bytes themselves; "
         "give one"),
        ("a stream format that does not exist", {**base, "stream_format": "websocket"},
         "stream_format: a stream is sent as sse or audio"),
        ("another model's name", {**base, "model": "other"}, "model 'other' not found"),
    ]

    failed = 0
    for name, body, want in accepts:
        got = check(body, "minimax-music3")
        good = all(got[k] == v for k, v in want.items())
        print(f"{'ok  ' if good else 'FAIL'} {name}" + ("" if good else f" -- answered {got}"))
        failed += not good
    for name, body, why in refuses:
        try:
            check(body, "minimax-music3")
            print(f"FAIL {name} -- accepted, and radiance would not have")
            failed += 1
        except Refused as e:
            said = e.body["error"]["message"]
            good = said == why
            print(f"{'ok  ' if good else 'FAIL'} refuses {name}"
                 + ("" if good else f" -- said {said!r}, radiance says {why!r}"))
            failed += not good
    total = len(accepts) + len(refuses)
    print(f"{total - failed}/{total} of the route's rules mirrored the way radiance states them")
    return 1 if failed else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--id", default="minimax-music3", help="the model id this instance answers to")
    ap.add_argument("--windows", type=int, default=6, help="how many audio windows to send")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds each window takes to arrive")
    ap.add_argument("--seed-out", type=int, default=4242, help="the seed to report when asked to pick")
    ap.add_argument("--idle", action="store_true", help="say no model is loaded on /running")
    ap.add_argument("--selftest", action="store_true",
                    help="compare the refusals with radiance's own wording, and exit")
    opts = ap.parse_args()
    if opts.selftest:
        sys.exit(selftest())
    Handler.opts = opts
    print(f"[mock] llama-swap-ish on http://127.0.0.1:{Handler.opts.port} ({Handler.opts.id}, "
          f"{Handler.opts.windows} windows {Handler.opts.delay}s apart"
          f"{', nothing loaded' if Handler.opts.idle else ''})")
    ThreadingHTTPServer(("127.0.0.1", Handler.opts.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
