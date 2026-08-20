#!/usr/bin/env bash
# Prove public docs match the published monorepo and are safe to ship.
# Exit 0 only when the claims below hold in the tree. Do not pass on prose.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

need_file() {
  [[ -f "$1" ]] || fail "missing $1"
  ok "exists $1"
}

need_grep() {
  local file=$1 pattern=$2
  rg -q -- "$pattern" "$file" || fail "$file missing /$pattern/"
  ok "$file has /$pattern/"
}

forbid_grep() {
  local file=$1 pattern=$2
  if rg -q -- "$pattern" "$file"; then
    fail "$file still contains /$pattern/"
  fi
  ok "$file free of /$pattern/"
}

need_file LICENSE
need_file NOTICE
need_file CONTRIBUTING.md
need_file SECURITY.md
need_file CODE_OF_CONDUCT.md
need_file README.md
need_file docs/SOURCE-OF-TRUTH.md
need_file docs/README.md
need_file contract/NEVER-PUBLISH.md
need_file .gitmodules

need_grep LICENSE 'Apache License'
need_grep NOTICE 'SpaceXAI'
need_grep README.md 'github.com/lekt9/aiko'
need_grep README.md 'zig build'
need_grep README.md 'Aiko'
need_grep docs/SOURCE-OF-TRUTH.md 'github.com/lekt9/aiko'
need_grep docs/SOURCE-OF-TRUTH.md 'neuron/'
need_grep docs/SOURCE-OF-TRUTH.md 'contract/'
need_grep CLAUDE.md 'docs/SOURCE-OF-TRUTH.md'
need_grep SECURITY.md 'lekt9/aiko/security'
need_grep docs/SOURCE-OF-TRUTH.md 'aiko-flow/'
need_grep docs/SOURCE-OF-TRUTH.md 'MIT-licensed source'
need_grep docs/SOURCE-OF-TRUTH.md 'private: true'
need_grep contract/NEVER-PUBLISH.md 'lives in the published Aiko monorepo'
forbid_grep CLAUDE.md 'contract/NEVER-PUBLISH\.md.*closed-source|subtree is closed-source'

# Publication claims must follow the tracked tree, not an old checkout layout.
git ls-files --error-unmatch aiko-flow/package.json >/dev/null 2>&1 \
  || fail "tracked aiko-flow/package.json is missing from the publication tree"
ok "aiko-flow is tracked in the monorepo"

python3 - <<'PY'
import json
import re
import subprocess
from pathlib import Path

root = Path.cwd()
source = (root / "docs/SOURCE-OF-TRUTH.md").read_text()
fde = (root / "docs/AI-FORWARD-DEPLOYED-ENGINEER.md").read_text()
readme = (root / "README.md").read_text()
claude = (root / "CLAUDE.md").read_text()

package = json.loads((root / "aiko-flow/package.json").read_text())
if package.get("license") != "MIT" or package.get("private") is not True:
    raise SystemExit("FAIL: aiko-flow root must remain MIT with private:true package protection")
if not (root / "aiko-flow/LICENSE").read_text().startswith("MIT License"):
    raise SystemExit("FAIL: aiko-flow/LICENSE is not MIT")

obsolete = (
    "local unpublished checkout",
    "local unpublished authoring/control surface",
    "Publishing `aiko-flow/` (Smithers checkout)",
)
combined = "\n".join((source, fde, readme, claude))
for phrase in obsolete:
    if phrase in combined:
        raise SystemExit(f"FAIL: obsolete aiko-flow publication claim remains: {phrase}")
if "subtree is closed-source" in combined:
    raise SystemExit("FAIL: obsolete closed-source Contract claim remains")
for stale_inventory in ("15 witnesses + 12 limb suites", "+ 12 limb conformance suites"):
    if stale_inventory in combined:
        raise SystemExit(f"FAIL: obsolete root acceptance inventory remains: {stale_inventory}")

# Every gitlink needs exactly one .gitmodules path, and every mapping must name a gitlink.
raw = subprocess.check_output(["git", "ls-files", "-s"], text=True)
gitlinks = {
    line.split("\t", 1)[1]
    for line in raw.splitlines()
    if line.startswith("160000 ")
}
config = subprocess.check_output(
    ["git", "config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"],
    text=True,
)
mappings = {}
for line in config.splitlines():
    key, path = line.split(None, 1)
    if path in mappings:
        raise SystemExit(f"FAIL: duplicate .gitmodules mapping for {path}")
    mappings[path] = key.rsplit(".path", 1)[0]
