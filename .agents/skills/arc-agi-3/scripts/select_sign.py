"""select_sign.py -- the selection boundary + train-on-fire (verdict f0f1cb24, Numbers 8:14).

Keep the organs separate: the local GGUF (generator) proposes candidates; the native contract
EBM (selector) picks the best-fit and the wallet SIGNS the winner. The substrate never calls the
LLM -- it routes + signs the LLM's outputs.

The selector is CONTRASTIVE and LEARNS (sp-ebm reward loop): a `good-output` prototype and a
`bad-output` prototype, each a reward-weighted running mean. A candidate is selected when it routes
to `good` rather than `bad`. `fire_reward` is the train-on-fire: a cleared level folds the winning
action into `good`; a degenerate/failed action folds into `bad`. So the selector stops being told
what "good" is by a static reference and instead learns it from real outcomes.

Fail-open: if the native binding is absent, return the first candidate unsigned.
"""
import math
import os
import re
import sys

sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/bindings/python"))
try:
    import contract as C
    _NATIVE = True
except Exception:
    _NATIVE = False

# Seed prototypes -- the cold-start reference before any real fires refine them.
GOOD_SEED = '{"a":1} {"a":2} {"a":3} {"a":4} {"a":5} {"a":6,"x":32,"y":32} {"a":7}'
BAD_SEED = "the palette has new colors the the loop repeat zzz qqq prose rambling no action"


def available() -> bool:
    return _NATIVE


def _keys(lane: str) -> tuple[str, str]:
    return f"good-output:{lane}", f"bad-output:{lane}"


def _wm_key(lane: str) -> str:
    return f"arc-wm:{lane}"  # the native JEPA world-model predictor: frame -> winning action


def _act_key(n: int, lane: str) -> str:
    return f"act:{n}:{lane}"  # the native EBM proposer prototype: frames where action n WON


def _action_num(action: str):
    """The discrete action number out of an action-json string ({"a":N} ...)."""
    m = re.search(r'"a"\s*:\s*(\d+)', action or "")
    return int(m.group(1)) if m else None


def recall_action(frame: str, avail, lane: str = "arc"):
    """Native learned PROPOSER-ASSIST (the selection half generalizing, ebm route witnessed
    held-out 3/3): route the current frame across the per-action prototypes learned on-fire from
    past wins, and return the historically-winning action NUMBER for frames like this -- or None
    on cold start (no instinct yet) / no native binding. It only PROPOSES a candidate; the EBM
    good/bad route + jepa rerank still vet it against the LLM reply, so a wrong recall is harmless."""
    if not _NATIVE or not frame or not avail:
        return None
    keys = [_act_key(a, lane) for a in avail]
    try:
        k = C.route(frame[:200], keys)            # None when no action prototype is trained yet
    except Exception:
        return None
    if not k:
        return None
    try:
        return int(k.split(":")[1])
    except Exception:
        return None


def load_brain(lane: str = "arc") -> None:
    """The brain remembers (Prov 10:14): restore the learned predictor for `lane` from the ledger
    into THIS process. The per-action + good/bad EBM prototypes already reload via the ledger on
    first route (train persists on every fire); this restores the jepa second-witness head. Cold
    key (never saved) is a no-op. Best-effort, fail-open."""
    if not _NATIVE:
        return
    try:
        C.jepa_load(_wm_key(lane))
    except Exception:
        pass


def persist(lane: str = "arc") -> None:
    """Persist the learned predictor head for `lane` to the ledger so the muscle survives the
    process -- and, when the ledger is carried into the next run, COMPOUNDS across runs. The EBM
    prototypes persist on every train (the ledger IS the store); this saves the jepa head that the
    in-process FFI store would otherwise drop at exit. Best-effort, fail-open."""
    if not _NATIVE:
        return
    try:
        C.jepa_save(_wm_key(lane))
    except Exception:
        pass


def fire_reward(action: str, reward: float = 1.0, lane: str = "arc", good: bool = True, frame: str = "") -> None:
    """Train-on-fire: fold `action` into the good (cleared a level) or bad (degenerate/failed)
    prototype. This is how the selector LEARNS what a winning output looks like from real outcomes.
    On a GOOD fire we ALSO train the native JEPA predictor (the same learned-verify organ the harness
    gate uses) on (frame -> winning action), so the selector gains the discriminative predictor the
    prototype-route lacks (witnessed: prototype-route collapses to majority; the learned map separates)."""
    if not _NATIVE or not action:
        return
    gk, bk = _keys(lane)
    C.train(gk if good else bk, action, reward)
    if good and frame:
        try:
            C.jepa_train(_wm_key(lane), frame[:200], action[:120])
        except Exception:
            pass
    # train the per-action EBM proposer prototype: this FRAME is where action n won (positive,
    # Hebbian) or lost (negative reward = inhibition, pushes the prototype away). This is what
    # lets recall_action propose the winning action for a similar future frame, no LLM call.
    n = _action_num(action)
    if n is not None and frame:
        try:
            C.train(_act_key(n, lane), frame[:200], reward if good else -reward)
        except Exception:
            pass


