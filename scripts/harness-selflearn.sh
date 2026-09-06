#!/usr/bin/env bash
# harness-selflearn.sh — close the loop: mine .graff logs for what went wrong,
# hand the lessons to a graff agent, let it fix the harness, verify, and PR.
#
# Usage:
#   bash scripts/harness-selflearn.sh                 # full loop, opens a PR
#   SELFLEARN_DRY_RUN=1 bash scripts/harness-selflearn.sh   # mine + report only
#   SELFLEARN_NO_PR=1 bash scripts/harness-selflearn.sh     # fix + verify, no PR
#
# Environment:
#   SELFLEARN_DRY_RUN=1        stop after the mining report
#   SELFLEARN_NO_PR=1          stop after commit (no push, no PR)
#   SELFLEARN_BASE=<branch>    PR base branch (default: current branch)
#   SELFLEARN_CHECK="..."      verification commands (default "typecheck test:aiko")
#   SELFLEARN_SKIP_INSTALL=1   skip pnpm install in the worktree
#   SELFLEARN_TIMEOUT_S=2400   wall-clock budget for the graff fixer agent
#   SELFLEARN_MAX_MODEL_CALLS=80  model-call budget for the graff fixer agent
#   GRAFF_BIN=graff            graff binary to invoke
#   GRAFF_LEARN_MODEL=<name>   pin the fixer agent's model (default: graff default)

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ROOT="$PWD"

GRAFF_BIN="${GRAFF_BIN:-graff}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BRANCH="harness-learn/${STAMP}"
BASE="${SELFLEARN_BASE:-$(git rev-parse --abbrev-ref HEAD)}"
WORKTREE="$(dirname "$PWD")/$(basename "$PWD")-harness-learn-${STAMP}"
OUT="artifacts/harness-learn"
TIMEOUT_S="${SELFLEARN_TIMEOUT_S:-2400}"
MAX_MODEL_CALLS="${SELFLEARN_MAX_MODEL_CALLS:-80}"
CHECK_CMDS=(${SELFLEARN_CHECK:-typecheck test:aiko})
MODEL_ARGS=()
[ -n "${GRAFF_LEARN_MODEL:-}" ] && MODEL_ARGS=(--model "$GRAFF_LEARN_MODEL")

