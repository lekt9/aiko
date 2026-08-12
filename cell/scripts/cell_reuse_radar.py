#!/usr/bin/env python3
"""cell_reuse_radar.py — steer before forking a new cell/neuron.

Reuse is first-class in cell: a new *.cell.yaml or neurons/*.py that re-implements
an existing cell/neuron is unwitnessed work (no tests, no callers, diverges from
production wiring). This is the domain-specific radar: membrane ports + organelle
cells + neuron symbols + leading description.

Reuses the jesus-pattern steer shape (exit 0=STEER/reuse, 3=clear), but scans
*.cell.yaml (name, description, membrane ports, organelle cells, run.kind/entry)
and neurons/*.py (def/class symbols, lead comment) so it names the right cell to
wire/fix instead of a generic code module.

Usage:
  python3 cell/scripts/cell_reuse_radar.py --repo cell --name my-thing.cell.yaml --intent "..."
  python3 cell/scripts/cell_reuse_radar.py --repo cell --name my_neuron.py --intent "..."
Exit 0 = STEER (reuse/fix existing); 3 = clear.
"""
from __future__ import annotations
import argparse, os, re, sys
try:
    import yaml  # type: ignore
except ImportError:
    yaml = None

STOP = {
    "the","and","for","with","from","this","that","into","via","use","get","set","new","make","run","cell","api","kind","spec","membrane",
    "inputs","outputs","caps","organelles","wiring","metadata","name","description","version","python","exec","http","allow","string","object",
    "array","integer","number","boolean","required","schema","render","neurons","primitives","patterns","example","system","test","spec","index",
    "main","util","utils","helper","helpers","lib","src","common","core","base","impl","types","config","data","value","result","error","async",
}
SKIP_DIR = {"node_modules",".git","dist","build","target","__pycache__",".venv","venv",".next",".cell-canonical","out","_work","web",".cell-cas"}
DECL = re.compile(r"(?:def|class|func|fn)\s+([A-Za-z_][A-Za-z0-9_]*)")
LEAD = re.compile(r"[A-Za-z][A-Za-z0-9]+")

def split_ident(s: str) -> list[str]:
    s = re.sub(r"[^A-Za-z0-9]+", " ", s)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    return [t.lower() for t in s.split()]

def toks(*chunks: str) -> set[str]:
    out: set[str] = set()
    for c in chunks:
        for t in split_ident(c):
            if len(t) > 2 and t not in STOP and not t.isdigit():
                out.add(t)
    return set(t for t in out if len(t) > 2)

def lead_comment(text: str) -> str:
    return " ".join(LEAD.findall("\n".join(text.splitlines()[:25]))[:60])

def cell_signature(path: str) -> set[str]:
    try:
        text = open(path, encoding="utf-8", errors="ignore").read()
    except OSError:
        return set()
    if yaml is None:
        return toks(os.path.basename(path), lead_comment(text))
    try:
        d = yaml.safe_load(text) or {}
    except Exception:
        return toks(os.path.basename(path), lead_comment(text))
    if not isinstance(d, dict):
        return toks(os.path.basename(path), lead_comment(text))
    meta = d.get("metadata") or {}
    spec = d.get("spec") or {}
    membrane = spec.get("membrane") or {}
    inputs = " ".join((membrane.get("inputs") or {}).keys())
    outputs = " ".join((membrane.get("outputs") or {}).keys())
    organelles = " ".join(o.get("cell","") + " " + o.get("name","") for o in (spec.get("organelles") or []) if isinstance(o, dict))
    run = spec.get("run") or {}
    run_kind = run.get("kind","")
    entry = run.get("entry","") or run.get("code","")[:400]
    name = meta.get("name","") or os.path.splitext(os.path.basename(path))[0]
    desc = meta.get("description","")
    return toks(name, desc, inputs, outputs, organelles, run_kind, entry, lead_comment(text))

def py_signature(path: str) -> set[str]:
    try:
        text = open(path, encoding="utf-8", errors="ignore").read()
    except OSError:
        return set()
    name = os.path.splitext(os.path.basename(path))[0]
    decls = " ".join(DECL.findall(text)[:40])
    return toks(name, decls, lead_comment(text))