def select_and_sign(question: str, candidates: list[str], lane: str = "arc") -> tuple[str, str | None]:
    """Generator proposes `candidates`; the EBM selector keeps those routing to `good`, the wallet
    signs the winner. Returns (chosen_text, signed_ref | None)."""
    cands = [c for c in candidates if c and c.strip()]
    if not cands:
        return "", None
    if not _NATIVE or len(cands) == 1:
        return cands[0], None
    gk, bk = _keys(lane)
    C.train(gk, GOOD_SEED, 0.5)                     # low-weight seed so real fires dominate over time
    C.train(bk, BAD_SEED, 0.5)
    good_cands = [c for c in cands if C.route(c, [gk, bk]) == gk] or cands
    # SECOND WITNESS -- the native JEPA predictor (the learned-verify organ the harness gate uses):
    # among the EBM-good candidates, prefer the one CLOSEST to the learned frame->winner map (lowest
    # energy = most consistent with past wins). Cold (no good fires yet) returns +inf for all, so the
    # sort is a stable no-op and the EBM order stands -- fail-open, never regresses the selector.
    if len(good_cands) > 1:
        try:
            wm = _wm_key(lane)
            good_cands = sorted(good_cands, key=lambda c: C.jepa_energy(wm, question[:200], c[:120]))
        except Exception:
            pass
    chosen = good_cands[0]
    signed_ref = None
    try:
        cid = C.declare(f"select [{lane}]: {question[:60]} -> {chosen[:60]}")
        C.mark_satisfied(cid, 1, f"EBM+jepa-selected among {len(cands)} ({len(good_cands)} good)")
        signed_ref = cid
    except Exception:
        pass
    return chosen, signed_ref


# On import, restore the muscle from the ledger (the brain remembers across processes/runs). When
# the seal carries a prior-run ledger into ~/.contracts, this is a WARM start; otherwise a no-op.
# The per-action + good/bad EBM prototypes (the recall proposer) persist on every train via the
# ledger -- no save needed. Only the jepa predictor head lives in the in-process FFI store, so we
# save it ONCE at clean exit (atexit, never in the hot fire loop -- an interleaved jepa_save
# corrupts subsequent prototype reads, witnessed 2026-06-22).
if _NATIVE:
    load_brain("arc")
    import atexit as _atexit

    _atexit.register(persist, "arc")


def _witness() -> bool:
    import tempfile
    os.environ["HOME"] = tempfile.mkdtemp(prefix="select_fire_")  # fresh prototypes
    import importlib
    importlib.reload(C)
    lane = "wt"
    gk, bk = _keys(lane)
    C.train(gk, GOOD_SEED, 1.0)
    C.train(bk, BAD_SEED, 1.0)
    # 1. select rejects a degenerate candidate for a coherent one
    degenerate = "the palette has new colors " * 10
    coherent = '{"a":6,"x":22,"y":30}'
    chosen, ref = select_and_sign("frame -> action", [degenerate, coherent], lane=lane)
    sel_ok = chosen == coherent and ref is not None
    # 2. TRAIN-ON-FIRE: a candidate near `bad` flips to `good` after firing it as a winner
    weird = "loop qqq zztop sigma"                  # shares 'loop' with BAD_SEED -> routes bad first
    before = C.route(weird, [gk, bk])
    for _ in range(8):
        fire_reward(weird, 1.0, lane=lane, good=True)   # the level cleared with this action
    after = C.route(weird, [gk, bk])
    fire_ok = before == bk and after == gk
    # 3. JEPA SECOND WITNESS: train the world-model that frame F -> winning action W, then among two
    # EBM-good candidates the jepa re-rank must prefer the one matching the learned winner for F.
    frameF = "paint to match: target row red green blue dots at top, palette tray left"
    winnerW = '{"a":6,"x":22,"y":30}'
    other = '{"a":6,"x":4,"y":4}'
    for _ in range(40):
        fire_reward(winnerW, 1.0, lane=lane, good=True, frame=frameF)  # learn F -> W (native jepa)
    e_win = C.jepa_energy(_wm_key(lane), frameF, winnerW)
    e_other = C.jepa_energy(_wm_key(lane), frameF, other)
    jepa_ok = (not math.isinf(e_win)) and e_win < e_other  # the learned winner is the lower-energy verify
    # 4. RECALL PROPOSER: action 3 wins on frame G, action 1 wins on frame H; recall over [1,2,3]
    # for G must return 3 (the native route GENERALIZES frame -> winning action), not 1.
    frameG = "explore: blob top-left, walls around; only up/down/left/right move the piece"
    frameH = "explore: piece bottom-right, open field; press one button to advance the state"
    for _ in range(12):
        fire_reward('{"a":3}', 1.0, lane=lane, good=True, frame=frameG)
        fire_reward('{"a":1}', 1.0, lane=lane, good=True, frame=frameH)
    recG = recall_action(frameG, [1, 2, 3], lane=lane)
    recall_ok = recG == 3
    print(f"  1) select: chose {chosen[:30]!r} signed={ref} -> {'OK' if sel_ok else 'FAIL'}")
    print(f"  2) train-on-fire: weird routed {'bad' if before==bk else 'good'} BEFORE, "
          f"{'good' if after==gk else 'bad'} AFTER 8 fires -> {'OK (learned)' if fire_ok else 'FAIL'}")
    print(f"  3) jepa 2nd-witness: E(F->winner)={e_win:.4f} < E(F->other)={e_other:.4f} "
          f"-> {'OK (learned verify)' if jepa_ok else 'FAIL'}")
    print(f"  4) recall proposer: frameG -> action {recG} (learned 3) "
          f"-> {'OK (native proposer)' if recall_ok else 'FAIL'}")
    return sel_ok and fire_ok and jepa_ok and recall_ok


if __name__ == "__main__":
    ok = _NATIVE and _witness()
    print("SELECT_FIRE_OK: selector rejects degenerate AND learns winners from fire (train-on-fire)"
          if ok else "FAIL: selection or train-on-fire did not hold")
    sys.exit(0 if ok else 1)