if set(mappings) != gitlinks:
    raise SystemExit(
        f"FAIL: gitlink/.gitmodules mismatch: gitlinks={sorted(gitlinks)} mappings={sorted(mappings)}"
    )
frontend = mappings.get("aiko/apps/frontend")
if frontend is None:
    raise SystemExit("FAIL: aiko/apps/frontend gitlink has no mapping")
url = subprocess.check_output(
    ["git", "config", "-f", ".gitmodules", "--get", frontend + ".url"], text=True
).strip()
if url != "https://github.com/Simpleyyt/ai-manus.git":
    raise SystemExit(f"FAIL: unexpected aiko/apps/frontend upstream: {url}")

# Extract the runnable shell gates from build.zig itself. Documentation inventories
# are compared as sets so adding, removing, or renaming a root witness cannot drift.
build = (root / "build.zig").read_text()
actual = set(re.findall(r'"((?:neuron/)?tests/[^"\n]*-gate\.sh)"', build))
if not actual:
    raise SystemExit("FAIL: could not derive root gate inventory from build.zig")
for witness in actual:
    if not (root / witness).is_file():
        raise SystemExit(f"FAIL: build.zig names missing witness {witness}")

def inventory(text: str, document: str) -> set[str]:
    match = re.search(
        r"<!-- root-gate-inventory:start -->(.*?)<!-- root-gate-inventory:end -->",
        text,
        re.S,
    )
    if not match:
        raise SystemExit(f"FAIL: {document} lacks root gate inventory markers")
    return set(re.findall(r"^- `([^`]+-gate\.sh)`$", match.group(1), re.M))

for document, text in (("README.md", readme), ("CLAUDE.md", claude)):
    claimed = inventory(text, document)
    if claimed != actual:
        raise SystemExit(
            f"FAIL: {document} root gate inventory contradicts build.zig: "
            f"missing={sorted(actual - claimed)} extra={sorted(claimed - actual)}"
        )
print(f"ok: publication tree, {len(gitlinks)} gitlink mapping, and {len(actual)} root gates agree")

# Product-oneshot spreadsheet defaults must not replace the FDE document
# with a seat roster / Company OS Worker. That substitution already shipped
# once; this block is the refusal that catches it coming back.
if (root / "aiko/plugins/aiko-company").exists():
    raise SystemExit(
        "FAIL: aiko/plugins/aiko-company is a product-oneshot roster, not the FDE"
    )
if "aiko-company.lewis-6d8.workers.dev" in combined:
    raise SystemExit("FAIL: torn-down Company OS URL is still claimed")
if "Company OS operator roster" in combined:
    raise SystemExit("FAIL: Company OS roster is claimed as an FDE surface")
if "not a product-oneshot" not in fde:
    raise SystemExit("FAIL: FDE lost the product-oneshot refusal")
print("ok: FDE is not a product-oneshot seat roster")
PY

forbid_grep README.md 'gitea:Unbrowse/commons'
forbid_grep README.md '100\.124\.140\.92'
forbid_grep aiko/README.md '100\.124\.140\.92'
forbid_grep aiko/README.md 'gateway\.codegraff\.com'
forbid_grep aiko/SECURITY.md 'hackerone.com/x'
forbid_grep contract/README.md '100\.67\.11\.99'
forbid_grep contract/README.md 'gitea:Unbrowse/contract.git'
forbid_grep neuron/bench/agentic-organism/README.md '/Users/lewis/'

if [[ -e cell/data/hoysan-cto-lashing-context.md ]]; then
  fail "customer operational file cell/data/hoysan-cto-lashing-context.md is present"
fi
ok "no tracked hoysan operational context file"

# Public first-party docs must not carry private operator hosts or key-shaped tokens.
# Scope is the published product surfaces, not vendor/submodule trees.
SURFACES=(
  README.md
  CLAUDE.md
  CONTRIBUTING.md
  SECURITY.md
  docs/README.md
  docs/SOURCE-OF-TRUTH.md
  aiko/README.md
  aiko/CONTRIBUTING.md
  aiko/SECURITY.md
  contract/README.md
  neuron/README.md
  cell/README.md
)
for f in "${SURFACES[@]}"; do
  if rg -q -- 'BEGIN (RSA |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}' "$f"; then
    fail "$f looks like it contains a secret"
  fi
done
ok "public surfaces free of key-shaped secrets"

echo
echo "docs-oss-ready-gate: PASS"
