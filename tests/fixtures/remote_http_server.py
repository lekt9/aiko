#!/usr/bin/env python3
"""A local HTTP boundary for the remote-interface witness.

Deliberately small and honest about what it is: a test resource, not a mock of
the membrane. The membrane talks to it over real TCP with a real HTTP client.

Endpoints:
  GET  /upper?text=<v>      -> {"result": "<V>"}      non-mutating, deterministic
  GET  /poison?text=<v>     -> {"wrong": "..."}       declared field absent
  GET  /malformed?text=<v>  -> not JSON at all
  GET  /boom?text=<v>       -> 500
  POST /store               -> {"stored": "<digest>"} mutating; requires the
                               Idempotency-Key header; records how many times
                               each key was actually applied
  GET  /stored?key=<digest> -> the stored bytes (the independent read-back
                               sensor reconciliation uses)
  GET  /applied?key=<digest>-> {"count": <n>} how many distinct applications
                               that key caused, so the witness can prove a
                               redelivery did not become a second effect
"""
import hashlib
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STORE = {}
APPLIED = {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep the gate output clean
        pass

    def _send(self, status, body, content_type="application/json"):
        payload = body if isinstance(body, bytes) else body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        text = (query.get("text") or [""])[0]
        key = (query.get("key") or [""])[0]

        if parsed.path == "/upper":
            self._send(200, json.dumps({"result": text.upper()}))
        elif parsed.path == "/poison":
            self._send(200, json.dumps({"wrong": text}))
        elif parsed.path == "/malformed":
            self._send(200, "this is not json at all", "text/plain")
        elif parsed.path == "/boom":
            self._send(500, json.dumps({"error": "deliberate"}))
        elif parsed.path == "/stored":
            if key in STORE:
                self._send(200, STORE[key], "application/octet-stream")
            else:
                self._send(404, json.dumps({"error": "absent"}))
        elif parsed.path == "/applied":
            self._send(200, json.dumps({"count": APPLIED.get(key, 0)}))
        else:
            self._send(404, json.dumps({"error": "no such endpoint"}))

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        key = self.headers.get("Idempotency-Key")

        if parsed.path != "/store":
            self._send(404, json.dumps({"error": "no such endpoint"}))
            return
        if not key:
            # A mutating endpoint that refuses unkeyed writes: the membrane
            # must be sending the key, not merely claiming to.
            self._send(400, json.dumps({"error": "Idempotency-Key required"}))
            return
        if key in STORE:
            # Same key, same effect: acknowledge without applying again.
            self._send(200, json.dumps({"stored": key, "duplicate": True}))
            return
        digest = hashlib.sha256(body).hexdigest()
        if digest != key:
            self._send(409, json.dumps({"error": "key is not the content digest"}))
            return
        STORE[key] = body
        APPLIED[key] = APPLIED.get(key, 0) + 1
        self._send(200, json.dumps({"stored": key, "duplicate": False}))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    # Announce the real port so the gate never has to guess or race.
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
