#!/usr/bin/env python3
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import diagnostics as _diag
import fix as _fix
import gate as _gate
def run(inputs, ctx):
    ticket = inputs.get("ticket", {})
    capacity = inputs.get("capacity", {})
    max_iters = 8
    last = {"verdict": "needs_human", "result": {"action": "none"}}
    for i in range(1, max_iters+1):
        try:
            diag = _diag.run({"ticket": ticket}, ctx)["diagnosis"]
            fix_out = _fix.run({"diagnosis": diag}, ctx)
            gated = _gate.run({"verdict": fix_out["verdict"], "capacity": capacity}, ctx)
            verdict = gated["verdict"]
            result = fix_out["result"]
            if verdict in ("resolved", "escalated"):
                return {"verdict": verdict, "result": result, "iterations": i}
            last = {"verdict": verdict, "result": result}
        except Exception as e:
            msg = str(e)
            if "Timeout" in type(e).__name__ or "Timeout" in msg:
                last = {"verdict": "retrying", "result": {"error": msg}}
                continue
            raise
    raise RuntimeError(f"loop exhausted {max_iters} iters without verdict in resolved|escalated (last={last})")
