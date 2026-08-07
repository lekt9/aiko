#!/usr/bin/env python3
"""Benchmark Aiko's request path and decompose WHERE the wall-clock goes.

A slow turn can be slow for very different reasons — network/proxy hops, prompt
processing before the first token, the model *thinking* (reasoning tokens), or
the answer itself streaming out. Averaging "it took 40s" hides which. This
harness streams each request and timestamps the phase boundaries, so the trace
says which phase dominated:

  send ──TTFT──▶ first byte ──▶ first reasoning ──think──▶ first answer ──▶ done
        (network + queue +          (model reasoning tokens)   (answer stream)
         prompt processing)

It runs a matrix of (endpoint × model × reasoning_effort) so the comparison is
controlled: the same prompt, only one knob changed at a time. The output is a
table plus a JSON trace file for each run.

    python scripts/bench-aiko-speed.py                 # default matrix
    python scripts/bench-aiko-speed.py --repeats 3     # average N runs
    python scripts/bench-aiko-speed.py --prompt "..."  # custom task

Auth reuses the aiko session JWT from ~/.aiko/auth.json (no key pasted).
"""
import argparse
import json
import os
import sys
import time
import urllib.request

AUTH = os.path.expanduser("~/.aiko/auth.json")
DIRECT = "https://aiko-proxy.lewis-6d8.workers.dev/v1/chat/completions"
PUBLIC = "https://aiko.theclarityproject.net/v1/chat/completions"

DEFAULT_PROMPT = (
    "Write a Python function that merges two sorted lists into one sorted list "
    "without using sort(), and explain its time complexity in one sentence."
)


def session_token() -> str:
    d = json.load(open(AUTH))
    for k, v in d.items():
        if "theclarityproject.net" in k and isinstance(v, dict) and v.get("key"):
            return v["key"]
    raise SystemExit("no aiko session key in ~/.aiko/auth.json")


def run_once(url: str, model: str, effort, prompt: str, timeout: float = 180.0) -> dict:
    body = {
        "model": model,
        "stream": True,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 800,
    }
    if effort is not None:
        body["reasoning_effort"] = effort
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            # Cloudflare in front of the proxy 403s a bare urllib User-Agent as a
            # bot; a normal UA passes (the token is what actually authorizes).
            "User-Agent": "curl/8.4.0",
        },
        method="POST",
    )

    t_send = time.perf_counter()
    marks = {"ttfb": None, "first_reasoning": None, "first_answer": None, "done": None}
    reasoning_chars = answer_chars = 0
    usage = None
    status = None
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        status = resp.status
        for raw in resp:
            now = time.perf_counter()
            if marks["ttfb"] is None:
                marks["ttfb"] = now
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                marks["done"] = now
                break
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            if obj.get("usage"):
                usage = obj["usage"]
            for ch in obj.get("choices", []):
                delta = ch.get("delta", {})
                rc = delta.get("reasoning_content")
                cc = delta.get("content")
                if rc:
                    reasoning_chars += len(rc)
                    if marks["first_reasoning"] is None:
                        marks["first_reasoning"] = now
                if cc:
                    answer_chars += len(cc)
                    if marks["first_answer"] is None:
                        marks["first_answer"] = now
        if marks["done"] is None:
            marks["done"] = time.perf_counter()
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200], "status": status}

    def dt(a, b):
        return round((marks[b] - marks[a]) * 1000) if marks[a] and marks[b] else None

    ttft = round((marks["ttfb"] - t_send) * 1000) if marks["ttfb"] else None
    total = round((marks["done"] - t_send) * 1000) if marks["done"] else None
    think = dt("first_reasoning", "first_answer")
    answer = dt("first_answer", "done")
    return {
        "status": status,
        "ttft_ms": ttft,
        "think_ms": think,          # reasoning-token generation
        "answer_ms": answer,        # answer streaming
        "total_ms": total,
        "reasoning_chars": reasoning_chars,
        "answer_chars": answer_chars,
        "usage": usage,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--out", default="/tmp/aiko-bench-trace.json")
    args = ap.parse_args()

    global TOKEN
    TOKEN = session_token()

    # One knob changed at a time, same prompt throughout.
    matrix = [
        ("direct", DIRECT, "kimi-k3", "xhigh"),
        ("direct", DIRECT, "kimi-k3", "low"),
        ("direct", DIRECT, "kimi-k3", None),
        ("direct", DIRECT, "deepseek-v4-pro", None),
        ("direct", DIRECT, "deepseek-v4-flash", None),
        ("public", PUBLIC, "kimi-k3", "xhigh"),   # compat hop vs direct
    ]

    print(f"prompt: {args.prompt[:70]}...")
    print(f"repeats: {args.repeats}\n")
    header = f"{'endpoint':8} {'model':18} {'effort':6} {'TTFT':>6} {'think':>7} {'answer':>7} {'total':>7} {'rsn/ans chars':>14}"
    print(header); print("-" * len(header))

    traces = []
    for endpoint, url, model, effort in matrix:
        runs = [run_once(url, model, effort, args.prompt) for _ in range(args.repeats)]
        traces.append({"endpoint": endpoint, "model": model, "effort": effort, "runs": runs})
        ok = [r for r in runs if "error" not in r and r.get("total_ms")]
        if not ok:
            err = runs[0].get("error", "no data")
            print(f"{endpoint:8} {model:18} {str(effort):6} — FAILED: {err}")
            continue

        def avg(key):
            vals = [r[key] for r in ok if r.get(key) is not None]
            return round(sum(vals) / len(vals)) if vals else None

        ttft, think, answer, total = avg("ttft_ms"), avg("think_ms"), avg("answer_ms"), avg("total_ms")
        rc = avg("reasoning_chars"); ac = avg("answer_chars")
        print(f"{endpoint:8} {model:18} {str(effort):6} "
              f"{fmt(ttft):>6} {fmt(think):>7} {fmt(answer):>7} {fmt(total):>7} "
              f"{f'{rc}/{ac}':>14}")

    json.dump(traces, open(args.out, "w"), indent=2)
    print(f"\ntraces → {args.out}")


def fmt(ms):
    if ms is None:
        return "-"
    return f"{ms/1000:.1f}s" if ms >= 1000 else f"{ms}ms"


if __name__ == "__main__":
    main()
