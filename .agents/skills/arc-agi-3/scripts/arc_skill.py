"""arc_skill.py -- ARC-AGI-3 as ONE /contract-bound skill: the native organs, surface-agnostic.

The collapse (Eccl 10:10 -- skill brings success, not more LLM force): the ARC decision is ONE set of
native /contract organs, and every surface is a thin shell over it. Two surfaces share this module:

  • SCORING  -- my_agent_aiko.MyAgent.choose_action(frame) -> self.skill.decide(frame)  (the organs decide)
  • PLAY     -- Aiko and the offline runner drive the same ArcSkill for interactive play

The organs, in dispatch order (the LLM is ONE search-and-verified proposer among them, never the sole
decider -- that is the witnessed wall):

  EYE        perceive.py -- raw grid -> structured objects (the deterministic perception)
  ROUTER     classify(avail) -- archetype dispatch (lewis-strategy)
  PLANNER    _paint_plan -- the @contract paint-to-match neuron (clears sb26; identical board -> recalled plan)
  PROPOSER   _ask_aiko -- the local GGUF, one-shot (generation; the wall in the loop)
  SELECTOR   select_sign -- native EBM route + jepa predictor verify, signs the winner
  SWEEP      _click_points -- deterministic click-space exploration, AFTER the LLM (fail-safe)

decide() returns a neutral (a, x, y, from_organ) tuple; each surface marshals its own action type.
Fail-open everywhere: any organ error degrades to a safe action, never crashes the loop.
"""
import functools
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

_HERE = Path(__file__).resolve().parent
import sys as _sys
if str(_HERE) not in _sys.path:
    _sys.path.insert(0, str(_HERE))

try:
    from perceive import perceive as _perceive
except Exception:
    _perceive = None
try:
    import meta_offline as _MO
except Exception:
    _MO = None
try:
    from native_contract import NativeContract
except Exception:
    NativeContract = None

import shutil as _shutil
AIKO_BIN = os.environ.get("AIKO_BIN", _shutil.which("aiko") or str(_HERE / "assets" / "aiko-linux-x86_64"))
AIKO_MODEL = os.environ.get("AIKO_MODEL", "qwen3.5:4b")
AIKO_TIMEOUT = int(os.environ.get("AIKO_TIMEOUT", "120"))
# LOCAL proposer fallback (Lewis 2026-06-23 - "we HAVE the llm, it's supposed to round against
# itself"): the Kaggle path ships AIKO_BIN (the Linux ELF) or runs ARC_MECHANICAL=1, so _ask_aiko
# is ONLY the dev-mac / live-online path. When the ELF is absent there, round against the LOCAL
# aiko-ebllm v6 GGUF (the SEEK-rung gzip-LM/bible energy model at ~/.contracts/data/aiko-model.gguf)
# via llama-completion. The LLM rounds against itself: this GGUF PROPOSES, the native EBM+jepa
# organs SELECT (eye->predict->propose->verify). Fail-VISIBLE if no proposer wire exists.
AIKO_GGUF = os.environ.get("AIKO_GGUF", os.path.expanduser("~/.contracts/data/aiko-model.gguf"))
LLAMA_COMPLETION = os.environ.get("LLAMA_COMPLETION", _shutil.which("llama-completion") or "")
# MECHANICAL MODE (Lewis 2026-06-23 - "use /contract as the llm instead of vllm, purely mechanically"):
# when set, the decision is the NATIVE /contract organs ONLY (cogmap explorer + region/paint planners +
# the EBM+jepa selector + recall + click-sweep). The vLLM LLM proposer (_ask_aiko subprocess) is SKIPPED
# entirely - no model, no token-generation latency, no OOM/400/FlashInfer break surface. Deterministic,
# microsecond actions -> orders of magnitude more exploration per game. Default OFF (local/engine keep
# the LLM-assisted path); the Kaggle seal runner sets ARC_MECHANICAL=1.
MECHANICAL = os.environ.get("ARC_MECHANICAL", "") not in ("", "0", "false", "False")
LEGACY_HEURISTICS = os.environ.get("ARC_LEGACY_HEURISTICS", "") in ("1", "true", "True")


# ── the /contract DECORATOR -- bind a function (a neuron) to content-addressed memory (instinct) ──
def _auto_key(args, kwargs):
    return hashlib.blake2b(repr((args, sorted(kwargs.items()))).encode(), digest_size=12).hexdigest()


def contract(key=None, recall_cap=None):
    """Bind a function to content-addressed recall: identical inputs RECALL the cached result (the cache
    IS the replay). The CACHE half, not the proposer (a cached wrong answer stays wrong). Fail-open."""
    def _wrap(fn):
        store, seen = {}, {}
        @functools.wraps(fn)
        def inner(*a, **k):
            try:
                addr = key(*a, **k) if key is not None else _auto_key(a, k)
            except Exception:
                return fn(*a, **k)
            if addr in store and (recall_cap is None or seen.get(addr, 0) < recall_cap):
                seen[addr] = seen.get(addr, 0) + 1
                return store[addr]
            out = fn(*a, **k)
            store[addr] = out
            return out
        inner.contract_store, inner.contract_seen = store, seen
        return inner
    return _wrap


def _grid_key(rows, *_, **__):
    h = hashlib.blake2b(digest_size=12)
    if rows is not None:
        for r in rows:
            h.update(bytes((int(c) & 0xFF) for c in r))
    return h.hexdigest()


# Bind the deterministic planners to the ENGINE itself (not a throwaway dict). The native
# @contract over libcontract content-addresses the call by repr(rows) and RECALLS the settled plan
# from the ledger -- persistent, cross-process instinct (the contract-SKILL "Native @contract --
# memoize/recall" doctrine: durable instinct, not a per-process dict). Fail-open to the local
# content-keyed shim when the C-ABI is absent. The LLM PROPOSER deliberately stays on the local
# capped shim -- a generator must be free to re-run (recall_cap), never a permanent native recall.
try:
    import sys as _s2

    for _binding in (
        os.environ.get("CONTRACT_PYTHON_BINDINGS"),
        str(Path.home() / ".claude/skills/contract/bindings/python"),
        str(Path.home() / "Unbrowse/contract/bindings/python"),
    ):
        if _binding and Path(_binding).is_dir() and _binding not in _s2.path:
            _s2.path.insert(0, _binding)
    from contract import contract as _native_contract  # the engine binding (mirrors the Zig body)