def cover(cand: set[str], sig: set[str]) -> tuple[float,int]:
    if not cand or not sig: return 0.0, 0
    inter = len(cand & sig)
    fwd = inter / len(cand)
    rev = inter / len(sig) if len(sig) >= 6 else 0.0
    return max(fwd, rev), inter

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--intent", default="")
    ap.add_argument("--content-file", default="")
    ap.add_argument("--content-stdin", action="store_true")
    ap.add_argument("--threshold", type=float, default=0.42)
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--top", type=int, default=5)
    args = ap.parse_args()
    content = ""
    if args.content_stdin:
        content = sys.stdin.read()
    elif args.content_file and os.path.exists(args.content_file):
        content = open(args.content_file, encoding="utf-8", errors="ignore").read()
    stem = os.path.splitext(os.path.basename(args.name))[0]
    ext = os.path.splitext(args.name)[1]
    # candidate tokens: name + intent + draft declarations/lead
    cand_decls = " ".join(DECL.findall(content)[:40]) if content else ""
    lead = lead_comment(content) if content else ""
    cand = toks(stem, args.intent, cand_decls, lead)
    # also parse draft yaml if it looks like a cell
    if content and yaml is not None and ("apiVersion" in content or "membrane" in content):
        try:
            d = yaml.safe_load(content) or {}
            if isinstance(d, dict):
                meta = d.get("metadata") or {}; spec = d.get("spec") or {}
                cand |= toks(meta.get("name",""), meta.get("description",""),
                             " ".join((spec.get("membrane",{}).get("inputs") or {}).keys()),
                             " ".join((spec.get("membrane",{}).get("outputs") or {}).keys()),
                             " ".join(o.get("cell","") for o in (spec.get("organelles") or []) if isinstance(o,dict)))
        except Exception:
            pass
    if not cand:
        print("[cell-steer] no distinctive tokens — nothing to compare."); return 3
    new_abs = os.path.abspath(os.path.join(args.repo, args.name)) if not os.path.isabs(args.name) else os.path.abspath(args.name)
    MIN_SHARED = 3
    STRONG_SHARED = 5
    is_yaml = ext in (".yaml",".yml") or args.name.endswith(".cell.yaml")
    # scan candidates: *.cell.yaml + neurons/*.py
    scored: list[tuple[float,int,str,set[str]]] = []
    for root, dirs, files in os.walk(args.repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIR]
        for fn in files:
            is_cell = fn.endswith(".cell.yaml")
            is_py = fn.endswith(".py") and not fn.startswith("test_")
            if not (is_cell or is_py):
                continue
            # cross-type: yaml candidate should primarily match yaml; py candidate -> py, but allow cross with lower weight
            if is_yaml and is_py and not fn.startswith("__"):
                # still scan py for shared wiring tokens, but don't over-score
                pass
            if not is_yaml and is_cell and cand and len(cand) < 6:
                # a py candidate with tiny tokens vs many cells would be noise — skip unless enough tokens
                continue
            p = os.path.join(root, fn)
            if os.path.abspath(p) == new_abs: continue
            if any(x in p for x in args.exclude): continue
            if ".pyc" in p or "node_modules" in p: continue
            sig = cell_signature(p) if is_cell else py_signature(p)
            s, inter = cover(cand, sig)
            if s > 0:
                scored.append((s, inter, os.path.relpath(p, args.repo), sig))
    def is_hit(s, inter): return inter >= STRONG_SHARED or (s >= args.threshold and inter >= MIN_SHARED)
    scored.sort(key=lambda r: (r[1], r[0]), reverse=True)
    hits = [r for r in scored if is_hit(r[0], r[1])]
    print(f"[cell-steer] candidate '{args.name}' :: {len(cand)} distinctive tokens ({', '.join(sorted(cand)[:8])}...)")
    if not scored:
        print("[cell-steer] no overlapping cell/neuron found — clear to build new."); return 3
    print("[cell-steer] nearest existing cells/neurons:")
    for s, inter, rel, sig in scored[: args.top]:
        flag = "  ◀── ALREADY DOES THIS" if is_hit(s, inter) else ""
        print(f"   cov {s:4.2f}  {inter} shared  {rel}{flag}")
    if hits:
        shared = sorted(cand & hits[0][3])[:10]
        print()
        print(f"[cell-steer] ⛔ STEER: capability already in: {', '.join(h[2] for h in hits[:3])}")
        print(f"[cell-steer]    top '{hits[0][2]}' shares {hits[0][1]} tokens: {', '.join(shared)}")
        print(f"[cell-steer]    REUSE it: wire as organelle `cell: ./{hits[0][2]}` or FIX it where it lives.")
        print(f"[cell-steer]    Forking a parallel copy is unwitnessed (no tests/callers).")
        return 0
    print("[cell-steer] ✅ above no threshold — building new is justified."); return 3

if __name__ == "__main__":
    sys.exit(main())
