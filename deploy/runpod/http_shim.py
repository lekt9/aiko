#!/usr/bin/env python3
# http_shim.py — minimal OpenAI-compatible HTTP transport in front of the
# aiko binary. Reads HTTP request, pipes body to `aiko openai` via subprocess,
# returns the JSON response. No business logic — all transformation lives
# in zig (cmdOpenAi + humanizePersona).
#
# Listens on $PORT (default 8080). Routes:
#   POST /v1/chat/completions  — main endpoint
#   GET  /v1/models             — returns [{"id":"aiko-69420b",...}]
#   GET  /health                — liveness for serverless runner

from http.server import HTTPServer, BaseHTTPRequestHandler
import os, json, subprocess

AIKO_BIN = os.environ.get("AIKO_BIN", "/usr/local/bin/aiko")
PORT = int(os.environ.get("PORT", "8080"))

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a, **kw): pass

    def _json(self, status, body):
        body_bytes = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"status": "ok", "model": "aiko-69420b"})
        if self.path == "/v1/models":
            return self._json(200, {
                "object": "list",
                "data": [{
                    "id": "aiko-69420b",
                    "object": "model",
                    "owned_by": "aiko",
                    "ca": "2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL",
                }]
            })
        return self._json(404, {"error": {"message": "not found", "type": "not_found"}})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            return self._json(404, {"error": {"message": "not found", "type": "not_found"}})
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        try:
            proc = subprocess.run(
                [AIKO_BIN, "openai"],
                input=body,
                capture_output=True,
                timeout=120,
            )
        except subprocess.TimeoutExpired:
            return self._json(504, {"error": {"message": "aiko timeout", "type": "timeout"}})
        out = proc.stdout
        try:
            parsed = json.loads(out)
        except Exception:
            return self._json(502, {
                "error": {
                    "message": "aiko returned malformed json",
                    "type": "upstream_error",
                    "raw": out.decode(errors="replace")[:500],
                }
            })
        return self._json(200, parsed)

if __name__ == "__main__":
    print(f"aiko http-shim listening on 0.0.0.0:{PORT}", flush=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
