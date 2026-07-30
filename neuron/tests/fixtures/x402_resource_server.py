#!/usr/bin/env python3
"""A local x402-compatible paid resource for the economic-profile witness.

Deliberately small and honest about what it is: a test resource, not a mock of
the membrane. The membrane talks to it over real TCP with a real HTTP client.

The flow it implements is the one in plan §10:

  GET /paid/answer?text=<v>              -> 402 + a neuron.payment-quote/v1 body
  GET /paid/answer?text=<v>  with a
      PAYMENT-SIGNATURE header           -> 200 {"result": "<V>"} once the proof
                                            is accepted

Proof acceptance is deliberately checkable rather than cryptographic: a payload
is valid when it is `paid:<sha256 of the exact challenge bytes>`. That keeps the
gate deterministic and hermetic while still exercising the real property under
test — that the membrane obtained a challenge, had something *else* sign it, and
retried the identical request carrying the result.

  GET /charges?resource=<r>  -> {"count": <n>} how many times this resource was
                                actually paid for, so "a retry did not repay"
                                is proven by the far end's own counter rather
                                than by the caller's belief.
  GET /free/answer?text=<v>  -> 200 without any challenge, so the witness can
                                show an economic profile does not force payment
                                where none is demanded.
  GET /wrong/answer?text=<v> -> always 402, even when presented a valid proof,
                                so a rejected proof is distinguishable from a
                                challenge.
"""
import hashlib
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

CHARGES = {}
# Payments that have already settled, as a real resource would track nonces.
# Re-presenting a payment that already settled serves the resource again but
# does NOT charge a second time — so "a retry did not repay" is a property the
# far end can actually attest to, rather than one the caller merely believes.
SETTLED = set()

QUOTE = {
    "schema": "neuron.payment-quote/v1",
    "amount_micros": 1500,
    "asset": "USDC",
    "network": "base-sepolia",
    "pay_to": "0x00000000000000000000000000000000000000a1",
    "resource": "/paid/answer",
    "expires_in_s": 120,
}

# Above any sane per-call ceiling: refused by the governor, never signed.
EXPENSIVE_QUOTE = dict(QUOTE, amount_micros=250000, resource="/expensive/answer")
# Affordable per call, but at or above the approval threshold: it needs a human.
DEAR_QUOTE = dict(QUOTE, amount_micros=4000, resource="/dear/answer")
FOREIGN_QUOTE = dict(QUOTE, asset="DOGE", resource="/foreign/answer")


def challenge_bytes(quote):
    # The exact bytes the client is challenged with; the proof is bound to them.
    return json.dumps(quote, sort_keys=True, separators=(",", ":")).encode()


def expected_proof(quote):
    return "paid:" + hashlib.sha256(challenge_bytes(quote)).hexdigest()


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

    def _paid_route(self, quote, text, always_challenge=False):
        proof = self.headers.get("PAYMENT-SIGNATURE")
        if always_challenge or not proof or proof != expected_proof(quote):
            return self._send(402, challenge_bytes(quote))
        resource = quote["resource"]
        if proof not in SETTLED:
            SETTLED.add(proof)
            CHARGES[resource] = CHARGES.get(resource, 0) + 1
        return self._send(200, json.dumps({"result": text.upper()}))

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        text = (query.get("text") or [""])[0]

        if parsed.path == "/charges":
            resource = (query.get("resource") or [""])[0]
            return self._send(200, json.dumps({"count": CHARGES.get(resource, 0)}))

        if parsed.path == "/free/answer":
            return self._send(200, json.dumps({"result": text.upper()}))

        routes = {
            "/paid/answer": (QUOTE, False),
            "/expensive/answer": (EXPENSIVE_QUOTE, False),
            "/dear/answer": (DEAR_QUOTE, False),
            "/foreign/answer": (FOREIGN_QUOTE, False),
            "/wrong/answer": (QUOTE, True),
        }
        if parsed.path in routes:
            quote, always = routes[parsed.path]
            return self._paid_route(quote, text, always_challenge=always)

        return self._send(404, json.dumps({"error": "no such route"}))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
