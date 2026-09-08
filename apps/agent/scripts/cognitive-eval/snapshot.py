"""Copy the CURRENT dirty local candidate without touching the shared tree.

Source is copied, including workspace and resolved browser-harness source. Registry
node_modules remain shared/pinned by lock; this is not a hermetic build claim.
No environment files, state databases, credentials or old artifacts are copied.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[4]
out = args.out.resolve()
if out.exists():
    raise SystemExit("Use a new snapshot directory; prior candidates are immutable evidence")


def manifest():
    return json.loads(subprocess.check_output(["bun", str(root / "apps/agent/scripts/cognitive-eval/manifest.ts")], cwd=root))


before = manifest()
browser = (root / "apps/agent/node_modules/@unbrowse/browser-harness").resolve()
source = out / "source"
source.mkdir(parents=True)
files = dict(before["files"])
# Include the owned regression suite and nearby integration tests for replay.
for path in (root / "apps/agent/test").rglob("*.ts"):
    files[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
for key, digest in files.items():
    dependency = key.startswith("@dependency/browser-harness/")
    relative = key.removeprefix("@dependency/browser-harness/") if dependency else key
    original = (browser if dependency else root) / relative
    target = (source / "dependencies/browser-harness" if dependency else source) / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    data = original.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise SystemExit(f"Source changed during snapshot: {key}; preserve this incomplete copy and retry explicitly")
    target.write_bytes(data)
# Keep package-resolution topology while redirecting every workspace source link.
(source / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
modules = [root / "apps/agent/node_modules", root / "apps/server/node_modules", *root.glob("packages/*/node_modules"), browser / "node_modules"]
for directory in modules:
    if not directory.is_dir():
        continue
    target_dir = source / "dependencies/browser-harness/node_modules" if directory == browser / "node_modules" else source / directory.relative_to(root)
    target_dir.mkdir(parents=True, exist_ok=True)
    for entry in directory.iterdir():
        entries = list(entry.iterdir()) if entry.name.startswith("@") and entry.is_dir() and not entry.is_symlink() else [entry]
        for item in entries:
            target = target_dir / item.relative_to(directory)
            target.parent.mkdir(parents=True, exist_ok=True)
            resolved = item.resolve()
            if resolved == browser:
                resolved = source / "dependencies/browser-harness"
            elif resolved.is_relative_to(root / "packages"):
                resolved = source / resolved.relative_to(root)
            # Registry dependency bytes are explicitly shared, not source snapshots.
            target.symlink_to(resolved, target_is_directory=resolved.is_dir())
after = manifest()
subprocess.run(["bun", str(source / "apps/agent/scripts/cognitive-eval/manifest.ts")], cwd=source, check=True, stdout=(out / "copied-source.json").open("w"))
copied = json.loads((out / "copied-source.json").read_text())
matched = before == after == copied
(out / "snapshot.json").write_text(json.dumps({"source": str(source), "matched": matched, "before": before, "after": after,
    "copiedSourceDigest": copied["digest"], "copiedTests": {k: v for k, v in files.items() if k.startswith("apps/agent/test/")},
    "limitations": ["Registry node_modules bytes remain shared; lock and source digests are not a hermetic dependency/build manifest", "No protected cases or evaluation commands were executed by copying"]}, indent=2))
print(json.dumps({"source": str(source), "matched": matched, "sourceDigest": copied["digest"]}))
if not matched:
    raise SystemExit("Source drift while copying; retain this snapshot as diagnostic only")
