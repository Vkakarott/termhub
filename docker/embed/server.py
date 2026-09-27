"""
Text embeddings for termhub's chat decision memory (spec 2026-09-26 §3.2), fastembed (ONNX) on CPU.

  GET  /health   200 {"model", "dim"} once the model is loaded (503 while downloading/loading)
  POST /embed    Authorization: Bearer $EMBED_SECRET, {"texts": [...]} -> {"model", "dim", "vectors"}

Texts are never written to disk nor logged: the log carries counts and timings only.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from api import BadRequest, authorized, load_retry_delay, parse_request

MODEL = os.environ.get("EMBED_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
SECRET = os.environ.get("EMBED_SECRET", "")
PORT = int(os.environ.get("PORT", "8000"))
THREADS = int(os.environ.get("EMBED_THREADS", "0")) or None
MAX_BYTES = 256 * 1024

model = None
dim = 0
lock = threading.Lock()


def load() -> None:
    """Loads the model, retrying until it succeeds: a first start downloads the weights, and a
    failed download (Hugging Face answers 429 to anonymous bursts) must not leave the service up
    but modelless forever — /health and /embed answer 503 until a retry gets through."""
    global model, dim
    from fastembed import TextEmbedding
    attempt = 0
    while True:
        started = time.time()
        try:
            m = TextEmbedding(MODEL, cache_dir="/models", threads=THREADS)
            d = len(next(iter(m.embed(["warm up"]))))
        except Exception as err:  # the download or the ONNX load; retried as a whole
            delay = load_retry_delay(attempt)
            print(f"model {MODEL} not loaded ({type(err).__name__}), retrying in {delay}s", file=sys.stderr, flush=True)
            attempt += 1
            time.sleep(delay)
            continue
        dim, model = d, m
        print(f"model {MODEL} loaded (dim {dim}) in {time.time() - started:.1f}s", flush=True)
        return


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        if model is None:
            return self._send(503, {"error": "loading"})
        self._send(200, {"model": MODEL, "dim": dim})

    def do_POST(self) -> None:
        if self.path != "/embed":
            return self._send(404, {"error": "not found"})
        if not authorized(self.headers.get("Authorization"), SECRET):
            return self._send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self._send(400, {"error": "bad length"})
        try:
            texts = parse_request(self.rfile.read(length))
        except BadRequest as err:
            return self._send(400, {"error": str(err)})
        if model is None:
            return self._send(503, {"error": "loading"})
        started = time.time()
        with lock:
            vectors = [v.tolist() for v in model.embed(texts)]
        print(f"embedded {len(texts)} texts in {(time.time() - started) * 1000:.0f}ms", flush=True)
        self._send(200, {"model": MODEL, "dim": dim, "vectors": vectors})

    def log_message(self, *_args) -> None:  # the default access log is noise; errors print above
        pass


if __name__ == "__main__":
    if not SECRET:
        print("EMBED_SECRET is empty: every /embed request will be refused", file=sys.stderr, flush=True)
    threading.Thread(target=load, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