except Exception:
    _native_contract = None


def _bind_planner(fn):
    """Bind a pure deterministic planner to the native neuron store (persistent recall), or the
    local content-keyed dict if the engine is unreachable. Pure-deterministic only -- never a gate."""
    if _native_contract is not None:
        try:
            return _native_contract()(fn)
        except Exception:
            pass
    return contract(key=_grid_key)(fn)


# the PLANNER as a contract neuron: identical board -> recalled plan (instinct), not recomputed.
_paint_plan = _bind_planner(_MO.paint_plan) if _MO is not None else None
_region_plan = _bind_planner(_MO.region_plan) if _MO is not None else None  # execute-don't-guess: deterministic region-control probe-sweep (the LLM scores 0 on these)


# ── EYE + frame text ──
def rows_of(frame):
    """Extract the 64x64 grid as int-rows from a frame (unwrap nested frame-list). Surface-agnostic."""
    grid = getattr(frame, "frame", None)
    if grid is None:
        return None
    try:
        rows = grid
        while isinstance(rows, list) and rows and isinstance(rows[0], list) and rows[0] and isinstance(rows[0][0], list):
            rows = rows[-1]
        if isinstance(rows, list) and rows and isinstance(rows[0], list):
            return [[int(c) for c in r] for r in rows]
    except Exception:
        return None
    return None


def classify(avail, rows=None):
    """Dispatch only from observable mechanics, never a game or level id.

    Action availability is a useful prior, but a structural planner is enabled
    only when the current pixels satisfy its preconditions.
    """
    a = sorted(avail or [])
    if 5 in a and 6 in a and rows is not None and _MO is not None:
        try:
            dots, targets, swatches = _MO.detect(rows)
            if dots and len(targets) >= len(dots) and all(color in swatches for color in targets):
                return "paint-to-match"
        except Exception:
            pass
    if 6 in a and rows is not None and _MO is not None:
        try:
            p = _perceive(rows) if _perceive is not None else None
            controls = _MO.candidate_controls(rows)
            big = max(
                (int(obj.get("size", 0)) for obj in (p or {}).get("big_regions", [])),
                default=0,
            )
            area = max(1, len(rows) * len(rows[0]))
            # Region control is an observable mechanic, not an action-list
            # identity. Some environments expose a secondary reset/commit
            # action alongside click. Require both candidate controls and a
            # region large enough to be controlled, so empty click canvases
            # still refuse this solver.
            if len(controls) >= 3 and big / area >= 0.02:
                return "region-control"
        except Exception:
            pass
    return "explore"


def _obj_str(o):
    cx, cy = o["centroid"]; x0, y0, x1, y1 = o["bbox"]
    return "color%d size%d @(%d,%d) bbox(%d,%d,%d,%d)" % (o["color"], o["size"], round(cx), round(cy), x0, y0, x1, y1)


def _perceive_text(rows):
    if _perceive is None:
        return ""
    try:
        p = _perceive(rows)
    except Exception:
        return ""
    L = ["perception (deterministic eye): %dx%d bg=%d, %d objects / %d colors" %
         (p["w"], p["h"], p["bg"], p["n_objects"], p["n_colors"])]
    if p.get("targets"):
        L.append("  target_row(top -- the goal colours to reproduce): " + ",".join(
            "color%d@(%d,%d)" % (o["color"], round(o["centroid"][0]), round(o["centroid"][1])) for o in p["targets"]))
    if p.get("big_regions"):
        L.append("  big_regions: " + "; ".join(_obj_str(o) for o in p["big_regions"][:8]))
    if p.get("small_objects"):
        L.append("  small_pieces: " + "; ".join(_obj_str(o) for o in p["small_objects"][:12]))
    if p.get("palette"):
        L.append("  palette_tray(bottom): " + ",".join(
            "color%d@(%d,%d)" % (o["color"], round(o["centroid"][0]), round(o["centroid"][1])) for o in p["palette"]))
    if p.get("element"):
        L.append("  controllable_element: " + _obj_str(p["element"]))
    return "\n".join(L)


def frame_text(frame):
    avail = list(getattr(frame, "available_actions", []) or [])
    rows = rows_of(frame)
    lines = [f"available_actions: {avail}"]
    if rows is not None:
        pt = _perceive_text(rows)
        if pt:
            lines.append(pt)
        lines.append("frame:")
        for r in rows:
            lines.append("".join(str(c) for c in r))
    return "\n".join(lines)


# ── PROPOSER (the local GGUF, one-shot) -- a contract neuron: identical prompt -> recalled reply ──
SYSTEM_PROMPT = (
    "You are playing an unseen interactive grid environment with no instructions. Infer its hidden "
    "transition rules and completion condition from frames and observed outcomes. Actions 1-5 and 7 "
    "are discrete inputs; action 6 is a click with x=column and y=row in 0..63. Use only general "
    "evidence: probe untried legal actions, make a falsifiable prediction, update it from the observed "
    "frame delta, and reuse an action only when its outcomes support doing so. Do not assume a named "
    "game, a known level, a fixed layout, a memorized sequence, or a puzzle-specific rule. Completion "
    "is primary and action efficiency secondary. Give the single best next action.\n"
    "Do NOT use tools or run commands. Reply with ONE json object on the last line and nothing "
    'after it: {"a": <action_number>, "x": <col 0-63 or omit>, "y": <row 0-63 or omit>}. x and y '
    "are ONLY for action 6; aim at an object centroid from the perception."
)


_AIKO_DIAG = {"n": 0}  # surface the engine's real exit on the first calls (was swallowed silently)


