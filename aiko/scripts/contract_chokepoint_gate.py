#!/usr/bin/env python3
"""Structural invariant for Aiko's single model-facing tool execution route."""

from __future__ import annotations

import sys
from pathlib import Path


def check(path: Path) -> list[str]:
    text = path.read_text()
    errors: list[str] = []
    calls = text.count("dispatch_tool(")
    begins = text.count("bind_active_tool_contract(")
    settles = text.count("settle_active_tool_contract(")
    if calls != 2:
        errors.append(f"expected 2 dispatch sites (initial + managed-MCP retry), found {calls}")
    if begins != 1:
        errors.append(f"expected one Contract bind at the fan-in, found {begins}")
    if settles != 1:
        errors.append(f"expected one Contract settle at the fan-out, found {settles}")
    begin = text.find("bind_active_tool_contract(")
    first_call = text.find("dispatch_tool(")
    last_call = text.rfind("dispatch_tool(")
    settle = text.find("settle_active_tool_contract(")
    if min(begin, first_call, last_call, settle) < 0 or not begin < first_call <= last_call < settle:
        errors.append("Contract bind/dispatch/settle ordering is broken")
    if ".hold_reason()" not in text[begin:settle]:
        errors.append("Contract HOLD is not checked before dispatch")
    if "parse_mcp_tool_name" not in text[first_call:settle]:
        errors.append("MCP retry is not visibly enclosed by the same Contract")
    return errors


def main() -> int:
    path = Path(sys.argv[1])
    errors = check(path)
    if errors:
        print("CHOKEPOINT FAIL: " + "; ".join(errors))
        return 1
    print("CHOKEPOINT PASS: every central dispatch site is enclosed by one Contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
