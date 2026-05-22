#!/usr/bin/env python3
"""
check-no-silent-fallback.py - fail if any contract-skill Python script
swallows an error silently.

An `except` handler whose entire body is a bare `pass` or `continue`
hides the error: the caller never learns something went wrong. Every
handler must surface the error (print to stderr, log it, or re-raise)
or do real recovery work. This is the mechanical action behind the
contract "the /contract skill never swallows an error silently".

Exit 0 = clean. Exit 1 = at least one silent swallow found.
"""
import ast, sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


def silent_handlers(path: Path) -> list:
    """Return (path, lineno) for every except handler that only pass/continues."""
    try:
        tree = ast.parse(path.read_text(), filename=str(path))
    except SyntaxError as e:
        print(f"  {path}: could not parse: {e}", file=sys.stderr)
        return [(path, e.lineno or 0)]
    bad = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ExceptHandler):
            body = node.body
            if len(body) == 1 and isinstance(body[0], (ast.Pass, ast.Continue)):
                bad.append((path, node.lineno))
    return bad


def main() -> None:
    found = []
    for py in sorted(SCRIPTS.rglob("*.py")):
        if "__pycache__" in py.parts:
            continue
        found += silent_handlers(py)
    if found:
        print("SILENT-FALLBACK CHECK: FAIL", file=sys.stderr)
        for path, ln in found:
            print(f"  {path}:{ln}  except handler body is a bare pass/continue; "
                  f"the error is swallowed silently", file=sys.stderr)
        sys.exit(1)
    print("SILENT-FALLBACK CHECK: clean (no except handler swallows an error)")


if __name__ == "__main__":
    main()
