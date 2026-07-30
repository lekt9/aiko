#!/usr/bin/env python3
"""witness_declare_dedup.py — proves declare idempotency survives a >16 MiB ledger.

The defect (residual a3, sibling of a2): findCachedDeclared() reads the ledger
via readAll (16 MiB cap) and swallows LedgerTooLarge (`catch return null`). On a
ledger >16 MiB that swallow returns null, so declare() cannot find the cached
row for an existing plan -> it appends a NEW row with a NEW id. Dedup is silently
broken and the store bloats in a death-spiral (more dup rows -> never shrinks).

This witness calls contract_declare twice with the SAME plan+action from a CWD
whose resolved ledger is >16 MiB, then compares the returned ids:
  - SAME id  -> findCachedDeclared found the cached row (dedup works)
  - DIFFERENT ids -> readAll failed, declare duplicated (dedup broken = RED)

Red on the pre-fix dylib (slurp readAll caps at 16 MiB). Green after the
forEachLine streaming fix in findCachedDeclared (no cap, deadlock-free since
forEachLine does not take the sidecar lock). Exits 0 only when ids match.

NOTE: this calls the low-level contract_declare ABI (plan+action -> id), NOT the
`contract declare` CLI resolver, so it does not trigger the legacy resolver pass.
"""
import ctypes
import os
import sys
import uuid
from pathlib import Path

LIB = os.environ.get("AIKO_CONTRACT_LIBRARY", str(Path.home() / ".aiko/lib/libcontract.dylib"))


def main() -> int:
    lib = ctypes.CDLL(LIB)
    lib.contract_declare.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
    lib.contract_declare.restype = ctypes.c_void_p
    lib.contract_free.argtypes = [ctypes.c_void_p]

    def declare(plan: str, action: str) -> str:
        ptr = lib.contract_declare(plan.encode(), action.encode(), None, None)
        if not ptr:
            return ""
        try:
            return ctypes.string_at(ptr).decode("utf-8")
        finally:
            lib.contract_free(ptr)

    probe = f"a3-dedup-witness-{uuid.uuid4().hex}"
    plan = f"dedup probe {probe}"
    action = "witness"
    id1 = declare(plan, action)
    id2 = declare(plan, action)
    print(f"plan={plan}")
    print(f"id1={id1}")
    print(f"id2={id2}")
    same = bool(id1) and id1 == id2
    print("VERDICT=" + ("PASS" if same else "FAIL (declare duplicated a cached plan)"))
    return 0 if same else 1


if __name__ == "__main__":
    raise SystemExit(main())
