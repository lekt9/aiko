"""Mock RunPod serverless API for the runpod verb-gate.

Listens on 127.0.0.1:<port> (argv[1]; 0 = ephemeral). Implements:

  POST /v2/<endpoint_id>/runsync
       body: {"input": {"cmd": "..."}}
       resp shapes (control via request body / endpoint):
         endpoint == "ok-endpoint"         → COMPLETED + exit_code 0 + stdout echoes cmd
         endpoint == "fail-endpoint"       → COMPLETED + exit_code 7
         endpoint == "errored-endpoint"    → FAILED + error="OOMKilled" + exit_code 137
         endpoint == "queued-endpoint"     → IN_QUEUE (runsync should never return this)
         endpoint == "broken-endpoint"     → 502 (upstream gateway error)
         anything else                     → COMPLETED + exit_code 0 (generic)

Auth: Authorization: Bearer <anything> required.

Test-control:
  GET  /__state   → {call_count, last_endpoint, last_cmd}
  POST /__reset   → clear state
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = {"call_count": 0, "last_endpoint": "", "last_cmd": "", "last_status_returned": 0}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _read(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _auth_ok(self) -> bool:
        return bool(self.headers.get("Authorization", "").strip().lower().startswith("bearer "))

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        with LOCK:
            STATE["last_status_returned"] = code

    def do_GET(self):
        if self.path == "/__state":
            with LOCK:
                self._send_json(200, dict(STATE))
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/__reset":
            with LOCK:
                STATE.update(call_count=0, last_endpoint="", last_cmd="", last_status_returned=0)
            self._send_json(200, {"ok": True})
            return

        # POST /v2/<endpoint>/runsync
        if self.path.startswith("/v2/") and self.path.endswith("/runsync"):
            if not self._auth_ok():
                self._send_json(401, {"error": "Unauthorized"})
                return
            endpoint = self.path[len("/v2/"):-len("/runsync")]
            try:
                req = json.loads(self._read() or b"{}")
            except json.JSONDecodeError:
                self._send_json(400, {"error": "bad json"})
                return
            cmd = ((req.get("input") or {}).get("cmd")) or ""
            with LOCK:
                STATE["call_count"] += 1
                STATE["last_endpoint"] = endpoint
                STATE["last_cmd"] = cmd

            if endpoint == "broken-endpoint":
                self._send_json(502, {"error": "bad gateway"})
                return
            if endpoint == "queued-endpoint":
                self._send_json(200, {"id": "abc", "status": "IN_QUEUE"})
                return
            if endpoint == "errored-endpoint":
                self._send_json(200, {
                    "id": "abc",
                    "status": "FAILED",
                    "output": {"error": "OOMKilled", "exit_code": 137},
                })
                return
            if endpoint == "fail-endpoint":
                self._send_json(200, {
                    "id": "abc",
                    "status": "COMPLETED",
                    "output": {"stdout": f"ran-then-failed: {cmd}\n", "exit_code": 7},
                })
                return
            # default OK path (covers ok-endpoint + any other id)
            self._send_json(200, {
                "id": "abc",
                "status": "COMPLETED",
                "output": {"stdout": f"echo-back: {cmd}\n", "exit_code": 0},
            })
            return

        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    srv = HTTPServer(("127.0.0.1", port), Handler)
    bound = srv.server_address[1]
    sys.stdout.write(f"PORT={bound}\n")
    sys.stdout.flush()
    srv.serve_forever()
