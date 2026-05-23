#!/usr/bin/env python3
"""check-hook-subprocess-surfacing — every internal hook script that wraps
a subprocess MUST surface non-zero exit codes (so failures appear in
~/.contracts/hooks/errors.log instead of vanishing into capture_output).

The bug class this prevents:

    subprocess.run([...], capture_output=True, check=False)
    # ^ ignores .returncode AND silently swallows .stderr

When a hook does that, a failing subprocess looks identical to a
succeeding one. That is how the crystallize-learning hook hid two
satisfied+learning contracts (173c8819, bbbdb533) from the drill loop's
"all-green" verdict on 2026-05-23. See contract ea66c811.

Acceptable patterns (any one suffices):
  - check=True (raises on non-zero — caller MUST then handle)
  - explicit .returncode read combined with stderr logging
  - capture_output=False so stderr flows to the hook's own stderr,
    which the contract CLI captures into hooks/errors.log

Scope: ~/.contracts/hooks/*.py (the internal hook bus). Scripts here
fire on every iterate/mark event; a silent failure is invisible by design
unless this check catches it.

Exit 0 = every hook surfaces non-zero exits. Exit 1 = at least one
silent-subprocess pattern found.
"""
import ast
import sys
from pathlib import Path

HOOKS_DIR = Path.home() / ".contracts" / "hooks"


def is_capture_true(node: ast.Call) -> bool:
    """True if the call sets capture_output=True (or stdout/stderr=PIPE)."""
    for kw in node.keywords:
        if kw.arg == "capture_output" and isinstance(kw.value, ast.Constant) \
                and kw.value.value is True:
            return True
        if kw.arg in ("stdout", "stderr") and isinstance(kw.value, ast.Attribute):
            # subprocess.PIPE
            if kw.value.attr == "PIPE":
                return True
    return False


def is_check_true(node: ast.Call) -> bool:
    for kw in node.keywords:
        if kw.arg == "check" and isinstance(kw.value, ast.Constant) \
                and kw.value.value is True:
            return True
    return False


def is_subprocess_run_call(node: ast.Call) -> bool:
    """subprocess.run / subprocess.call / subprocess.Popen as the callee."""
    if not isinstance(node.func, ast.Attribute):
        return False
    if node.func.attr not in ("run", "call", "Popen", "check_output"):
        return False
    if isinstance(node.func.value, ast.Name) and node.func.value.id == "subprocess":
        return True
    return False


def find_violators(path: Path) -> list[tuple[int, str]]:
    """Return (lineno, snippet) for every silent-subprocess call in the file."""
    try:
        text = path.read_text()
        tree = ast.parse(text, filename=str(path))
    except (OSError, SyntaxError) as e:
        return [(0, f"could not parse: {e}")]

    # Mechanical safety net: the file must mention .returncode AND
    # errors.log (or a log-append path) somewhere if it does capture_output
    # silent. If the file does neither, every capture_output call is a
    # violator. If it has BOTH, we assume the file surfaces — substrate
    # principle: trust but verify; the check surfaces, the agent judges.
    has_returncode = ".returncode" in text or "returncode " in text
    has_log = "errors.log" in text

    bad = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not is_subprocess_run_call(node):
            continue
        if is_check_true(node):
            continue  # raises on non-zero — caller is forced to handle
        if not is_capture_true(node):
            continue  # stderr flows naturally
        # capture_output silent: file must show evidence of surfacing
        if has_returncode and has_log:
            continue
        snippet = ast.get_source_segment(text, node) or "<subprocess call>"
        bad.append((node.lineno, snippet.splitlines()[0][:80]))
    return bad


def main() -> int:
    if not HOOKS_DIR.is_dir():
        print(f"  (no hooks dir at {HOOKS_DIR} — vacuously OK)")
        return 0

    py_hooks = sorted(HOOKS_DIR.glob("*.py"))
    if not py_hooks:
        print(f"  (no python hooks in {HOOKS_DIR} — vacuously OK)")
        return 0

    all_bad: list[tuple[Path, int, str]] = []
    for hook in py_hooks:
        for line, snippet in find_violators(hook):
            all_bad.append((hook, line, snippet))

    if all_bad:
        print("silent-subprocess pattern detected in hook(s):", file=sys.stderr)
        for hook, line, snippet in all_bad:
            print(f"  {hook}:{line}  {snippet}", file=sys.stderr)
        print(file=sys.stderr)
        print("  Fix: read .returncode after subprocess.run and append captured", file=sys.stderr)
        print("  .stderr to ~/.contracts/hooks/errors.log on non-zero exit, or", file=sys.stderr)
        print("  use check=True so non-zero raises and is caught explicitly.", file=sys.stderr)
        return 1

    print(f"hook-subprocess-surfacing clean: {len(py_hooks)} python hook(s) "
          f"in {HOOKS_DIR} all surface non-zero exits.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
