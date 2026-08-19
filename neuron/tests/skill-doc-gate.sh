#!/usr/bin/env bash
# Runnable witness for the SKILL.md binding — every package declares what it is
# supposed to do, and that declaration is part of what gets admitted.
#
# The convention already existed by hand: eight of thirteen limb packages
# carried a SKILL.md, none had frontmatter, and NONE was covered by the package
# digest. That last part is the whole problem. A description outside the digest
# can be edited to claim anything while the pin never moves, so admission goes
# on vouching for bytes the document no longer describes. Documentation that
# cannot be wrong is not documentation, it is decoration.
#
# Four assertions, and they catch different lies:
#
#   1. THE BINDING. Editing ONLY the prose body of SKILL.md — not the
#      frontmatter, not a line of code — must change the package digest. This
#      is the falsifier: delete the SKILL_DOC entry from the allowlist in
#      `computePackageDigest` and this assertion must go red. If it still
#      passes, the document is not bound to the package and every other
#      assertion here is theatre.
#
#   2. A package that cannot say what it is for is REFUSED. Not warned about —
#      refused, before the digest is even computed, because admitting it would
#      vouch for code on the strength of its compiling.
#
#   3. An acceptance-free declaration is refused as UNFALSIFIABLE. This is the
#      rule `morphogenesis.CapabilityGap.parse` already applies to a transient
#      gap ("anything returning bytes would satisfy it"), carried onto the
#      durable package. A SKILL.md with an empty `expect_contains` states
#      nothing that could turn out to be false.
#
#   4. The declared intent reaches the LEDGER. A reader must be able to ask
#      what a package claimed at the moment it was pinned, without re-reading a
#      file that may have been edited since.
#
# Assertion 1 is what makes 2-4 worth anything. Without it the harness could
# read SKILL.md, enforce every rule, record the intent — and still let the
# document drift away from the code the next time someone edited it.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root_repo="$(cd "$repo/.." && pwd)"
aiko="$root_repo/zig-out/bin/aiko"
[ -x "$aiko" ] || { echo "FAIL: build first (zig build)"; exit 1; }

root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-skilldoc.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

export HOME="$root"
mkdir -p "$root/.contracts"
"$aiko" agent init "$root/n" a1 >/dev/null
state="$root/n/state"

pkg="$root/pkg"
mkdir -p "$pkg"
cat > "$pkg/neuron.json" <<'JSON'
{
  "schema": "typed-neuron.limb-manifest/v1",
  "package": "typed-neuron/skill-doc-probe",
  "version": "0.1.0",
  "description": "Fixture package for the SKILL.md binding gate.",
  "neurons": [
    { "id": "probe", "argv": ["python3", "neurons/probe.py"] }
  ]
}
JSON

