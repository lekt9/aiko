"""Mock unbrowse /v1/contract/mirror for the unbrowse-mirror verb-gate.

Listens on 127.0.0.1:<port> (argv[1]; 0 = ephemeral). Same shape as
the production endpoint: POST /v1/contract/mirror with bearer auth,
content-hash de-dup, returns {mirrored, event_id, contract_id, reason?}.

Test-control endpoints (not in production):
  GET  /__state         → {received_rows:[...], call_count:N, last_status:200}
  POST /__reset         → clear state
  POST /__force-status  → body "{status:500}" makes next response use that code

Auth: Authorization: Bearer <anything> required. No key → 401.
"""
import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = {
    "received": [],        # list of {event_id, row, ts_received}
    "call_count": 0,       # total POST /v1/contract/mirror calls
    "force_status": 0,     # if non-zero, next response uses this status
    "force_message": "",   # body for forced status
}
LOCK = threading.Lock()


def _content_hash(row: dict) -> str:
    """Match handleMirror's stable hash: keys-sorted, no whitespace, SHA-256,
    first 16 hex chars. Drops event_id (server-derived round-trip metadata)."""
    clean = {k: v for k, v in row.items() if k != "event_id"}
    canonical = json.dumps(clean, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


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

    def do_GET(self):
        if self.path == "/__state":
            with LOCK:
                snap = {
                    "received_rows": list(STATE["received"]),
                    "call_count": STATE["call_count"],
                    "unique_event_ids": sorted({r["event_id"] for r in STATE["received"]}),
                }
            self._send_json(200, snap)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/__reset":
            with LOCK:
                STATE["received"] = []
                STATE["call_count"] = 0
                STATE["force_status"] = 0
                STATE["force_message"] = ""
            self._send_json(200, {"ok": True})
            return

        if self.path == "/__force-status":
            body = self._read().decode("utf-8", errors="replace")
            try:
                req = json.loads(body or "{}")
            except json.JSONDecodeError:
                req = {}
            with LOCK:
                STATE["force_status"] = int(req.get("status", 0) or 0)
                STATE["force_message"] = str(req.get("message", "forced"))
            self._send_json(200, {"ok": True, "force_status": STATE["force_status"]})
            return

        if self.path == "/v1/contract/mirror":
            with LOCK:
                STATE["call_count"] += 1
                forced = STATE["force_status"]
                forced_msg = STATE["force_message"]
                if forced:
                    # One-shot force: next call after this resets to normal.
                    STATE["force_status"] = 0
                    STATE["force_message"] = ""

            if forced:
                self._send_json(forced, {"error": forced_msg})
                return

            if not self._auth_ok():
                self._send_json(401, {"error": "api key required"})
                return

            try:
                req = json.loads(self._read() or b"{}")
            except json.JSONDecodeError:
                self._send_json(400, {"error": "bad json"})
                return

            row = req.get("row")
            if not isinstance(row, dict) or not row.get("event") or not row.get("id"):
                self._send_json(400, {"error": "row must carry event+id"})
                return

            event_id = _content_hash(row)
            with LOCK:
                existing_hashes = {r["event_id"] for r in STATE["received"]}
                was_present = event_id in existing_hashes
                if not was_present:
                    STATE["received"].append({"event_id": event_id, "row": row})
            resp = {
                "mirrored": not was_present,
                "event_id": event_id,
                "contract_id": row["id"],
            }
            if was_present:
                resp["reason"] = "idempotent_duplicate"
            self._send_json(200, resp)
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
