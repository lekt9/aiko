#!/usr/bin/env python3
"""
contract-import-extract.py - surface past patterns as candidate contracts.

Reads existing pattern sources and SURFACES each as a candidate contract.
It NEVER declares: import surfaces, the agent judges and runs `contract
declare` for the keepers. This is how accumulated know-how survives a
massive architectural refactor: convert the patterns into contracts in the
durable ~/.contracts ledger BEFORE the source files move or vanish.

Recognised sources:
  - .jsonl / .json  a principle store or an old contract ledger. Each
                    declared / proposal / rule row becomes one candidate,
                    carrying its own action verbatim when it has one.
  - .md / .txt      a canon or doc file. The file becomes one candidate
                    (its title plus first prose line as the plan,
                    action agent-judges, the agent reads the file to judge).
  - a directory     every recognised file beneath it.

--archive copies the source into ~/.contracts/imported/<ts>-<stem>/ so the
pattern CONTENT survives even when the refactor deletes the original; the
emitted declare commands then point at the durable vault copy.

Substrate-faithful: this script extracts what the source structurally
declares and surfaces it. It does not classify, rewrite, or invent an
action. The agent renders every verdict and runs every declare.
"""
import argparse, json, os, re, shlex, shutil, sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

THRESHOLD = 0.55
EVENT_KEYS = {"iterated", "satisfied", "child_added", "spawned", "status_update"}
DOC_SUFFIXES = {".md", ".markdown", ".txt"}
JSONL_SUFFIXES = {".jsonl", ".json", ".ndjson"}


def _resolve_ledger() -> Path:
    if env := os.environ.get("CONTRACTS_STORE"):
        return Path(env)
    pd = Path.cwd() / ".claude"
    if pd.is_dir():
        return pd / "contracts.jsonl"
    return Path.home() / ".contracts" / "contracts.jsonl"


LEDGER = _resolve_ledger()
VAULT = LEDGER.parent / "imported"


def _tok(t: str) -> Counter:
    return Counter(re.findall(r"[a-z0-9]+", (t or "").lower()))


def _overlap(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    shared = sum((a & b).values())
    denom = min(sum(a.values()), sum(b.values()))
    return shared / denom if denom else 0.0


def existing_contracts() -> list:
    if not LEDGER.exists():
        return []
    out = []
    for ln in LEDGER.read_text(errors="replace").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            r = json.loads(ln)
        except json.JSONDecodeError as e:
            print(f"contract import: WARNING {LEDGER} has a corrupt line, "
                  f"skipped: {e}", file=sys.stderr)
            continue
        if r.get("event") == "declared" and r.get("plan"):
            out.append((r.get("id", "?"), r["plan"]))
    return out


def extract_jsonl(path: Path) -> list:
    """Each non-event row that carries a declared truth claim becomes a unit."""
    units = []
    for i, ln in enumerate(path.read_text(errors="replace").splitlines()):
        ln = ln.strip()
        if not ln:
            continue
        try:
            r = json.loads(ln)
        except json.JSONDecodeError as e:
            print(f"contract import: WARNING {path} line {i + 1} is not "
                  f"valid JSON and was skipped: {e}", file=sys.stderr)
            continue
        if r.get("event") in EVENT_KEYS:
            continue
        plan = action = oid = ""
        if r.get("event") == "declared" and r.get("plan"):          # contract ledger row
            plan, action, oid = r["plan"], r.get("action") or "", r.get("id", "")
        elif r.get("proposal"):                                      # meta-harness principle store
            plan, action, oid = r["proposal"], r.get("action") or "", r.get("id", "")
        elif r.get("plan") or r.get("rule") or r.get("principle"):   # generic principle row
            plan = r.get("plan") or r.get("rule") or r.get("principle")
            action, oid = r.get("action") or "", r.get("id", "")
        else:
            continue
        plan = " ".join(str(plan).split())
        if not plan:
            continue
        action = str(action).strip() or "agent-judges"
        units.append({
            "plan": plan,
            "action": action,
            "origin": f"{path.name}#{oid}" if oid else f"{path.name}#L{i + 1}",
            "src_file": path,
            "marker": str(r.get("state") or r.get("status") or ""),
        })
    return units


def extract_doc(path: Path) -> list:
    """A doc file becomes one candidate: its title and first prose line."""
    text = path.read_text(errors="replace")
    lines = text.splitlines()
    title = ""
    for ln in lines:
        m = re.match(r"#\s+(.+)", ln.strip())
        if m:
            title = m.group(1).strip()
            break
    if not title:
        title = path.stem.replace("-", " ").replace("_", " ").strip()
    summary = ""
    for ln in lines:
        s = ln.strip()
        if not s or s.startswith(("#", "---", "|", "```", ">")):
            continue
        if re.match(r"(source|status|metadata|name|description)\s*:", s, re.I):
            continue
        summary = s
        break
    plan = title if not summary else f"{title}: {summary}"
    plan = " ".join(plan.split())[:280]
    marker = "LOAD-BEARING" if "LOAD-BEARING" in text[:800].upper() else ""
    return [{
        "plan": plan,
        "action": "agent-judges",
        "origin": path.name,
        "src_file": path,
        "marker": marker,
    }]


def collect(source: Path) -> list:
    units = []
    if source.is_file():
        sfx = source.suffix.lower()
        if sfx in JSONL_SUFFIXES:
            units += extract_jsonl(source)
        elif sfx in DOC_SUFFIXES:
            units += extract_doc(source)
        else:
            print(f"  (skip: unrecognised file type {sfx or '<none>'}: {source})", file=sys.stderr)
    elif source.is_dir():
        for p in sorted(source.rglob("*")):
            if not p.is_file():
                continue
            sfx = p.suffix.lower()
            if sfx in JSONL_SUFFIXES:
                units += extract_jsonl(p)
            elif sfx in DOC_SUFFIXES:
                units += extract_doc(p)
    return units


def archive(source: Path) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = VAULT / f"{ts}-{source.stem or source.name}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, dest)
    else:
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest / source.name)
    return dest