write_doc() {  # write_doc <expect_contains> <body-text> [grounding]
    cat > "$pkg/SKILL.md" <<EOF
---
name: typed-neuron/skill-doc-probe
description: Fixture limb used by the SKILL.md binding gate. Fires on a probe stimulus.
probe_input: hello
expect_contains: $1
grounding: ${3-neuron/AGENTS.md#30}
---

# skill-doc-probe

$2
EOF
}

# --- 1. THE FALSIFIER: prose is inside the pin ----------------------------
# Extract the digest as the 64-hex token, NOT by slicing the tail of the line.
# On a repeat admission the CLI prefixes "(already admitted) ", and a slice
# picks up a stray ')' — which made an earlier version of this gate compare
# ")abc…" against "abc…" and report a difference that was punctuation rather
# than a changed pin. That version passed against a mutant with the feature
# removed. Parse the token.
digest_of() { "$aiko" limb admit "$1" "$2" 2>/dev/null | grep -oE '[0-9a-f]{64}' | tail -1; }

write_doc "probe-ack" "First body."
d1="$(digest_of "$pkg" "$state")"
[ ${#d1} -eq 64 ] || fail "a well-formed package did not admit cleanly; got: '$d1'"

# Change ONLY the prose body. Frontmatter identical, manifest identical, no
# code touched anywhere.
write_doc "probe-ack" "Second body — same declaration, different prose."
d2="$(digest_of "$pkg" "$state")"
[ ${#d2} -eq 64 ] || fail "second admission produced no digest; got: '$d2'"

[ "$d1" != "$d2" ] || fail "editing SKILL.md did NOT change the package digest ($d1) — the document is not bound to the package, so prose and code are free to drift"
echo "  prose is inside the pin: $(echo "$d1" | cut -c1-12)… -> $(echo "$d2" | cut -c1-12)…"

# --- 2. no declaration -> refused -----------------------------------------
rm -f "$pkg/SKILL.md"
if err="$("$aiko" limb admit "$pkg" "$state" 2>&1 >/dev/null)"; then
    fail "a package with NO SKILL.md was admitted — it never said what it was for"
fi
case "$err" in
    *SkillDocMissing*) echo "  undeclared package refused: SkillDocMissing" ;;
    *) fail "refused, but not for the stated reason: $err" ;;
esac

# --- 3. acceptance-free -> refused as unfalsifiable ------------------------
write_doc "" "A declaration that asserts nothing."
if err="$("$aiko" limb admit "$pkg" "$state" 2>&1 >/dev/null)"; then
    fail "a package declaring NO acceptance was admitted — nothing about it could turn out to be false"
fi
case "$err" in
    *SkillDocUnfalsifiable*) echo "  acceptance-free declaration refused: SkillDocUnfalsifiable" ;;
    *) fail "refused, but not as unfalsifiable: $err" ;;
esac

# --- 4. the declared intent reaches the ledger -----------------------------
write_doc "probe-ack-4" "Body for the ledger assertion."
"$aiko" limb admit "$pkg" "$state" >/dev/null 2>&1 || fail "re-admission failed"

# The admission record rides the journal as a hex-encoded artifact payload, so
# this decodes rather than greps: a substring search over the raw log would
# pass on a coincidence and fail on a correct record.
python3 - "$state/substrate.log" <<'PY' || exit 1
import json, sys

# The ledger is append-only and this gate admits several times, so take the
# LATEST admission record rather than the first — the earlier rows are the
# fixtures from assertions 1-3 and are supposed to still be there.
want = "probe-ack-4"
records = []
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line or "limb-admission" not in line:
        continue
    row = json.loads(line)
    for art in row.get("artifacts", []):
        if art.get("schema") == "neuron.limb-admission/v1":
            records.append(json.loads(bytes.fromhex(art["bytes"]).decode("utf-8")))

if not records:
    print("FAIL: no admission record found in the journal")
    sys.exit(1)

skill = records[-1].get("skill")
if not skill:
    print("FAIL: the admission record carries no declared intent at all")
    sys.exit(1)
if skill.get("expect_contains") != want:
    print("FAIL: ledger recorded acceptance %r, expected %r"
          % (skill.get("expect_contains"), want))
    sys.exit(1)
print("  declared acceptance is durable in the ledger: %r" % skill["expect_contains"])
PY

# --- 6. a package with NO grounding is refused -----------------------------
# `expect_contains` says what the package claims. `grounding` says where the
# claim came from. Without it a package has no provenance to re-check when the
# doctrine it was built against moves, so drift is silent by construction.
write_doc "probe-ack-6" "Body for the grounding assertion." " "
if "$aiko" limb admit "$pkg" "$state" >/dev/null 2>&1; then
    fail "a package declaring NO grounding was admitted — its claim has no provenance to re-check"
fi
err=$("$aiko" limb admit "$pkg" "$state" 2>&1 || true)
case "$err" in
    *Ungrounded*|*ungrounded*) : ;;
    *) fail "refused, but not as ungrounded: $err" ;;
esac

# --- 7. EVERY shipped limb's grounding RESOLVES ----------------------------
# This is what stops the field being decoration. A citation is only worth
# something if it can be wrong: delete the file it names, or renumber the
# section, and this goes red. That is the same rot `zig-doctrine-gate.sh`
# catches in prose about the language, pointed at prose about provenance.
python3 - "$repo" <<'PYEOF' || fail "a shipped limb cites grounding that does not resolve"
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
bad, n = [], 0
for doc in sorted((root / "limbs").glob("*/SKILL.md")):
    n += 1
    m = re.search(r"^grounding:\s*(.+)$", doc.read_text(encoding="utf-8"), re.M)
    if not m or not m.group(1).strip():
        bad.append(f"{doc.parent.name}: no grounding"); continue
    for entry in (e.strip() for e in m.group(1).split(",")):
        if entry.startswith("skill:"):
            continue  # a named external skill; not resolvable from this tree
        path, _, section = entry.partition("#")
        target = root.parent / path
        if not target.is_file():
            bad.append(f"{doc.parent.name}: cites missing file {path}")
        elif section and not re.search(r"^#+\s*" + re.escape(section) + r"[.\s]",
                                       target.read_text(encoding="utf-8"), re.M):
            bad.append(f"{doc.parent.name}: cites unresolved section {entry}")
assert n, "no limb SKILL.md files discovered — the check found nothing to check"
if bad:
    print("\n".join("  " + b for b in bad)); sys.exit(1)
print(f"  every citation in {n} limb SKILL.md files resolves")
PYEOF

# --- 5. the pin covers EVERY file, not a curated list ----------------------
# An adversarial audit found that the digest hashed an allowlist — neuron.json,
# argv-named paths, SKILL.md, schemas/ — so a module the entrypoint IMPORTS but
# argv never names sat outside the pin. Its bytes could be replaced wholesale
# and admission went on vouching for code it had never seen. Assert the hole is
# closed using exactly that shape: a helper nothing references by name.
mkdir -p "$pkg/neurons"
echo 'import helper' > "$pkg/neurons/main.py"
echo 'SECRET = "benign"' > "$pkg/neurons/helper.py"
write_doc "probe-ack-5" "Body for the coverage assertion."
h1="$(digest_of "$pkg" "$state")"
echo 'SECRET = "replaced wholesale"' > "$pkg/neurons/helper.py"
h2="$(digest_of "$pkg" "$state")"
[ "$h1" != "$h2" ] || fail "an imported module that argv never names is OUTSIDE the pin ($h1) — admission would vouch for code it never saw"
echo "  the pin covers a module referenced only by an import"

echo "skill-doc gate: PASS"