@contract(recall_cap=3)
def _ask_aiko(ft):
    """One-shot aiko (the engine -> vLLM proposer): returns its stdout, or '' on failure.
    Surfaces rc + stderr on the first calls so a dead LLM wire is VISIBLE in the run log
    (it was silently swallowed, so the agent ran mechanical and nobody could see why)."""
    env = dict(os.environ)
    env["AIKO_NO_TELEMETRY"] = "1"
    env.setdefault("OLLAMA_API_KEY", "x")
    # Choose the proposer wire: the Kaggle Linux ELF if present, else the LOCAL v6 GGUF via
    # llama-completion (the LLM rounding against itself on the dev mac / live online).
    if os.path.exists(AIKO_BIN):
        argv = [AIKO_BIN, "-p", "--model", AIKO_MODEL, "--system-prompt", SYSTEM_PROMPT, ft]
    elif LLAMA_COMPLETION and os.path.exists(AIKO_GGUF):
        argv = [LLAMA_COMPLETION, "-m", AIKO_GGUF, "-sys", SYSTEM_PROMPT, "-p", ft,
                "-n", "256", "--no-display-prompt", "--simple-io"]
    else:
        # NO generative model on this box (no Kaggle ELF, no local GGUF for llama-completion).
        # FALL BACK TO THE BIBLE/ORGAN SELECTOR, never a fabricated proposal: returning "" routes
        # decide() to the native bible-grounded organs - cogmap explorer + select_sign (the EBM+jepa
        # energy selector over the grid-eye embed, the same energy family as the bible-route) vetting
        # recall_action. The bible is a SELECTOR, not an ARC generator (grid.zig honest scope: the
        # bible prior lifts RETRIEVAL, is antagonistic to REASONING - bible-as-ARC-solver is refused).
        if _AIKO_DIAG["n"] < 8:
            _AIKO_DIAG["n"] += 1
            print("[ask_aiko] no GGUF proposer (AIKO_BIN=%r absent, LLAMA_COMPLETION=%r AIKO_GGUF=%r) "
                  "-> bible/organ fallback (cogmap + select_sign EBM/jepa energy selector)" % (
                      AIKO_BIN, LLAMA_COMPLETION, AIKO_GGUF), flush=True)
        return ""
    try:
        p = subprocess.run(
            argv,
            capture_output=True, text=True, encoding="utf-8", errors="replace",  # engine grid output has non-utf8 bytes; strict decode crashed _ask_aiko to '' (witnessed v56)
            timeout=AIKO_TIMEOUT, env=env, cwd=str(_HERE), stdin=subprocess.DEVNULL,
        )
        if _AIKO_DIAG["n"] < 8:
            _AIKO_DIAG["n"] += 1
            print("[ask_aiko] rc=%d stdout=%dB stderr=%r" % (
                p.returncode, len(p.stdout or ""), (p.stderr or "")[-400:]), flush=True)
        return p.stdout or ""
    except Exception as e:
        if _AIKO_DIAG["n"] < 8:
            _AIKO_DIAG["n"] += 1
            print("[ask_aiko] EXCEPTION %s: %s" % (type(e).__name__, str(e)[:300]), flush=True)
        return ""


# NOTE (2026-06-23, witnessed): gzip.zig as a no-GGUF ARC action-PROPOSER was tried and REFUSED on
# a runnable witness (`/tmp/wit_gzip_arc.py`). gzip's ROLE is proposer (correct), but it cannot
# usefully propose ARC actions: bare action tokens ("ACTION1".."ACTION7") sit BELOW DEFLATE's
# integer-quantization floor - gzip_propose returns identical marginal MDL [2,2,2] (no
# discrimination), so it would always pick avail[0] (fabricated value). It discriminates only
# verbatim-repeat outcome phrases, but frame_text() carries no per-action outcome structure to
# match - and the signal it would need ("which action changed the frame") is exactly what cogmap
# tracks DETERMINISTICALLY + action-efficiently. gzip-arc is therefore redundant with cogmap
# (Synapse-min leaven). The cogmap explorer + select_sign remain the no-LLM proposer/selector.


def parse_action(text, avail):
    """Pull the last {...} from a reply -> a neutral (a, x, y, parsed) tuple (surface marshals it)."""
    for m in reversed(re.findall(r"\{[^{}]*\}", text or "")):
        try:
            obj = json.loads(m)
        except Exception:
            continue
        if "a" not in obj:
            continue
        return int(obj["a"]), obj.get("x"), obj.get("y"), True
    for a in avail:
        if a != 6:
            return int(a), None, None, False
    if 6 in avail:
        return 6, None, None, False
    return int(avail[0] if avail else 1), None, None, False


# ── SWEEP -- deterministic click-space exploration (AFTER the LLM; general, fail-safe) ──
def click_points(rows):
    pts, seen = [], set()
    def _add(x, y):
        x = max(0, min(63, int(round(x)))); y = max(0, min(63, int(round(y))))
        if (x, y) not in seen:
            seen.add((x, y)); pts.append((x, y))
    try:
        if _perceive is not None and rows is not None:
            p = _perceive(rows)
            for o in sorted(p.get("objects", []), key=lambda o: -o.get("size", 0)):
                _add(*o["centroid"])
    except Exception:
        pass
    H = len(rows) if rows else 64
    W = len(rows[0]) if rows and rows[0] else 64
    for y in range(4, H, 8):
        for x in range(4, W, 8):
            _add(x, y)
    return pts


def semantic_click_candidates(rows):
    """Stable object-level click actions. Coordinates remain episode-local; the capability
    identity contains only structural features that can transfer safely across layouts."""
    out, seen = [], set()
    try:
        p = _perceive(rows) if _perceive is not None and rows is not None else None
        objects = sorted((p or {}).get("objects", []), key=lambda o: (-o.get("size", 0), o["centroid"][1], o["centroid"][0]))
        h = max(1, int((p or {}).get("h", len(rows) if rows else 64)))
        for obj in objects:
            x, y = (int(round(value)) for value in obj["centroid"])
            band = "top" if y < h * .25 else "bottom" if y > h * .75 else "middle"
            size = int(obj.get("size", 0))
            tier = "small" if size <= 12 else "medium" if size <= 120 else "large"
            label = f"{band}-{tier}-color-{int(obj.get('color', 0))}"
            key = (label, x, y)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "capability_id": NativeContract.click_capability_id(label) if NativeContract else f"aiko-arc.click.{label}",
                "label": f"click-{label}",
                "description": f"Click the centroid of a {tier} color {obj.get('color')} object in the {band} band",
                "action": 6,
                "x": x,
                "y": y,
            })
    except Exception:
        pass
    return out


