# ARC-AGI-3 gotchas (hard-won from live runs, ~hours of debugging each)

These are real failure modes that cost real time. The gate (scripts/arc_gate.sh)
checks the load-bearing ones so they cannot silently regress.

## 1. The sticky-session cookie (the #1 online trap, ~1h to find)

The live API sits behind an AWS-ALB that issues sticky `AWSALBAPP` / `GAMESESSION`
cookies. A **stateless** client (urllib with no cookie jar, fresh `curl` per call,
or a new `requests` request each time) lands on a **random backend** and gets
spurious `SERVER_ERROR "game <id> not found"` on RESET, even though the game exists
and your rate budget is fine (`x-ratelimit-remaining` high).

**Fix:** persist cookies across the whole `open -> reset -> act -> close` flow so you
pin one healthy backend. In-process: `requests.Session()` or
`urllib.request.build_opener(HTTPCookieProcessor(http.cookiejar.LWPCookieJar(...)))`.
Across processes: save the jar to disk and reload it. `arc_client.py` does both.

Corollary: a **cross-process scorecard `GET`** also 404s for the same reason. Verify
the scorecard IN-SESSION, not from a fresh process.

## 2. `score` was renamed to `levels_completed` (SDK v0.9.3)

Progress is `levels_completed` (and `win_levels`, formerly `win_score`). Code that
keys on a numeric `score` field silently reads `None`. Worse: **17 of 25 games never
expose a `score` field at all** - advancement is only in `levels_completed` / `state`.
Read both keys; never gate logic on `score` alone.

## 3. Do NOT bail a winning replay on "no score gain"

A naive guard like `if no_score_gain_for(60): abandon_replay()` is a disaster.
Sparse rewards mean 150..1500 actions can pass between visible gains, and most games
never surface `score`. This guard abandoned the CORRECT winning replay in 23/25 games
and dropped the agent into random exploration. When replaying a known-good sequence
on a reused layout (Kaggle reuses public-half games), **run the replay to completion**;
do not second-guess it on missing reward.

## 4. Transient non-64x64 frames mid-game

Some games emit a malformed frame for one step (e.g. `cn04` returns a `(0,)` frame).
A shape guard that does `RESET` on a bad frame **desyncs the whole replay** (you reset
without advancing your action index). Keep emitting your in-flight open-loop action
through the transient frame; do not reset. `arc_client.render()` tolerates this.

## 5. ACTION6 click coordinates: x = column, y = row, 0..63

Easy to swap. `x` is the column, `y` is the row, both 0-indexed in 0..63. Read the
column off the two-digit ruler the renderer prints; do not eyeball it.

## 6. The anonymous key 401s online; offline needs no key

An anonymous/empty key gets 401 on `GET /api/games` online. That is expected. The
OFFLINE engine needs no key at all - which is exactly why the Kaggle/offline mode is
the default in this skill.

## 7. Kaggle = no internet + must be open-source

The Kaggle scoring sandbox blocks the internet, so any plan that calls a hosted model
(GPT/Claude/Gemini) or the live ARC API is disqualified. Prize-eligible submissions
must also be open-sourced under a permissive license (CC0 or MIT-0). The earlier idea
of a "blind API agent to hide mechanics" is both infeasible and disqualifying. Build a
self-contained, numpy-only (or local-model) offline agent. See 05-kaggle.md.

## 8. Launch long runs with run_in_background, never a trailing `&`

A trailing `&` double-detaches the process so the harness cannot track completion and
the run is orphaned. Use the background runner, not `&`.

## 9. The honesty gate

Offline-engine wins are REAL but are NOT a leaderboard placement - the official board
needs the keyed online eval under your account. Report "N levels cleared on game X
offline", never "ranked / SOTA / ASI". Mixing the two is the failure mode the project
bans. See [[arc-agi-honest-benchmark-method]] and [[intelligence-domain-superpattern]].