cleanup() {
  if [ -d "$WORKTREE" ]; then
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() { echo "harness-selflearn: $*" >&2; exit 1; }

# ---------- 0. preflight ----------
command -v git >/dev/null || fail "git not found"
command -v "$GRAFF_BIN" >/dev/null || fail "graff not found (set GRAFF_BIN)"
git diff --quiet --diff-filter=U || fail "unresolved merge conflicts"
if [ "$BASE" = "HEAD" ]; then
  fail "detached HEAD — set SELFLEARN_BASE=<branch>"
fi

echo "== harness self-learn ${STAMP} (base: ${BASE}) =="

# ---------- 1. mine ----------
echo "-- mining agent logs --"
MINE_OUT="$(node scripts/harness-learn.mjs)"
echo "$MINE_OUT"
NEW_LESSONS="$(sed -n 's/^NEW_LESSONS=//p' <<<"$MINE_OUT")"
LESSONS_JSON="$(sed -n 's/^LESSONS_FILE=//p' <<<"$MINE_OUT")"
LESSONS_MD="$(sed -n 's/^LESSONS_MD=//p' <<<"$MINE_OUT")"

if [ "${SELFLEARN_DRY_RUN:-0}" = "1" ]; then
  echo "dry run: lessons report written, stopping before the fixer agent."
  exit 0
fi
[ "${NEW_LESSONS:-0}" -gt 0 ] || { echo "no new lessons — nothing to learn."; exit 0; }
[ -n "$LESSONS_JSON" ] || fail "miner did not report a lessons file"

# ---------- 2. isolate ----------
echo "-- creating worktree ${WORKTREE} (branch ${BRANCH}) --"
[ -e "$WORKTREE" ] && fail "worktree path already exists: ${WORKTREE}"
git worktree add -b "$BRANCH" "$WORKTREE" "$BASE" >/dev/null || fail "worktree add failed"

mkdir -p "${WORKTREE}/${OUT}"
cp "$LESSONS_JSON" "${WORKTREE}/${OUT}/lessons-current.json"
cp "$LESSONS_MD" "${WORKTREE}/${OUT}/lessons-current.md"

# ---------- 3. dependencies ----------
if [ "${SELFLEARN_SKIP_INSTALL:-0}" != "1" ]; then
  echo "-- installing dependencies in worktree --"
  (cd "$WORKTREE" && pnpm install --frozen-lockfile >/dev/null 2>&1) \
    || fail "pnpm install failed in worktree (set SELFLEARN_SKIP_INSTALL=1 to bypass)"
fi

# ---------- 4. fixer agent ----------
# Freeze the live checkout: any change here while the agent runs (the agent
# editing its own orchestrator, or a peer session) means a moving tree — abort.
MAIN_FREEZE="$(git status --porcelain | sha1sum | cut -d' ' -f1)"

REPORT="docs/harness-learn/${STAMP}.md"
GUARDRAILS="Autonomy guardrails (hard requirements):
- No user is available; do not ask questions, decide and act.
- You may modify only: apps/**, packages/**, tests/**, docs/**, scripts/**.
- Never read or modify: .graff/**, artifacts/**, .env*, *.key, *.pem, *.sqlite*, codedb.snapshot, any *.session.json. If a file contains credentials, stop touching it and say so.
- Do not run git commit, git push, or git branch; the orchestrator owns version control.
- Stay inside your worktree: do not cd to or modify any absolute path outside it. In particular never modify scripts/harness-selflearn.sh or scripts/harness-learn.mjs — they are the running loop infrastructure, and editing a running shell script corrupts it.
- Keep the diff minimal: no drive-by refactors, no dependency changes, no formatting-only churn.

Tool-usage recovery notes — these exact failure patterns recurred in past runs; do not repeat them:
- read_file: pass a non-empty literal \`contains\` string, and never combine \`contains\` with start_line, end_line or compact (use the line range alone for a sized window).
- After a failed edit_file span in a batched call, earlier spans may already have applied: re-read the file and re-derive the remaining spans instead of retrying blindly.
- If the same tool call fails twice, change the arguments or the approach; an identical repeat fails identically. Check the error text for the recovery hint it already gives.
- Do not shell out to cat/grep for source (the codedb guard blocks them); use the codedb tool.
- Before finishing, complete or explicitly cancel every open todo item and re-run the self-check commands."

PROMPT="You are the harness-fixer agent for this repository (the Aiko/Unbrowse monorepo). A self-learning loop mined this repo's .graff agent logs and found recurring failure patterns. Your mission: make the harness stop repeating them.

Read the lessons report at artifacts/harness-learn/lessons-current.json (human summary: artifacts/harness-learn/lessons-current.md). Its lessons have kind (tool_error | retry_loop | harness_retry | stuck_todo | turn_stall), tool, count, runs, and verbatim (redacted) evidence excerpts. Entries with \"new\": false are already fixed elsewhere — ignore them.

Work the NEW lessons in priority order (highest count first):
1. Diagnose the root cause in this repo's agent harness under apps/agent/ (actor.ts instruction strings such as AIKO_*_INSTRUCTIONS, tool wrappers, capability-builder, channel-response, tool-router-tools, automations). Distinguish a real harness gap from one-off operator error; lessons that are not harness-fixable are recorded as skipped in the report with the reason.
2. Implement the smallest change that prevents recurrence: sharpen an instruction clause, add tool input validation or a clearer tool error message, or improve recovery guidance. Prefer instruction and validation fixes over new machinery.
3. When the fix is code (not only instruction text), add or extend a test under apps/agent/test/ or tests/.
4. Write the report ${REPORT} with sections: Lessons addressed (fingerprint -> decision), Root cause, Changes, Deliberately not done. Quote the evidence you acted on.
5. Self-check before finishing: run: pnpm typecheck && pnpm test:aiko — and fix anything you broke.

${GUARDRAILS}

Finish with a concise summary of what changed and why."

echo "-- spawning graff fixer agent (budget: ${MAX_MODEL_CALLS} model calls / ${TIMEOUT_S}s) --"
mkdir -p "$OUT"
GRAFF_LOG="${ROOT}/${OUT}/graff-fixer-${STAMP}.log"
set +e
timeout "$TIMEOUT_S" "$GRAFF_BIN" -p "$PROMPT" \
  --yolo --no-telemetry --learning-privacy local --dedupe-tool-calls \
  --max-model-calls "$MAX_MODEL_CALLS" \
  "${MODEL_ARGS[@]}" \
  >"$GRAFF_LOG" 2>&1
GRAFF_RC=$?
set -e
echo "graff fixer exited rc=${GRAFF_RC} (log: ${GRAFF_LOG})"
tail -n 20 "$GRAFF_LOG" || true
[ "$GRAFF_RC" -eq 0 ] || [ "$GRAFF_RC" -eq 124 ] || fail "graff fixer failed (rc=${GRAFF_RC}); log kept at ${GRAFF_LOG}"

MAIN_FREEZE_NOW="$(git status --porcelain | sha1sum | cut -d' ' -f1)"
if [ "$MAIN_FREEZE_NOW" != "$MAIN_FREEZE" ]; then
  trap - EXIT   # keep worktree + log for inspection
  fail "main checkout changed while the fixer agent ran (self-modification or peer session) — refusing to build a PR on a moving tree.
Worktree kept: ${WORKTREE}"
fi

# ---------- 5. review the diff ----------
echo "-- reviewing diff --"
CHANGED="$(cd "$WORKTREE" && git status --porcelain | awk '{print $2}')"
[ -n "$CHANGED" ] || { echo "graff agent made no changes — nothing to PR."; exit 0; }

DENIED="$(printf '%s\n' $CHANGED | grep -Ev '^(apps/|packages/|tests/|docs/|scripts/)' || true)"
if [ -n "$DENIED" ]; then
  trap - EXIT   # keep the worktree for human inspection
  fail "agent touched paths outside the allowlist:
${DENIED}
Worktree kept for inspection: ${WORKTREE}"
fi

FORBIDDEN="$(printf '%s\n' $CHANGED | grep -E '(^|/)(\.env|\.graff/|artifacts/|codedb\.snapshot|.*\.(key|pem|sqlite)$|scripts/harness-selflearn\.sh$|scripts/harness-learn\.mjs$)' || true)"
if [ -n "$FORBIDDEN" ]; then
  trap - EXIT
  fail "agent touched forbidden paths:
${FORBIDDEN}
Worktree kept for inspection: ${WORKTREE}"
fi

cd "$WORKTREE"
git add -A
git commit -q -m "Learn from agent logs: address ${NEW_LESSONS} recurring harness failure pattern(s)

Mined by scripts/harness-learn.mjs from .graff logs; fixed by the graff
fixer agent under the harness-selflearn loop. Lessons: ${OUT}/lessons-current.json.

🤖 Generated with the self-learning harness loop" \
  && echo "committed $(git rev-parse --short HEAD)"

# ---------- 6. verify ----------
for cmd in "${CHECK_CMDS[@]}"; do
  echo "-- verifying: pnpm ${cmd} --"
  pnpm "$cmd" >"${OUT}/verify-${cmd}.log" 2>&1 \
    || { tail -n 40 "${OUT}/verify-${cmd}.log"; fail "verification failed: pnpm ${cmd} (log: ${OUT}/verify-${cmd}.log)"; }
  echo "   ok"
done

if [ "${SELFLEARN_NO_PR:-0}" = "1" ]; then
  echo "SELFLEARN_NO_PR=1 — committed on ${BRANCH}, skipping push/PR."
  exit 0
fi

# ---------- 7. PR ----------
echo "-- pushing ${BRANCH} and opening PR --"
git push -q -u origin "$BRANCH" || fail "push failed"

FINGERPRINTS="$(node -e 'const r=require(process.argv[1]);console.log(r.new_lesson_fingerprints.join(" "))' "$LESSONS_JSON" 2>/dev/null || true)"
LESSONS_TABLE="$(sed -n '/^| kind/,/^$/p' "${OUT}/lessons-current.md" 2>/dev/null | head -30 || true)"
FIXER_SUMMARY="$(tail -n 60 "$GRAFF_LOG" 2>/dev/null || echo 'see log')"
VERIFY_TAIL="$(tail -n 5 "${OUT}/verify-${CHECK_CMDS[0]}.log" 2>/dev/null || true)"

BODY="$(cat <<EOF
## Self-learning harness loop — ${STAMP}

Mined from \`.graff\` agent logs by \`scripts/harness-learn.mjs\`; **${NEW_LESSONS} new failure pattern(s)** handed to a graff fixer agent (budget: ${MAX_MODEL_CALLS} model calls). This PR makes the harness stop repeating them.

### Lessons addressed

${LESSONS_TABLE}

Fingerprints: \`${FINGERPRINTS}\`

### What the fixer agent changed

<details><summary>fixer agent output (tail)</summary>

\`\`\`
${FIXER_SUMMARY}
\`\`\`

</details>

### Verification

$(printf -- '- `pnpm %s` ✓' "${CHECK_CMDS[@]}")

<details><summary>typecheck tail</summary>

\`\`\`
${VERIFY_TAIL}
\`\`\`

</details>

### Provenance

- Miner: \`scripts/harness-learn.mjs\` → \`${OUT}/lessons-current.json\`
- Report: \`${REPORT}\`
- Base: \`${BASE}\`, loop run: ${STAMP}
- Diff allowlist enforced: apps/ packages/ tests/ docs/ scripts/

🤖 Generated with the self-learning harness loop.
EOF
)"

PR_URL="$(gh pr create --base "$BASE" --head "$BRANCH" \
  --title "harness-learn: fix ${NEW_LESSONS} recurring agent failure pattern(s)" \
  --body "$BODY")" || fail "gh pr create failed"

echo "== PR opened: ${PR_URL} =="
cd "$ROOT"

# ---------- 8. mark lessons fixed ----------
node scripts/harness-learn.mjs mark --pr "$PR_URL" --lessons "$LESSONS_JSON" || true
echo "done."
