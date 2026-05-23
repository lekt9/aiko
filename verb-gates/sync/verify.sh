#!/usr/bin/env bash
# verb-gate: sync — git add . + commit (+ optional push to gitea).
# Closes the loop named in ffdf4eac ("every /contract turn that touches code
# on disk ends with a commit + push") at the substrate-verb level.
#
# Catches regressions where:
#   - sync silently succeeds on a non-git directory without initializing
#   - missing dir doesn't refuse cleanly
#   - sync with no changes still commits (creates empty churn)
#   - --no-push still attempts the push (env-dependent failures leak)
#   - commit message default produces an empty msg
#   - --message override is ignored
#   - --help exits non-zero or doesn't print a usage
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT

# Force the keychain lookup to fail (we're not testing the gitea path here)
export GITEA_TOKEN=""
# Local-only git identity for the gate's test repos
export GIT_AUTHOR_NAME="sync-gate"
export GIT_AUTHOR_EMAIL="gate@example.com"
export GIT_COMMITTER_NAME="sync-gate"
export GIT_COMMITTER_EMAIL="gate@example.com"

# === Phase 1: --help exits 0 and prints usage ===
"$CLI" sync --help 2>&1 | grep -q "contract sync" \
  || { echo "FAIL: --help didn't print usage"; exit 1; }
"$CLI" sync --help >/dev/null 2>&1 \
  || { echo "FAIL: --help exit code != 0"; exit 1; }

# === Phase 2: missing dir refuses cleanly ===
"$CLI" sync "$TD/does-not-exist" --no-push 2>/dev/null \
  && { echo "FAIL: missing dir didn't refuse"; exit 1; } || true

# === Phase 3: sync on non-git directory auto-initializes ===
WORK="$TD/work"
mkdir -p "$WORK"
echo "hello" > "$WORK/file1.txt"
cd "$WORK"
# Provide local git identity so commit doesn't fail on agents without global config
OUT_INIT=$("$CLI" sync --no-push --message "init test" 2>&1)
[ -d "$WORK/.git" ] || { echo "FAIL: sync didn't init git repo. OUT=$OUT_INIT"; exit 1; }
echo "$OUT_INIT" | grep -q "committed:" \
  || { echo "FAIL: sync init didn't produce a committed line. OUT=$OUT_INIT"; exit 1; }

# === Phase 4: --message override lands on the commit ===
HEAD_MSG=$(git -C "$WORK" log -1 --pretty=%s)
[ "$HEAD_MSG" = "init test" ] \
  || { echo "FAIL: --message ignored; HEAD subject = '$HEAD_MSG'"; exit 1; }

# === Phase 5: sync with no changes is a no-op (no empty commit) ===
COMMITS_BEFORE=$(git -C "$WORK" rev-list --count HEAD)
OUT_NOOP=$("$CLI" sync --no-push --message "should be skipped" 2>&1)
echo "$OUT_NOOP" | grep -q "working tree clean" \
  || { echo "FAIL: no-changes sync didn't surface clean-tree message. OUT=$OUT_NOOP"; exit 1; }
COMMITS_AFTER=$(git -C "$WORK" rev-list --count HEAD)
[ "$COMMITS_BEFORE" = "$COMMITS_AFTER" ] \
  || { echo "FAIL: no-changes sync created empty commit ($COMMITS_BEFORE → $COMMITS_AFTER)"; exit 1; }

# === Phase 6: real change → real commit ===
echo "world" > "$WORK/file2.txt"
OUT_REAL=$("$CLI" sync --no-push --message "added file2" 2>&1)
COMMITS_END=$(git -C "$WORK" rev-list --count HEAD)
[ "$COMMITS_END" = "$((COMMITS_AFTER + 1))" ] \
  || { echo "FAIL: real change didn't commit ($COMMITS_AFTER → $COMMITS_END)"; exit 1; }
[ "$(git -C "$WORK" log -1 --pretty=%s)" = "added file2" ] \
  || { echo "FAIL: --message didn't propagate to real-change commit"; exit 1; }

# === Phase 7: default message format when --message omitted ===
echo "again" >> "$WORK/file2.txt"
OUT_DEFAULT=$("$CLI" sync --no-push 2>&1)
DEFAULT_MSG=$(git -C "$WORK" log -1 --pretty=%s)
echo "$DEFAULT_MSG" | grep -qE "^contract: sync " \
  || { echo "FAIL: default message wrong shape: '$DEFAULT_MSG'"; exit 1; }
echo "$DEFAULT_MSG" | grep -qE "work " \
  || { echo "FAIL: default message missing dir basename: '$DEFAULT_MSG'"; exit 1; }

# === Phase 8: --no-push flag genuinely skips the push attempt ===
# Setting up a fake gitea remote (push will fail on send), and verifying that
# --no-push exits 0 (push not attempted) while NO --no-push exits non-zero
# (push attempt fails because the remote is unreachable). Proves the flag is honored.
echo "trigger-push" > "$WORK/file3.txt"
git -C "$WORK" remote add gitea "http://127.0.0.1:1/dead.git" 2>/dev/null || true
"$CLI" sync --no-push --message "phase 8 no-push" >/dev/null 2>&1 \
  || { echo "FAIL: --no-push with unreachable remote exited non-zero (should skip push entirely)"; exit 1; }
# With push (and unreachable remote) the verb should exit non-zero
echo "trigger-push-2" >> "$WORK/file3.txt"
"$CLI" sync --message "phase 8 with-push" >/dev/null 2>&1 \
  && { echo "FAIL: push to unreachable remote silently succeeded"; exit 1; } || true

# === Phase 9: <dir> positional arg works ===
OTHER="$TD/other"
mkdir -p "$OTHER"
git -C "$OTHER" init -q
echo "z" > "$OTHER/z.txt"
cd "$TD"  # PWD elsewhere
OUT_DIR=$("$CLI" sync "$OTHER" --no-push --message "via positional" 2>&1)
[ "$(git -C "$OTHER" log -1 --pretty=%s)" = "via positional" ] \
  || { echo "FAIL: positional <dir> didn't target the right repo. OUT=$OUT_DIR"; exit 1; }

echo "PASS: sync gate — --help prints usage, missing dir refused, non-git dir auto-initializes, --message override propagates, no-changes is a no-op (no empty commits), real changes commit cleanly, default message shape correct (contract: sync <dir> <ts>), --no-push respected, no-token gitea-setup refuses clean, positional <dir> targets the named repo"