def main():
    ap = argparse.ArgumentParser(
        description="Surface past patterns as candidate contracts. Never declares.")
    ap.add_argument("source", help="file or directory of past patterns")
    ap.add_argument("--threshold", type=float, default=THRESHOLD,
                    help="overlap score above which a pattern is flagged as already covered")
    ap.add_argument("--commands", action="store_true",
                    help="emit only the contract declare lines (review, then pipe to bash)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--archive", action="store_true",
                    help="copy the source into ~/.contracts/imported/ so content survives the refactor")
    args = ap.parse_args()

    source = Path(args.source).expanduser()
    if not source.exists():
        print(f"ERROR: source not found: {source}", file=sys.stderr)
        sys.exit(2)

    vault_root = archive(source) if args.archive else None
    units = collect(source)
    if not units:
        print(f"  (no recognised patterns in {source})")
        return

    existing = existing_contracts()
    for u in units:
        ut = _tok(u["plan"])
        best_id, best_score = "", 0.0
        for cid, plan in existing:
            sc = _overlap(ut, _tok(plan))
            if sc > best_score:
                best_id, best_score = cid, sc
        u["dup"] = (best_id, round(best_score, 2)) if best_score >= args.threshold else None
        if vault_root is not None:
            sf = u["src_file"]
            if source.is_dir():
                try:
                    rel = sf.relative_to(source)
                except ValueError:
                    rel = Path(sf.name)
                ptr = vault_root / rel
            else:
                ptr = vault_root / source.name
            anchor = u["origin"].split("#", 1)[1] if "#" in u["origin"] else ""
            u["pointer"] = f"import:{ptr}" + (f"#{anchor}" if anchor else "")
        else:
            u["pointer"] = f"import:{u['origin']}"

    def declare_cmd(u: dict) -> str:
        return (f"contract declare {shlex.quote(u['plan'])} "
                f"--action {shlex.quote(u['action'])} "
                f"--pointer-to {shlex.quote(u['pointer'])}")

    new = [u for u in units if not u["dup"]]
    dup = [u for u in units if u["dup"]]

    if args.json:
        print(json.dumps({
            "source": str(source),
            "vault": str(vault_root) if vault_root else None,
            "total": len(units), "new": len(new), "overlap": len(dup),
            "units": [{
                "plan": u["plan"], "action": u["action"], "origin": u["origin"],
                "marker": u["marker"], "pointer": u["pointer"],
                "src_file": str(u["src_file"]),
                "overlap": u["dup"], "declare": declare_cmd(u),
            } for u in units],
        }, indent=2))
        return

    if args.commands:
        for u in new:
            print(declare_cmd(u))
        return

    print(f"=== CONTRACT IMPORT: {source} ===")
    if vault_root:
        print(f"  archived to: {vault_root}  (content now survives the refactor)")
    print(f"  {len(units)} pattern(s) found  |  {len(new)} new  |  "
          f"{len(dup)} overlap an existing contract")
    print()
    print("  import SURFACES candidates only. YOU judge each one and run")
    print("  `contract declare` for the keepers. Nothing is written to the ledger here.")
    print()

    CAP = 40
    for n, u in enumerate(new[:CAP], 1):
        shape = "cell" if u["action"] != "agent-judges" else "judgment"
        mark = f"  [{u['marker']}]" if u["marker"] else ""
        print(f"  [{n}] ({shape}){mark}")
        print(f"      plan:   {u['plan'][:140]}")
        print(f"      action: {u['action'][:100]}")
        print(f"      origin: {u['origin']}")
        print(f"      -> {declare_cmd(u)}")
        print()
    if len(new) > CAP:
        print(f"  ... {len(new) - CAP} more new candidate(s). Use --commands for all, or --json.")
        print()

    if dup:
        print(f"  {len(dup)} pattern(s) already overlap an existing contract "
              f"(reuse, do not re-declare):")
        for u in dup[:12]:
            print(f"    ~ {u['plan'][:78]}  (matches {u['dup'][0]}, score {u['dup'][1]})")
        if len(dup) > 12:
            print(f"    ... {len(dup) - 12} more.")
        print()

    print("  Next: review the candidates, then run the `contract declare` lines for the")
    print("  keepers. For a source you trust as a whole (an already-applied principle")
    print("  store), judge the store, then: contract import <source> --commands | bash")


if __name__ == "__main__":
    main()
