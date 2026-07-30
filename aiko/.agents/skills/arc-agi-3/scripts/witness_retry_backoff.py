#!/usr/bin/env python3
"""Witness: the ARC API interface retries transient failures with backoff and
fails fast on real 4xx. Covers every online op (all go through _request).

Runs offline (no network, no key): monkeypatches arc_client._opener with a fake
opener scripted to fail then succeed, and asserts _request's behavior. Exit 0 +
RETRY_BACKOFF_OK on all checks; exit 1 otherwise.
"""
import json
import os
import sys
import urllib.error

os.environ.setdefault("ARC_HTTP_TRIES", "5")
os.environ["ARC_HTTP_BASE_DELAY"] = "0"   # no real waiting in the witness
os.environ["ARC_HTTP_CAP_DELAY"] = "0"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arc_client as A  # noqa: E402

A.time.sleep = lambda *a, **k: None  # belt-and-suspenders: never sleep in the test


class FakeResp:
    def __init__(self, body):
        self._b = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._b


class FakeOpener:
    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    def open(self, req, timeout=None):
        self.calls += 1
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return FakeResp(item)


class FakeJar:
    def save(self, *a, **k):
        pass


def patch(script):
    fo = FakeOpener(script)
    A._opener = lambda: (fo, FakeJar())
    return fo


def http_err(code):
    return urllib.error.HTTPError("http://x/p", code, "err", {}, None)


fails = []


def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        fails.append(name)


# T1: two transient network errors then success -> retried, returns body (3 calls)
fo = patch([urllib.error.URLError("reset"), urllib.error.URLError("chunk-trunc"), {"ok": 1}])
r = A._request(object(), "/play")
check("transient network errors retried to success (3 calls)", r == {"ok": 1} and fo.calls == 3)

# T2: 503 (retryable status) then success -> retried (2 calls)
fo = patch([http_err(503), {"ok": 2}])
r = A._request(object(), "/play")
check("5xx retried to success (2 calls)", r == {"ok": 2} and fo.calls == 2)

# T3: 429 rate-limit then success -> retried
fo = patch([http_err(429), {"ok": 3}])
r = A._request(object(), "/play")
check("429 retried to success", r == {"ok": 3} and fo.calls == 2)

# T4: 404 (real client error) -> fail FAST, exactly 1 call, no retry
fo = patch([http_err(404), {"never": True}])
try:
    A._request(object(), "/play")
    check("404 fails fast", False)
except SystemExit:
    check("404 fails fast (1 call, no retry)", fo.calls == 1)

# T5: all attempts fail -> gives up after ARC_HTTP_TRIES (5 calls)
fo = patch([urllib.error.URLError("x")] * 9)
try:
    A._request(object(), "/play")
    check("exhausts then exits", False)
except SystemExit:
    check("exhausts retries then exits (5 calls)", fo.calls == A._RETRY_TRIES)

# T6: backoff is bounded by the cap (with full jitter, <= 1.5x cap) and non-negative
A._RETRY_BASE, A._RETRY_CAP = 0.5, 4.0
ds = [A._backoff_delay(i) for i in range(8)]
check("backoff bounded by cap and non-negative", all(0 <= d <= A._RETRY_CAP * 1.5 for d in ds))
check("backoff grows early (mean d[4:] >= mean d[:2])",
      sum(ds[4:]) / 4 >= sum(ds[:2]) / 2)

if fails:
    print(f"RETRY_BACKOFF_FAIL: {fails}")
    sys.exit(1)
print("RETRY_BACKOFF_OK")
