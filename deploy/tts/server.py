"""VOICE-LOCAL-01: a tiny HTTP wrapper around Piper. POST /synthesize {"text", "voice"} -> audio/wav."""
import io
import json
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from piper import PiperVoice, SynthesisConfig

VOICES_DIR = Path("/voices")
DEFAULT = "irina"
_loaded: dict = {}
_lock = threading.Lock()


def available() -> list:
    return sorted(p.name.split("-")[1] for p in VOICES_DIR.glob("ru_RU-*-medium.onnx"))


def voice(name: str):
    names = available()
    if not names:
        return None
    if name not in names:
        name = DEFAULT if DEFAULT in names else names[0]
    with _lock:
        if name not in _loaded:
            _loaded[name] = PiperVoice.load(VOICES_DIR / f"ru_RU-{name}-medium.onnx")
        return _loaded[name]


def synthesize(text: str, name: str, speed: float) -> bytes:
    v = voice(name)
    if v is None:
        raise RuntimeError("no voices")
    buf = io.BytesIO()
    # speed 1.0 is the voice's own pace; the CRM asks for a touch slower so answers sound calm.
    config = SynthesisConfig(length_scale=max(0.7, min(1.4, 1.0 / speed)))
    with wave.open(buf, "wb") as wav:
        v.synthesize_wav(text, wav, syn_config=config)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def send(self, code: int, body: bytes, kind: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        names = available()
        self.send(200 if names else 503, json.dumps({"voices": names}).encode(), "application/json")

    def do_POST(self) -> None:
        if self.path != "/synthesize":
            return self.send(404, b"{}", "application/json")
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 20000)
            data = json.loads(self.rfile.read(length) or b"{}")
            text = str(data.get("text") or "").strip()[:1000]
            if not text:
                return self.send(400, b'{"error":"empty text"}', "application/json")
            audio = synthesize(text, str(data.get("voice") or DEFAULT), float(data.get("speed") or 1.0))
            self.send(200, audio, "audio/wav")
        except Exception as error:  # noqa: BLE001
            self.send(500, json.dumps({"error": str(error)}).encode(), "application/json")

    def log_message(self, *args) -> None:
        pass


if __name__ == "__main__":
    # Warm the default voice so the first answer is not slow.
    try:
        voice(DEFAULT)
    except Exception as error:  # noqa: BLE001
        print("warmup failed:", error, flush=True)
    print("piper tts on :5002, voices:", available(), flush=True)
    ThreadingHTTPServer(("0.0.0.0", 5002), Handler).serve_forever()