def semantic_state_descriptor(rows):
    """Coordinate-free durable state identity.

    Exact hashes and click coordinates remain episode-local. Contract receives
    only object roles and aggregate structure that can transfer honestly.
    """
    try:
        p = _perceive(rows) if _perceive is not None and rows is not None else None
        if not p:
            return "objects=unknown"
        height = max(1, int(p.get("h", len(rows) if rows else 64)))
        roles = []
        for obj in p.get("objects", []):
            _, y = obj["centroid"]
            band = "top" if y < height * .25 else "bottom" if y > height * .75 else "middle"
            size = int(obj.get("size", 0))
            tier = "small" if size <= 12 else "medium" if size <= 120 else "large"
            roles.append(f"{band}-{tier}-c{int(obj.get('color', 0))}")
        counts = {}
        for role in roles:
            counts[role] = counts.get(role, 0) + 1
        role_text = ",".join(f"{role}x{counts[role]}" for role in sorted(counts))
        relation = ""
        element = p.get("element")
        if element is not None:
            families = {}
            for obj in p.get("objects", []):
                key = (int(obj.get("color", 0)), int(obj.get("size", 0)))
                families[key] = families.get(key, 0) + 1
            ex, ey = element["centroid"]
            targets = [
                obj for obj in p.get("objects", [])
                if 4 <= int(obj.get("size", 0)) <= 25
                and families[(int(obj.get("color", 0)), int(obj.get("size", 0)))] == 1
                and obj is not element
            ]
            if targets:
                target = max(
                    targets,
                    key=lambda obj: abs(obj["centroid"][0] - ex) + abs(obj["centroid"][1] - ey),
                )
                dx = target["centroid"][0] - ex
                dy = target["centroid"][1] - ey
                relation = (
                    f";control-target=dx{'+' if dx > 0 else '-' if dx < 0 else '0'}"
                    f",dy{'+' if dy > 0 else '-' if dy < 0 else '0'}"
                    f",distance={int(round((abs(dx) + abs(dy)) / 3))}"
                )
        return (
            f"bg={int(p.get('bg', 0))};colors={int(p.get('n_colors', 0))};"
            f"objects={int(p.get('n_objects', 0))};roles={role_text}{relation}"
        )
    except Exception:
        return "objects=unknown"


def semantic_transition_delta(before, after):
    """Derive coordinate-free transition facts from two durable state descriptors.

    These facts are dynamics evidence only.  In particular, ``matches`` below
    must never be promoted to task success without an external progress signal.
    """
    def fields(descriptor):
        out = {}
        for item in str(descriptor).split(";"):
            if "=" not in item:
                continue
            key, value = item.split("=", 1)
            out[key] = value
        relation = out.get("control-target", "")
        for item in relation.split(","):
            if "=" in item:
                key, value = item.split("=", 1)
                out[f"control-target.{key}"] = value
        return out

    left, right = fields(before), fields(after)
    delta = {"state_changed": str(before) != str(after)}
    for key in ("objects", "colors", "control-target.distance"):
        try:
            delta_key = {
                "objects": "object_count",
                "colors": "color_count",
                "control-target.distance": "target_distance",
            }[key]
            delta[delta_key] = int(right[key]) - int(left[key])
        except (KeyError, TypeError, ValueError):
            continue
    return delta


def prediction_agreement(predicted, observed):
    """Return whether every declared transition prediction was observed.

    Predictions are intentionally partial: a hypothesis may constrain one
    semantic fact without pretending to know the whole next frame.
    """
    if not isinstance(predicted, dict) or not predicted:
        return None
    for key, expected in predicted.items():
        if key not in observed:
            return None
        actual = observed[key]
        if isinstance(expected, (int, float)) and expected in (-1, 0, 1):
            actual_sign = (actual > 0) - (actual < 0)
            if actual_sign != int(expected):
                return False
        elif actual != expected:
            return False
    return True


