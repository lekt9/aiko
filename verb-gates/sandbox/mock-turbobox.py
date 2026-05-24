"""Mock turbobox server for the sandbox verb-gate.

Listens on 127.0.0.1:<port> (port chosen by caller via argv[1]).
Implements the three endpoints sandbox_layer.py touches:

  POST /v1/boxes            → 200 {"id": "box-<n>", "status":"running"}
  POST /v1/boxes/<id>/exec  → 200 {"output": "<cmd echoed back>", "exit_code": 0}
                              ...unless cmd starts with "FAILME" → exit_code: 7
                              ...unless cmd starts with "NOAUTH" → 401 {"error":"api key required"}
  DELETE /v1/boxes/<id>     → 204

Also exposes:
  GET /__state              → JSON: {"created":N, "execed":N, "destroyed":N, "last_cmd":...}
  POST /__reset             → clear state

Auth: requires "Authorization: Bearer <anything-truthy>" on /v1/* (except as noted).
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = {"created": 0, "execed": 0, "destroyed": 0, "last_cmd": "", "last_image": "", "boxes": set()}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return  # silent

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

    def do_GET(self):
        if self.path == "/__state":
            with LOCK:
                self._send_json(200, {**{k: v for k, v in STATE.items() if k != "boxes"},
                                     "live_boxes": sorted(STATE["boxes"])})
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/__reset":
            with LOCK:
                STATE.update(created=0, execed=0, destroyed=0, last_cmd="", last_image="")
                STATE["boxes"] = set()
            self._send_json(200, {"ok": True})
            return

        if self.path == "/v1/boxes":
            if not self._auth_ok():
                self._send_json(401, {"error": "api key required"})
                return
            try:
                req = json.loads(self._read() or b"{}")
            except json.JSONDecodeError:
                self._send_json(400, {"error": "bad json"})
                return
            with LOCK:
                STATE["created"] += 1
                box_id = f"box-{STATE['created']}"
                STATE["boxes"].add(box_id)
                STATE["last_image"] = req.get("image", "")
            self._send_json(200, {"id": box_id, "status": "running", "image": req.get("image", "")})
            return

        if self.path.startswith("/v1/boxes/") and self.path.endswith("/exec"):
            if not self._auth_ok():
                self._send_json(401, {"error": "api key required"})
                return
            box_id = self.path[len("/v1/boxes/"):-len("/exec")]
            cmd = self._read().decode("utf-8", errors="replace")
            with LOCK:
                STATE["execed"] += 1
                STATE["last_cmd"] = cmd
                if box_id not in STATE["boxes"]:
                    self._send_json(404, {"error": f"no such box {box_id}"})
                    return
            if cmd.startswith("NOAUTH"):
                self._send_json(401, {"error": "api key required"})
                return
            exit_code = 7 if cmd.startswith("FAILME") else 0
            self._send_json(200, {"output": f"echo-back: {cmd}", "exit_code": exit_code})
            return

        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        if self.path.startswith("/v1/boxes/"):
            if not self._auth_ok():
                self._send_json(401, {"error": "api key required"})
                return
            box_id = self.path[len("/v1/boxes/"):]
            with LOCK:
                STATE["boxes"].discard(box_id)
                STATE["destroyed"] += 1
            self.send_response(204)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    srv = HTTPServer(("127.0.0.1", port), Handler)
    bound = srv.server_address[1]
    # Print the bound port so the gate can read it back, then serve.
    sys.stdout.write(f"PORT={bound}\n")
    sys.stdout.flush()
    srv.serve_forever()
