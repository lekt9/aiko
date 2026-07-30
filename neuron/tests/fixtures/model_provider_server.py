#!/usr/bin/env python3
"""Two local model providers for the models/devices/humans witness (Phase 4).

Deliberately small and honest about what it is: a test resource, not a mock of
the membrane. The membrane talks to it over real TCP with a real HTTP client.

Two providers answer the *same* typed contract with different implementations,
which is what makes swapping them a real swap rather than a rename:

  GET /alpha/complete?text=<v> -> {"completion": "<V> |alpha-labs|<n>"}
  GET /beta/complete?text=<v>  -> {"completion": "<V> #beta-systems#<n>"}

Both uppercase the prompt, so one acceptance predicate (`contains <V>`) holds
for either — but each stamps its own provider mark and a per-call sample
counter, so:

  * a second invocation of the *same* provider does NOT reproduce the first
    (these boundaries are genuinely nondeterministic — a model samples);
  * the served bytes say which provider actually answered, so the witness can
    prove the swap happened at the boundary rather than in the manifest text.

  GET /served?provider=<p> -> {"count": <n>} how many completions that provider
                              really served, so provider attribution is checked
                              against the far end's own counter instead of
                              stdout resemblance.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

SERVED = {"alpha-labs": 0, "beta-systems": 0}
SAMPLE = {"alpha-labs": 0, "beta-systems": 0}

# provider identity -> (route prefix, how it marks its own output)
PROVIDERS = {
    "alpha": ("alpha-labs", "|alpha-labs|"),
    "beta": ("beta-systems", "#beta-systems#"),
}


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
        route = parsed.path.strip("/").split("/")

        if parsed.path.startswith("/served"):
            provider = (query.get("provider") or [""])[0]
            return self._send(200, json.dumps({"count": SERVED.get(provider, 0)}))

        # /<provider>/complete
        if len(route) == 2 and route[1] == "complete" and route[0] in PROVIDERS:
            provider, mark = PROVIDERS[route[0]]
            text = (query.get("text") or [""])[0]
            SERVED[provider] += 1
            SAMPLE[provider] += 1
            # The sample counter is what makes this nondeterministic: the same
            # prompt does not produce the same bytes twice, exactly like a model
            # that samples. A determinism claim over this boundary would be a
            # lie the membrane refuses at admission.
            completion = f"{text.upper()} {mark}{SAMPLE[provider]}"
            return self._send(200, json.dumps({"completion": completion}))

        return self._send(404, json.dumps({"error": "no such route"}))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    # The gate reads the real bound port from stdout, so port 0 is safe here.
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