class ArcSkill:
    """The ARC decision, as ONE stateful skill. decide(frame) -> (a, x, y, from_organ). The organs
    decide; the LLM is a search-and-verified proposer. State is the gradient memory (router verdict +
    cached procedure) + the train-on-fire bookkeeping. Surface-agnostic: kaggle and the engine share it."""

    def __init__(self):
        self._arch = None
        self._plan = None
        self._pidx = 0
        self._last_plan_grid = None
        self._lewis = None
        self._last_levels = 0
        self._last_chosen = None
        self._last_ft = ""
        self._clickpts = None
        self._cidx = 0
        self.signed_ref = None
        self.from_aiko = False  # did the LAST action come from the LLM (vs an organ/fallback)?
        self._contract = None
        self._contract_avail = None
        self._contract_last = None
        self._contract_calls = 0
        self._experiment_uses = {}
        self._experiment_attempts = 0
        self._hypothesis_by_proposal = {}
        self._grounded_contexts = set()
        self._navigation_visited = set()
        self._paint_variant = 0
        self._tried_proposals = set()
        self._inhibited_proposals = set()
        self._current_level = 0
        try:
            if NativeContract is not None:
                self._contract = NativeContract()
        except Exception:
            if os.environ.get("ARC_CONTRACT_REQUIRED", "") in ("1", "true", "True"):
                raise
        # EXPLORER -- the native cognitive map (cogmap.zig, signed): action-efficient state-space
        # coverage drives novel 'explore' games (the proven top-3 ARC-AGI-3 method). Per-episode
        # working memory; reset here (one skill per game). The agent interns frame-hash -> dense
        # state id at the I/O edge; the MAP is native.
        self._cog = None
        self._state_ids = {}
        self._cog_prev_state = None
        self._cog_prev_action = None
        try:
            import contract as _cogmod
            if hasattr(_cogmod, "cogmap_reset"):
                _cogmod.cogmap_reset()
                self._cog = _cogmod
        except Exception:
            self._cog = None
        if self._cog is None:
            try:
                from cogmap import CognitiveMap
                self._cog = CognitiveMap()
            except Exception:
                self._cog = None

    def _contract_context(self, frame, rows):
        avail = list(getattr(frame, "available_actions", []) or [])
        archetype = classify(avail, rows)
        return (
            f"archetype={archetype};actions={sorted(int(value) for value in avail)};"
            f"state={getattr(frame, 'state', '')};{semantic_state_descriptor(rows)}"
        )

    def _observe_contract_transition(self, frame, rows, context):
        if self._contract is None or self._contract_last is None:
            return
        previous_context, capability_id, previous_state, previous_levels, raw_proposal, hypothesis = (
            (*self._contract_last, None)
            if len(self._contract_last) == 5
            else self._contract_last
        )
        current_state = semantic_state_descriptor(rows)
        levels = int(getattr(frame, "levels_completed", 0) or 0)
        terminal = "GAME_OVER" in str(getattr(frame, "state", ""))
        changed = current_state != previous_state
        if not changed:
            self._inhibited_proposals.add((previous_levels,) + raw_proposal)
        # A visual delta is evidence about dynamics, not evidence of task success.
        # Train it in the continuous muscle model; settle the binary capability
        # record only on externally grounded progress or death.
        success = levels > previous_levels
        shape = "object" if levels > previous_levels else "array" if changed else "null"
        try:
            observed_delta = semantic_transition_delta(previous_state, current_state)
            agreement = prediction_agreement(
                (hypothesis or {}).get("predicted_delta"),
                observed_delta,
            )
            # Prediction truth and task success are different witnesses.  A
            # correct transition law earns dynamics evidence; only level
            # progress settles the capability as successful.
            reward = (
                1.0 if success else
                -1.0 if terminal else
                0.25 if agreement is True else
                -0.25 if agreement is False else
                0.15 if changed else
                -0.1
            )
            self._contract.observe_binary(
                previous_context,
                capability_id,
                previous_state,
                current_state,
                reward,
            )
            self._contract_calls += 1
            if success or terminal:
                self._contract.observe_capability(previous_context, capability_id, success, shape)
                self._contract_calls += 1
            if success:
                self._grounded_contexts.add((previous_context, capability_id))
            elif (
                not terminal
                and self._arch == "paint-to-match"
                and int(raw_proposal[0]) == 5
            ):
                # A witnessed non-progressing submit inhibits this assignment
                # and opens the next bounded structural hypothesis.
                self._paint_variant += 1
        except Exception:
            if os.environ.get("ARC_CONTRACT_REQUIRED", "") in ("1", "true", "True"):
                raise
        self._contract_last = None

    def _reset_level_memory(self):
        """Discard episode-local coordinates and graph ids at a level boundary.

        Contract's durable muscle remains intact; only references whose meaning
        depends on the previous board are reset.
        """
        self._arch = None
        self._plan = None
        self._pidx = 0
        self._last_plan_grid = None
        self._clickpts = None
        self._cidx = 0
        self._state_ids = {}
        self._cog_prev_state = None
        self._cog_prev_action = None
        self._contract_avail = None
        self._tried_proposals.clear()
        self._inhibited_proposals.clear()
        self._navigation_visited.clear()
        self._hypothesis_by_proposal.clear()
        self._paint_variant = 0
        try:
            if self._cog is not None and hasattr(self._cog, "cogmap_reset"):
                self._cog.cogmap_reset()
        except Exception:
            pass

    def _proposal_key(self, rows, action, x=None, y=None):
        return (
            (
                semantic_state_descriptor(rows)
                if self._contract is not None
                else _grid_key(rows)
            ),
            int(action),
            None if x is None else int(x),
            None if y is None else int(y),
        )

    def _take_untried(self, rows, proposals):
        """Return the first proposal not already fired against this exact state."""
        while proposals:
            action, x, y = proposals.pop(0)
            key = self._proposal_key(rows, action, x, y)
            episode_key = (self._current_level, int(action), x, y)
            if key in self._tried_proposals or episode_key in self._inhibited_proposals:
                continue
            self._tried_proposals.add(key)
            return action, x, y
        return None

    def _select_contract_action(self, context, avail):
        if self._contract is None or not avail:
            return None
        normalized = sorted(set(int(action) for action in avail))
        try:
            if normalized != self._contract_avail:
                self._contract.register_actions(normalized)
                self._contract_avail = normalized
            plan = self._contract.plan(context, normalized)
            self._contract_calls += 1
        except Exception:
            if os.environ.get("ARC_CONTRACT_REQUIRED", "") in ("1", "true", "True"):
                raise
            return None
        candidates = (plan or {}).get("candidates") or []
        if not candidates or candidates[0].get("status") != "verified_fresh":
            return None
        action = self._contract.recommended_action(plan)
        return action if action in normalized else None

    def _contract_experiment(self, context, avail, rows):
        """Select exploitation or one bounded cold-start experiment.

        Contract owns the ordering, evidence status, and durable recall. This
        host method only resolves episode-local coordinates and enforces that an
        unverified capability is tried at most once against an exact state.
        """
        if self._contract is None or not avail:
            return None
        candidates = [
            {
                "capability_id": NativeContract.capability_id(action),
                "label": f"action-{int(action)}",
                "description": (
                    "Test a coordinate click hypothesis against an unseen grid state"
                    if int(action) == 6
                    else f"Test discrete action {int(action)} and observe its transition"
                ),
                "action": int(action),
                "x": None,
                "y": None,
                "confidence": 0.10,
            }
            for action in sorted(set(int(value) for value in avail if int(value) != 6))
        ]
        navigation = None
        navigation_options = []
        if rows is not None and _MO is not None and hasattr(_MO, "navigation_actions"):
            try:
                navigation_options = _MO.navigation_actions(rows, self._navigation_visited)
                navigation = navigation_options[0] if navigation_options else None
            except Exception:
                navigation = None
        if navigation is not None and int(navigation) in {int(value) for value in avail}:
            alternatives = [int(value) for value in navigation_options]
            try:
                p = _perceive(rows)
                element = p.get("element")
                families = {}
                for obj in p.get("objects", []):
                    key = (int(obj.get("color", 0)), int(obj.get("size", 0)))
                    families[key] = families.get(key, 0) + 1
                rare = [
                    obj for obj in p.get("objects", [])
                    if 4 <= int(obj.get("size", 0)) <= 25
                    and families[(int(obj.get("color", 0)), int(obj.get("size", 0)))] == 1
                    and obj is not element
                ]
                if element is not None and rare:
                    ex, ey = element["centroid"]
                    target = max(
                        rare,
                        key=lambda obj: abs(obj["centroid"][0] - ex) + abs(obj["centroid"][1] - ey),
                    )
                    dx, dy = target["centroid"][0] - ex, target["centroid"][1] - ey
                    alternatives.extend([
                        4 if dx > 0 else 3 if dx < 0 else 0,
                        2 if dy > 0 else 1 if dy < 0 else 0,
                    ])
            except Exception:
                pass
            alternatives.extend([1, 2, 3, 4])
            alternatives = list(dict.fromkeys(
                action for action in alternatives
                if action in {int(value) for value in avail}
            ))
            structural = []
            for index, action in enumerate(alternatives):
                structural.append({
                    "capability_id": f"aiko-arc.hypothesis.navigate-rare-target.action-{action}",
                    "label": f"navigate-rare-target-action-{action}",
                    "description": (
                        "Move a controllable marker along a repeated traversable lattice "
                        "toward a rare aligned target; predict target distance decreases"
                    ),
                    "action": action,
                    "x": None,
                    "y": None,
                    "confidence": 0.85 - index * 0.05,
                    "hypothesis": "the rare aligned object is a goal on the traversable lattice",
                    "predicted_delta": {"target_distance": -1},
                })
            candidates[0:0] = structural
        if 6 in avail and rows is not None:
            candidates.extend(semantic_click_candidates(rows))
        if not candidates:
            return None
        planning_context = context
        if navigation is not None:
            planning_context += (
                ";observed controllable marker, repeated traversable lattice, "
                "and rare aligned target; test navigation hypothesis"
            )
        try:
            self._contract.register_candidates(candidates)
            plan = self._contract.plan_candidates(planning_context, candidates)
            self._contract_calls += 1
            recalled = self._contract.recall_binary(planning_context)
            self._contract_calls += 1
        except Exception:
            if os.environ.get("ARC_CONTRACT_REQUIRED", "") in ("1", "true", "True"):
                raise
            return None

        by_id = {candidate["capability_id"]: candidate for candidate in candidates}
        ranked = []
        if recalled in by_id:
            ranked.append((0, 0, by_id[recalled], "contract-recall"))
        status_order = {
            "verified_fresh": 0,
            "verified_stale": 1,
            "available_unverified": 2,
        }
        for index, item in enumerate((plan or {}).get("candidates") or []):
            candidate = by_id.get(item.get("capability_id"))
            status = item.get("status")
            if candidate is None or status not in status_order:
                continue
            # Capability verification is conditional evidence, not a global
            # blessing.  The native catalog can report that a generic action
            # succeeded elsewhere; until this semantic precondition itself has
            # grounded progress, treat it as a bounded experiment here.  This
            # prevents action-5 success in one archetype from preempting a novel
            # movement state merely because both expose action 5.
            if (
                status in {"verified_fresh", "verified_stale"}
                and (planning_context, candidate["capability_id"]) not in self._grounded_contexts
            ):
                status = "available_unverified"
            # For a cold tie, global episode usage is the curiosity energy:
            # probe the least-used capability instead of restarting at action 1
            # in every newly discovered state.
            uses = self._experiment_uses.get(candidate["capability_id"], 0)
            confidence = max(0.0, min(1.0, float(candidate.get("confidence", 0.0))))
            priority = status_order[status] - confidence
            usage_cost = 0 if confidence >= 0.5 else uses * 1000
            organ = "contract-structural-hypothesis" if confidence >= 0.5 else f"contract-{status}"
            ranked.append((priority, usage_cost + index, candidate, organ))

        seen = set()
        for _, _, candidate, organ in sorted(ranked, key=lambda item: (item[0], item[1])):
            capability = candidate["capability_id"]
            if capability in seen:
                continue
            seen.add(capability)
            action = int(candidate["action"])
            x, y = candidate.get("x"), candidate.get("y")
            proposal = self._proposal_key(rows, action, x, y)
            episode_key = (self._current_level, action, x, y)
            if proposal in self._tried_proposals or episode_key in self._inhibited_proposals:
                continue
            self._experiment_uses[capability] = self._experiment_uses.get(capability, 0) + 1
            self._experiment_attempts += 1
            self._hypothesis_by_proposal[proposal] = {
                "hypothesis": candidate.get("hypothesis"),
                "predicted_delta": candidate.get("predicted_delta"),
                "evidence_state": next(
                    (
                        item.get("status")
                        for item in ((plan or {}).get("candidates") or [])
                        if item.get("capability_id") == capability
                    ),
                    "available_unverified",
                ),
                "scope": "archetype",
            }
            return action, x, y, organ
        return None

    def _contract_grounded_recall(self, context, avail, rows):
        """Resolve a grounded durable reflex onto the current episode.

        Muscle recall now returns only capabilities with externally grounded
        success. This path may therefore exploit before a structural planner,
        while cold and merely transition-trained candidates remain in the
        bounded experiment graph below.
        """
        if self._contract is None or not avail:
            return None
        candidates = [
            {
                "capability_id": NativeContract.capability_id(action),
                "action": int(action),
                "x": None,
                "y": None,
            }
            for action in sorted(set(int(value) for value in avail if int(value) != 6))
        ]
        if 6 in avail and rows is not None:
            candidates.extend(semantic_click_candidates(rows))
        try:
            ranked = self._contract.rank_binary(context, limit=8)
            self._contract_calls += 1
        except Exception:
            if os.environ.get("ARC_CONTRACT_REQUIRED", "") in ("1", "true", "True"):
                raise
            return None
        grounded = [
            item
            for item in ((ranked or {}).get("candidates") or [])
            if int(item.get("successes", 0)) > 0
            and int(item.get("failures", 0)) == 0
            and float(item.get("context_energy", 0)) <= -0.80
        ]
        recalled = grounded[0].get("binary") if grounded else None
        candidate = next((item for item in candidates if item["capability_id"] == recalled), None)
        if candidate is None:
            return None
        if (context, recalled) not in self._grounded_contexts:
            return None
        action = int(candidate["action"])
        x, y = candidate.get("x"), candidate.get("y")
        proposal = self._proposal_key(rows, action, x, y)
        episode_key = (self._current_level, action, x, y)
        if proposal in self._tried_proposals or episode_key in self._inhibited_proposals:
            return None
        return action, x, y, "contract-grounded-recall"

    def _selected(self, action, x, y, organ, context, rows, levels):
        proposal = self._proposal_key(rows, action, x, y)
        self._tried_proposals.add(proposal)
        capability_id = NativeContract.capability_id(action) if NativeContract is not None else f"aiko-arc.action.{int(action)}"
        if int(action) == 6 and x is not None and y is not None:
            for candidate in semantic_click_candidates(rows):
                if (candidate["x"], candidate["y"]) == (int(x), int(y)):
                    capability_id = candidate["capability_id"]
                    break
        self._contract_last = (
            context,
            capability_id,
            semantic_state_descriptor(rows),
            int(levels),
            (int(action), None if x is None else int(x), None if y is None else int(y)),
            self._hypothesis_by_proposal.pop(proposal, None),
        )
        return (action, x, y, organ)

    def _select_semantic_click(self, context, rows):
        if self._contract is None:
            return None
        candidates = semantic_click_candidates(rows)
        if not candidates:
            return None
        try:
            self._contract.register_candidates(candidates)
            plan = self._contract.plan_candidates(context, candidates)
            self._contract_calls += 1
            top = ((plan or {}).get("candidates") or [])[:1]
            if not top or top[0].get("status") != "verified_fresh":
                return None
            capability = self._contract.recommended_capability(plan)
        except Exception:
            if os.environ.get("ARC_CONTRACT_REQUIRED", "") in ("1", "true", "True"):
                raise
            return None
        return next((candidate for candidate in candidates if candidate["capability_id"] == capability), None)

    def _intern_state(self, rows):
        """Map a frame's grid to a dense state id at the I/O edge (the agent's job); the MAP is native."""
        h = _grid_key(rows)
        sid = self._state_ids.get(h)
        if sid is None:
            sid = len(self._state_ids)
            self._state_ids[h] = sid
        return sid

    def _cogmap_decide(self, avail, rows):
        """The native cognitive-map decision for a novel 'explore' frame: curiosity (probe an untried
        action) then navigate-to-frontier. Returns (a, x, y) or None when the reachable map is
        exhausted (-> the LLM proposer takes over). cogmap owns the DISCRETE actions; click-action 6
        stays with the deterministic sweep (its coordinate space is finer than one logical action)."""
        if self._cog is None or rows is None:
            return None
        simple = [a for a in avail if a != 6]
        if not simple:
            return None
        try:
            state = self._intern_state(rows)
            if self._cog_prev_state is not None and self._cog_prev_action is not None:
                # observe the transition the PREVIOUS cogmap action produced (no-op -> marks it dead)
                if hasattr(self._cog, "cogmap_observe"):
                    self._cog.cogmap_observe(self._cog_prev_state, self._cog_prev_action, state)
                else:
                    self._cog.observe(self._cog_prev_state, self._cog_prev_action, state)
            if hasattr(self._cog, "cogmap_set_avail"):
                self._cog.cogmap_set_avail(state, simple)
                a = self._cog.cogmap_next(state)
            else:
                self._cog.set_available(state, simple)
                a = self._cog.next(state)
            if a is None or a < 0:
                self._cog_prev_state, self._cog_prev_action = None, None
                return None  # reachable map exhausted -> let the LLM propose toward the goal
            self._cog_prev_state, self._cog_prev_action = state, a
            return (a, 0, 0)
        except Exception:
            return None

    def _lewis_rank_once(self, ft):
        if self._lewis is not None:
            return self._lewis
        try:
            import lewis_route
            self._lewis = lewis_route.ranked_archetypes(ft[:400])
        except Exception:
            self._lewis = (None, None, None)
        return self._lewis

    def decide(self, frame):
        avail = list(getattr(frame, "available_actions", []) or [])
        rows = rows_of(frame)
        cur_levels = getattr(frame, "levels_completed", 0) or 0
        self._current_level = int(cur_levels)
        contract_context = self._contract_context(frame, rows)
        self._observe_contract_transition(frame, rows, contract_context)

        # TRAIN-ON-FIRE: did the last selector-chosen action raise levels (good) or end the game (bad)?
        if self._last_chosen:
            try:
                import select_sign
                if cur_levels > self._last_levels:
                    select_sign.fire_reward(self._last_chosen, 1.0, good=True, frame=self._last_ft or "")
                elif "GAME_OVER" in str(getattr(frame, "state", "")):
                    # pass the frame so the per-action EBM learns the INHIBITION too (this action
                    # lost on frames like this), not just the bad-output prototype.
                    select_sign.fire_reward(self._last_chosen, 1.0, good=False, frame=self._last_ft or "")
            except Exception:
                pass
        if cur_levels != self._last_levels:
            self._reset_level_memory()
        self._last_levels = cur_levels

        # ROUTER
        if self._arch is None:
            self._arch = classify(avail, rows)

        # A grounded reflex may preempt a proposer only when the current
        # coordinate-free semantic state exactly matches its pre-progress
        # context inside this episode.
        grounded = self._contract_grounded_recall(contract_context, avail, rows)
        if grounded is not None:
            action, x, y, organ = grounded
            self.from_aiko = False
            return self._selected(action, x, y, organ, contract_context, rows, cur_levels)

        # General parameterized-action explorer. In a click-only environment, probe salient
        # connected regions before falling back to uniform coverage. The planner consumes only
        # the current pixels and carries no game name, level rule, replay, or fixed coordinates.
        if self._arch == "region-control" and _region_plan is not None and rows is not None:
            grid_hash = hash(tuple(tuple(row) for row in rows))
            if self._plan is None or self._pidx >= len(self._plan):
                if grid_hash != self._last_plan_grid:
                    try:
                        self._plan = _region_plan(rows)
                    except Exception:
                        self._plan = None
                    self._pidx = 0
                    self._last_plan_grid = grid_hash
                else:
                    self._plan = None
            if self._plan and self._pidx < len(self._plan):
                remaining = list(self._plan[self._pidx:])
                chosen = self._take_untried(rows, remaining)
                self._pidx = len(self._plan) - len(remaining)
                if chosen is None:
                    self._plan = None
                else:
                    action, x, y = chosen
                    self.from_aiko = False
                    return self._selected(action, x, y, "structural-region-probe", contract_context, rows, cur_levels)

        # PLANNER -- the @contract paint-to-match neuron (general archetype solver, not memorized)
        if self._arch == "paint-to-match" and _paint_plan is not None and rows is not None:
            if self._plan is None or self._pidx >= len(self._plan):
                gh = hash(tuple(tuple(r) for r in rows))
                if gh != self._last_plan_grid:
                    try:
                        self._plan = (
                            _MO.paint_plan_hypothesis(rows, self._paint_variant)
                            if self._contract is not None
                            and _MO is not None
                            and hasattr(_MO, "paint_plan_hypothesis")
                            else _paint_plan(rows)
                        )
                    except Exception:
                        self._plan = None
                    self._pidx = 0
                    self._last_plan_grid = gh
                else:
                    self._plan = None  # same grid after a plan -> stuck -> let the LLM try
            if self._plan and self._pidx < len(self._plan):
                remaining = list(self._plan[self._pidx:])
                chosen = self._take_untried(rows, remaining)
                self._pidx = len(self._plan) - len(remaining)
                if chosen is not None:
                    a, x, y = chosen
                    self.from_aiko = False
                    return self._selected(a, x, y, "structural-paint-plan", contract_context, rows, cur_levels)
                self._arch = "explore"

        # EXECUTE-DON'T-GUESS: region-control prefers the deterministic click-sweep OVER the LLM.
        # Witnessed (faithful local engine, arcengine 0.9.3): tn36 clears@72 actions on the sweep,
        # but game-overs@61 when the active LLM takes over after region_plan exhausts. The LLM
        # interferes with the deterministic archetypes; it drives ONLY novel 'explore' games where
        # no deterministic solver exists. _clickpts is reset on every level change (above), so the
        # sweep re-derives its targets as the board advances.
        if self._arch == "region-control" and 6 in avail and rows is not None:
            if self._clickpts is None:
                self._clickpts = click_points(rows); self._cidx = 0
            if self._cidx < len(self._clickpts):
                px, py = self._clickpts[self._cidx]; self._cidx += 1
                self.from_aiko = False
                return self._selected(6, px, py, "region-sweep", contract_context, rows, cur_levels)

        # CONTRACT EXPERIMENT GRAPH -- after deterministic hypotheses with proven
        # preconditions, before the generic explorer. Cold candidates are bounded
        # experiments, not falsely verified actions. Durable recall and verified
        # evidence exploit first; curiosity balances the remaining cold probes.
        if self._arch == "explore":
            experiment = self._contract_experiment(contract_context, avail, rows)
            if experiment is not None:
                action, x, y, organ = experiment
                self.from_aiko = False
                return self._selected(action, x, y, organ, contract_context, rows, cur_levels)

        # EXPLORER -- the native cognitive map drives novel 'explore' games (the proven top-3
        # ARC-AGI-3 method: action-efficient coverage via curiosity + navigate-to-frontier). Placed
        # BEFORE the LLM proposer AND the lewis-rank reclassify: the deterministic archetypes already
        # returned above if they applied, so a router 'explore' verdict here is a genuinely novel game
        # with no deterministic solver -- exactly where the cognitive map wins. The LLM proposer below
        # is the FALLBACK only when the reachable map is exhausted (cogmap_next -> -1). The squared-RHAE
        # lever: cover the state space in the fewest actions, no flailing.
        if self._arch == "explore" and avail == [6] and rows is not None:
            # Click-only environments have a parameterized action space. Treat perceptual object
            # centroids followed by a coarse uniform cover as general probes; clicking the center
            # repeatedly discards virtually the entire legal action space.
            if self._clickpts is None:
                self._clickpts = click_points(rows)
                self._cidx = 0
            if self._cidx < len(self._clickpts):
                px, py = self._clickpts[self._cidx]
                self._cidx += 1
                self.from_aiko = False
                return self._selected(6, px, py, "click-space-explore", contract_context, rows, cur_levels)

        if self._arch == "explore":
            ce = self._cogmap_decide(avail, rows)
            if ce is not None:
                a, x, y = ce
                self._last_chosen = '{"a":%d}' % a
                self.from_aiko = False
                return self._selected(a, x, y, "cogmap-explore", contract_context, rows, cur_levels)

        # Contract is durable verified recall, not the first exploratory proposer. Consult it
        # only after the state-local cognitive map has exhausted untried discrete actions.
        contract_action = self._select_contract_action(contract_context, avail)
        if contract_action is not None:
            if contract_action == 6 and rows is not None:
                candidate = self._select_semantic_click(contract_context, rows)
                if candidate is not None:
                    return self._selected(6, candidate["x"], candidate["y"], "contract-ebm", contract_context, rows, cur_levels)
            else:
                return self._selected(contract_action, None, None, "contract-ebm", contract_context, rows, cur_levels)

        # PROPOSER + SELECTOR -- the LLM proposes; the native EBM+jepa selector vets + signs the winner
        ft = frame_text(frame)
        lr = self._lewis_rank_once(ft) if LEGACY_HEURISTICS else None
        if lr and lr[0]:
            ft = ("lewis-strategy archetype ranking (try top first; scripture+relevance, confidence=%s): %s\n%s"
                  % (lr[1], ", ".join(lr[0]), ft))
            if self._arch == "explore" and lr[1] == "high":
                self._arch = lr[0][0]
        self._last_ft = ft
        # MECHANICAL: skip the vLLM subprocess entirely - the native EBM+jepa selector still vets the
        # candidate set (native recall + fallback), so the decision stays purely on the /contract organs.
        reply = "" if MECHANICAL else _ask_aiko(ft)
        fallback = '{"a":%d}' % (avail[0] if avail else 1)
        # CANDIDATE SET for the native EBM+jepa selector: the LLM reply + the learned native
        # proposer-assist (recall the historically-winning action for frames like this -- no LLM
        # call, generalizes across turns/games via the ledger-backed prototype) + the fallback.
        # Feeding a REAL set (not [reply, trivial]) is what lets the witnessed selector actually
        # bite; the EBM good/bad route + jepa rerank vet the recall against the LLM, so a wrong
        # recall is harmless and a right one is a free win the LLM didn't have to find.
        cands = [reply]
        try:
            import select_sign
            rn = select_sign.recall_action(ft, avail)
            if rn is not None:
                if rn == 6 and rows is not None:        # action 6 needs a click; pair with a sweep point
                    if self._clickpts is None:
                        self._clickpts = click_points(rows); self._cidx = 0
                    if self._cidx < len(self._clickpts):
                        px, py = self._clickpts[self._cidx]
                        cands.append('{"a":6,"x":%d,"y":%d}' % (px, py))
                else:
                    cands.append('{"a":%d}' % rn)
            cands.append(fallback)
            chosen, self.signed_ref = select_sign.select_and_sign(ft, cands)
        except Exception:
            chosen, self.signed_ref = reply, None
        self._last_chosen = chosen
        a, x, y, parsed = parse_action(chosen, avail)
        self.from_aiko = parsed and chosen == reply
        if parsed:
            return self._selected(a, x, y, "llm+select", contract_context, rows, cur_levels)

        # SWEEP -- only after the LLM returns nothing parseable (the dead-LLM case)
        if 6 in avail and rows is not None:
            if self._clickpts is None:
                self._clickpts = click_points(rows); self._cidx = 0
            if self._cidx < len(self._clickpts):
                px, py = self._clickpts[self._cidx]; self._cidx += 1
                self.from_aiko = False
                return self._selected(6, px, py, "click-sweep", contract_context, rows, cur_levels)
        return self._selected(a, x, y, "fallback", contract_context, rows, cur_levels)
