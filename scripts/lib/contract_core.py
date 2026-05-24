#!/usr/bin/env python3
"""
contract_core.py — data model for /contract skill.
The sole reader and writer of the contract ledger (direct JSONL I/O).

Store resolution (first match wins):
  1. $CONTRACTS_STORE env var (explicit override)
  2. <cwd>/.claude/contracts.jsonl  — if <cwd>/.claude/ directory exists (project scope)
  3. ~/.contracts/contracts.jsonl   — global fallback
"""
import json, os, subprocess, sys, uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# corrupt-line warnings are deduped per process so one bad row is
# reported once, not once per ledger re-read.
_WARNED_LINES: set = set()
_AGENT_CACHE: Optional[str] = None
_TEAM_CACHE: Optional[set] = None  # Σ2 team set, derived from agent column
_ALIAS_CACHE: Optional[dict] = None  # Σ3 identity → canonical map, derived from alias rows


def _resolve_ledger() -> Path:
    """Resolve ledger path: env override > project .claude/ > global fallback."""
    if env := os.environ.get("CONTRACTS_STORE"):
        return Path(env)
    project_dir = Path.cwd() / ".claude"
    if project_dir.is_dir():
        return project_dir / "contracts.jsonl"
    return Path.home() / ".contracts" / "contracts.jsonl"


def _ledger() -> Path:
    return _resolve_ledger()


# ── Per-contract folder substrate ─────────────────────────────────────────────
# Each contract has a folder at ~/.contracts/contracts.d/<id>/ that holds
# mutable state co-located with the contract: drive.json (replaces the four
# global drive sidecars), cwd.txt (record of the arming directory), and
# artifacts/ (sub-agent transcripts, screenshots, gate logs). The ledger
# remains the append-only event log / identity layer; folders are the cell
# membrane where mutable, per-contract state lives. Multiple contracts can
# be armed concurrently because their drive state is per-folder, not a
# global singleton. Folders are GLOBAL keyed by contract id so a drive
# armed in project A and a drive armed in project B coexist.
def contracts_d_root() -> Path:
    """Root directory for per-contract folders. Always under ~/.contracts/."""
    return Path.home() / ".contracts" / "contracts.d"


def contract_dir(contract_id: str, *, create: bool = True) -> Path:
    """Return ~/.contracts/contracts.d/<id>/ for a contract; mkdir by default.

    The folder is the per-contract substrate for mutable state and artifacts.
    The ledger remains the truth substrate for events; folders never overwrite
    or replace ledger rows.
    """
    if not contract_id or "/" in contract_id or "\\" in contract_id:
        raise ValueError(f"invalid contract id: {contract_id!r}")
    d = contracts_d_root() / contract_id
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d

def _load_prefs() -> dict:
    """Effective preferences: global ~/.contracts/prefs.json merged with project .claude/contract-prefs.json."""
    global_path = Path.home() / ".contracts" / "prefs.json"
    project_path = Path.cwd() / ".claude" / "contract-prefs.json"
    prefs: dict = {}
    for p in (global_path, project_path):
        if p.exists():
            try:
                prefs.update(json.loads(p.read_text()))
            except (json.JSONDecodeError, OSError) as e:
                print(f"contract: WARNING preferences file {p} could not be "
                      f"read and was ignored: {e}", file=sys.stderr)
    return prefs

def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _infer_pointer_type(action: str) -> str:
    if action in ("agent-judges",):
        return "agent-judges"
    if action in ("children-satisfy", "funnel"):
        return "funnel"
    if action == "funnel-first":
        return "funnel-first"
    if action == "sequence":
        return "sequence"
    if action.startswith("quorum:"):
        return "quorum"
    if action.startswith("contract:"):
        return "contract-ref"
    if action.startswith("loop-until:") or action == "loop":
        return "loop"
    if action.startswith("harness:"):
        return "harness"
    if action.startswith("tool-guard:"):
        return "tool-guard"
    if action.startswith("x402:"):
        return "x402"
    if action.startswith("agent:"):
        return "agent"
    if action.startswith("machine:"):
        return "machine"
    if action.startswith("sandbox:"):
        return "sandbox"
    if action.startswith("runpod:"):
        return "runpod"
    if action.startswith(("curl ", "http://", "https://", "wget ")):
        return "api"
    return "cli"


def _infer_layer(action: str) -> int:
    """Π5 — derive a contract's layer from its pointer-type.

    The substrate's six effective tiers, top → bottom:
      L6 operator   — agent:<id> routes work to a named human/agent
      L5 value      — x402:<url> payment-gated calls
      L4 transport  — wait-for-event.py over inbox/* (receptors)
      L3 graph      — composition + judgments + contract-ref (substrate-internal)
      L2 cell       — cli/api/harness/loop-until/tool-guard (mechanical checks)
      L1 system     — machine:<bin> (host-local binaries) · sandbox:<image>:<intent>
                      (turbobox remote-container) · runpod:<endpoint>:<intent>
                      (RunPod serverless — same L1 role, third backend)

    Pointer-types map deterministically. The substrate layers fall out of
    pointer-types that already exist; Π5 doesn't add seams, it names them.

    Existing rows without a layer field are inferred at read time (legacy
    compatibility — the 184+ rows declared before Π5 keep working).
    """
    pt = _infer_pointer_type(action)
    # Receptor convention: cli action invoking wait-for-event.py → transport
    if pt == "cli" and "wait-for-event" in action:
        return 4  # transport
    return {
        "agent":         6,  # operator
        "x402":          5,  # value
        "agent-judges":  3,  # graph (composition's bottom — agent KEY 2)
        "funnel":        3,
        "funnel-first":  3,
        "sequence":      3,
        "quorum":        3,
        "contract-ref":  3,
        "cli":           2,  # cell — the catch-all
        "api":           2,  # cell — HTTP call
        "harness":       2,  # cell — delegates to verify.sh
        "loop":          2,
        "tool-guard":    2,
        "machine":       1,  # system — host binary
        "sandbox":       1,  # system — remote container binary (Χ6)
    }.get(pt, 2)


_LAYER_NAMES = {1: "system", 2: "cell", 3: "graph", 4: "transport", 5: "value", 6: "operator"}


def layer_name(layer: int) -> str:
    return _LAYER_NAMES.get(int(layer), f"layer{layer}")


def current_agent() -> str:
    """Best-effort attribution for ledger rows.

    Sociology default Σ1: every row can be traced to the agent/operator that
    emitted it. CONTRACT_AGENT is explicit; git email is a stable local
    fallback. Empty means "unknown" rather than a fabricated identity.
    """
    global _AGENT_CACHE
    if _AGENT_CACHE is not None:
        return _AGENT_CACHE
    if agent := os.environ.get("CONTRACT_AGENT", "").strip():
        _AGENT_CACHE = agent
        return agent
    try:
        r = subprocess.run(["git", "config", "user.email"], capture_output=True,
                           text=True, timeout=1)
        _AGENT_CACHE = r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        _AGENT_CACHE = ""
    return _AGENT_CACHE


def plan_quality_warning(plan: str) -> str:
    """Α1: surface task-shaped plans that do not name a truth claim."""
    import re
    p = " ".join((plan or "").strip().split())
    if len(p) < 24:
        return "plan text reads as a task, not a truth claim — does it name what must hold?"
    if re.match(r"^(do|fix|build|implement)\s+\S.{0,80}$", p, re.I):
        return "plan text reads as a task, not a truth claim — does it name what must hold?"
    return ""


def humanlike_iterate_warnings(id: str) -> list[str]:
    """Ε1/Ε2 salience signals derived from the latest evaluation streak.

    An *evaluation* is either an `iterated` event (the action actually fired)
    or a `cached` event (the 10s sliding-window cache returned a prior wave's
    result for the same key). Cache hits carry `action_exit` copied from the
    source wave, so they continue the streak with the same exit polarity —
    treating them as virtual iterations preserves Ε1/Ε2 semantics under the
    cache layer (contract 3c2deda3)."""
    rows = [r for r in _rows() if r.get("id") == id]
    if any(r.get("event") == "satisfied" for r in rows):
        return []
    eval_rows = [r for r in rows if r.get("event") in ("iterated", "cached")]
    if not eval_rows:
        return []
    last_pass = int(eval_rows[-1].get("action_exit", 1)) == 0
    streak = 0
    for r in reversed(eval_rows):
        is_pass = int(r.get("action_exit", 1)) == 0
        if is_pass != last_pass:
            break
        streak += 1
    if streak < 3:
        return []
    if last_pass:
        return [
            f"over-iteration warning: PASS streak={streak} without _mark — what specific risk are you still checking for?"
        ]
    return [
        f"failure-streak escalation: FAIL streak={streak} — escalate (spawn child, revise action, supersede) or abandon (retire/reject)."
    ]


def _cloud_mirror(row: dict) -> None:
    """Best-effort POST of one ledger row to the cloud-canonical substrate
    at unbrowse, when CONTRACT_REMOTE is set. Fire-and-forget: a failed
    POST never blocks the local write, and a non-200 response is logged
    to ~/.contracts/cloud-mirror-errors.jsonl but doesn't raise.

    Pairs with the cloud-side resolver in unbrowse's
    backend/src/services/contract-ledger-postgres.ts (commit e4b620d4):
    the route at POST /v1/contract/declare or /v1/contract/iterate
    receives this row, picks postgresLedger() when DATABASE_URL is set,
    appends to contract_events keyed by (namespace='contracts:'+agent_id,
    event_id) so duplicate POSTs collapse via ON CONFLICT.

    Local file remains the source of truth UNTIL the cloud is verified
    to hold the row — this is the safe-migration phase. Phase 2 will
    flip reads to cloud-canonical with local-cache; phase 1 (this) is
    write-mirror only.
    """
    remote = os.environ.get("CONTRACT_REMOTE", "").strip()
    if not remote:
        return
    api_key = os.environ.get("UNBROWSE_API_KEY", "").strip()
    if not api_key:
        # Try the canonical file location
        key_file = Path.home() / ".config" / "unbrowse" / "api-key"
        if key_file.exists():
            api_key = key_file.read_text().strip()
    if not api_key:
        # Silently skip — the user hasn't authenticated yet. Local
        # ledger still works; cloud mirror requires auth.
        return

    # Pick the right endpoint based on the event type. declared/iterated
    # have first-class routes; other events post as a generic ledger
    # append (the cloud's contract_events table accepts any event row).
    event = row.get("event", "")
    if event == "declared":
        path = "/v1/contract/declare"
        body = {
            "plan": row.get("plan", ""),
            "action": row.get("action", ""),
            "pointer_type": row.get("pointer_type"),
            "parent_id": row.get("parent_id"),
            "agent": row.get("agent"),
            "learning": row.get("learning"),
        }
    elif event == "iterated":
        path = "/v1/contract/iterate"
        body = {
            "id": row.get("id"),
            "agent": row.get("agent"),
        }
    else:
        # Generic events (satisfied, merged, spawned, judged, etc) — no
        # current route at unbrowse. Phase 1: log them locally pending
        # the /v1/contract/append-event route. The local ledger still
        # has them; phase 2 ships the generic-append route.
        return

    import urllib.request as _req
    import urllib.error as _err
    url = remote.rstrip("/") + path
    try:
        req = _req.Request(
            url,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            data=json.dumps(body).encode("utf-8"),
        )
        # Tight timeout — the cloud mirror is fire-and-forget; the local
        # write has already succeeded by the time this runs.
        _req.urlopen(req, timeout=5).read()
    except (_err.URLError, _err.HTTPError, OSError) as exc:
        # Log honestly, never raise. Phase 2 can build a retry queue from
        # this file. Phase 1 just records what didn't make it.
        err_file = Path.home() / ".contracts" / "cloud-mirror-errors.jsonl"
        err_file.parent.mkdir(parents=True, exist_ok=True)
        try:
            with err_file.open("a") as f:
                f.write(json.dumps({
                    "ts": _now(),
                    "url": url,
                    "event": event,
                    "id": row.get("id"),
                    "error": str(exc)[:200],
                }) + "\n")
        except Exception:
            pass  # last-resort silent failure — never block the local write


def _append(row: dict) -> None:
    if "agent" not in row:
        row["agent"] = current_agent()
    ledger = _ledger()
    ledger.parent.mkdir(parents=True, exist_ok=True)
    with ledger.open("a") as f:
        f.write(json.dumps(row) + "\n")
    # Best-effort cloud mirror — runs only when CONTRACT_REMOTE is set.
    # Never raises; local write is canonical until phase 2 flips reads.
    _cloud_mirror(row)


def _rows() -> list[dict]:
    return _rows_from_path(_ledger())



def declare(plan: str, action: str, parent_id: Optional[str] = None,
            pointers: list = None, learning: str = None,
            budget: Optional[int] = None, bind_to: Optional[str] = None,
            inverted_from: Optional[str] = None,
            inhibits: Optional[list] = None,
            audience: Optional[list] = None,
            layer: Optional[int] = None,
            pierced_layers: Optional[list] = None) -> str:
    """Declare a contract.

    bind_to: optional surface the contract is intrinsically scoped to —
    a file path, glob, symbol, or event tag. When 'contract verify <surface>'
    fires, every contract whose bind_to matches is re-iterated. This makes
    a contract a constraint on a specific surface (lock-and-key binding,
    biology / foreign-key constraint, programming) rather than a free-floating
    truth-claim. Contract ae1340a6.

    inhibits: optional list of contract ids this contract suppresses. Biology
    read: an inhibitory neuron (this contract, when satisfied) blocks
    downstream firing of every target contract. _mark satisfied on a target
    is refused while any inhibitor of that target is itself satisfied.
    Substrate-level negative regulation, distinct from supersession (lifecycle)
    and tool-guard (capability). Contract d830f26e.

    audience: optional list of viewer identities this contract is visible to
    via `contract list --for <viewer>`. Σ2 doctrine — the dual of Σ1 attribution
    (who wrote it) is audience (who reads it). Conventions:
        None       → field absent on row; public, visible to every viewer
        ["public"] → explicit public marker (same effect as None, but loud)
        ["lewis@…", "foundry_aiko_bot"] → only those identities see it
    The substrate filters at the QUERY layer (list/dag) — raw ledger access
    is unrestricted; this is a transport gate, not encryption. Pairs with
    the agent field to give "who wrote it, who reads it". Designed for the
    tg-pod and other transports that surface ledger rows to identities
    different from the declarer. Substrate enables; the agent picks the
    audience list at declare time."""
    cid = str(uuid.uuid4())[:8]
    # Π5 — layer is either explicit (--layer N) or inferred from pointer-type.
    # Pierced layers (the agent's explicit cross-layer authorizations) are
    # stored on the row so iterate-time enforcement can consult them.
    resolved_layer = int(layer) if layer is not None else _infer_layer(action)
    row = {"event": "declared", "id": cid, "plan": plan, "action": action,
           "pointer_type": _infer_pointer_type(action),
           "layer": resolved_layer,
           "cwd": os.getcwd(),
           "parent_id": parent_id, "pointers": pointers or [],
           "ts": _now()}
    if pierced_layers:
        row["pierced_layers"] = [int(L) for L in pierced_layers]
    if learning:
        row["learning"] = learning
    if budget:
        row["budget"] = int(budget)
    if bind_to:
        row["bind_to"] = bind_to
    if inverted_from:
        row["inverted_from"] = inverted_from
    if inhibits:
        row["inhibits"] = list(inhibits)
    if audience:
        # Empty list means "audience field intentionally omitted = public".
        # A list with one or more identities restricts visibility to those.
        row["audience"] = list(audience)
    _append(row)
    if parent_id:
        _append({"event": "child_added", "id": parent_id, "child_id": cid, "ts": _now()})
    return cid


def record_alias(canonical: str, aliases: list) -> None:
    """Σ3: declare an identity equivalence class.

    Writes one `alias` event row mapping `canonical` to every identity in
    `aliases`. Resolution is union-find — declaring (A, B) and later (B, C)
    yields the canonical A for all three. The 'canonical' name from the
    most-recent row covering a group wins as the public-facing identity.

    The bot's `--for foundry_aiko_bot` resolves to whatever canonical the
    bot was aliased into (or stays itself if never aliased). Lewis's three
    aliases (lewistham9x@gmail / lewis@getfoundry.app / lekt8) collapse to
    one ledger-team-member after one `contract alias` call."""
    row = {"event": "alias", "canonical": canonical, "aliases": list(aliases), "ts": _now()}
    _append(row)
    # Bust the caches so the next visibility query sees the new alias.
    global _TEAM_CACHE, _ALIAS_CACHE
    _TEAM_CACHE = None
    _ALIAS_CACHE = None


def _build_alias_map() -> dict:
    """Walk every `alias` event row and union-find them into an identity →
    canonical map. Returns a dict where every identity that has ever
    appeared in an alias row maps to its group's canonical name.

    Algorithm:
      1. For each alias row, treat (canonical, *aliases) as a set; union
         them all into one group.
      2. The canonical name from the most-recent row covering the group
         wins (later declarations supersede earlier ones for the public
         identity, but no identity is ever lost — supersession of names
         only, not of membership).
    Identities not in any alias row resolve to themselves at query time
    (handled by resolve_identity)."""
    parent: dict = {}
    def find(x: str) -> str:
        # path-compression in one pass
        root = x
        while parent.get(root, root) != root:
            root = parent[root]
        while parent.get(x, x) != root:
            nxt = parent[x]
            parent[x] = root
            x = nxt
        return root
    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
    declared_canon: dict = {}
    for row in _rows():
        if row.get("event") != "alias":
            continue
        canon = (row.get("canonical") or "").strip()
        aliases = [a for a in (row.get("aliases") or []) if a]
        if not canon:
            continue
        for ident in [canon, *aliases]:
            parent.setdefault(ident, ident)
        for a in aliases:
            union(canon, a)
        rep = find(canon)
        declared_canon[rep] = canon  # latest declaration wins for the group's name
    result: dict = {}
    for ident in list(parent.keys()):
        rep = find(ident)
        result[ident] = declared_canon.get(rep, ident)
    return result


def resolve_identity(identity: Optional[str]) -> str:
    """Σ3: map any identity to its canonical form via alias rows.
    Identities not aliased return themselves. Empty/None → empty string."""
    if not identity:
        return ""
    global _ALIAS_CACHE
    if _ALIAS_CACHE is None:
        _ALIAS_CACHE = _build_alias_map()
    return _ALIAS_CACHE.get(identity, identity)


def visible_to(contract_or_row: dict, viewer: Optional[str]) -> bool:
    """Σ2: is this contract/row visible to `viewer`?

    Three-tier audience model (Lewis 2026-05-23). Tiers and explicit
    identities can be mixed in the audience list:

      "public"          — visible to any viewer
      "team"            — visible to any viewer in the ledger team set
                          (derived from agents that have ever declared
                          a row; see is_team_member)
      "private"         — visible only to the declarer (row.agent == viewer)
      "<identity>"      — visible to that specific viewer

    Rules in order:
      - viewer is None/empty                     → True (no filter)
      - row has no `audience` field              → treat as ["team"]
      - audience contains "public"               → True
      - audience contains "private" AND viewer
        == declarer (row.agent)                  → True
      - audience contains "team" AND viewer is
        a known team member (is_team_member)     → True
      - viewer string in audience                → True
      - else                                     → False

    Default = team: every legacy row (0 audience field) is team-visible.
    The bot (an external transport without an agent identity in the
    ledger) is NOT team by default — it only sees rows tagged public OR
    explicitly addressed to it. That gives the safety floor the tg-pod
    needs without any backfill of legacy data."""
    if not viewer:
        return True
    audience = contract_or_row.get("audience") or ["team"]
    if "public" in audience:
        return True
    # Σ3 alias resolution: compare canonical forms so a viewer that goes
    # by lekt8 still matches a row declared by lewis@getfoundry.app once
    # `contract alias` has linked them.
    canon_viewer = resolve_identity(viewer)
    canon_declarer = resolve_identity(contract_or_row.get("agent") or "")
    if "private" in audience and canon_viewer == canon_declarer and canon_viewer:
        return True
    if "team" in audience and is_team_member(viewer):
        return True
    # Explicit identity audience: try both canonical and raw forms so
    # legacy explicit-id audiences (declared before aliasing) still resolve.
    if canon_viewer in audience or viewer in audience:
        return True
    return False


def _team_cache() -> set:
    """Compute the set of team identities from the ledger's agent column.
    Any identity that has ever declared a contract counts as team. This is
    the natural overlap with Σ1: who wrote things, IS the team. No extra
    config file. New members "join" by declaring their first contract.

    Cached at module load; safe across the short-lived CLI invocations.
    Reset by re-importing or by clearing _TEAM_CACHE in tests.

    Σ3-aware: every agent identity is canonicalized via resolve_identity
    before joining the team set, so an alias chain (lewis@gmail = lewis@foundry
    = lekt8) contributes ONE team member, not three. is_team_member resolves
    the viewer the same way."""
    global _TEAM_CACHE
    if _TEAM_CACHE is not None:
        return _TEAM_CACHE
    members = set()
    for row in _rows():
        if row.get("event") == "declared":
            agent = (row.get("agent") or "").strip()
            if agent:
                members.add(resolve_identity(agent))
    # NOTE: previously also auto-added current_agent() here so first-time
    # callers were implicitly team. That created a Σ5 security hole — any
    # stranger could set CONTRACT_AGENT and invite themselves into the
    # allowlist on first run. The team set is now strictly the agent
    # column (people who have actually declared a contract) UNION the
    # invitee set (people an existing team member explicitly invited via
    # `contract invite`). Bootstrap path: declare your first contract to
    # join the column; thereafter you're team.
    _TEAM_CACHE = members
    return members


def is_team_member(viewer: str) -> bool:
    """True iff viewer's canonical identity (Σ3 alias-resolved) is either:
      - in the agent column (has declared a contract) — original team source
      - OR is an invitee in any `invite` row — the viral allowlist (Σ5)

    The bot is NOT a team member unless its identity (or one of its aliases)
    appears in either set."""
    if not viewer:
        return False
    canon = resolve_identity(viewer)
    if canon in _team_cache():
        return True
    # Σ5 extension: invitees are allowlisted into the team set once they
    # have at least one `invite` row pointing to them. Inviter must already
    # be team (enforced at record_invite time), so the chain stays clean.
    return canon in _invitee_cache()


# ── Σ5: invite-cap allowlist ──
_INVITEE_CACHE: Optional[set] = None
INVITE_CAP_PER_INVITER = 2  # "give access to 2 more people" (Lewis 2026-05-23)


def _invitee_cache() -> set:
    """Set of canonical identities that have been invited by an existing
    team member. Σ3-canonicalized so an invitee's aliases resolve to the
    same membership.

    Reset by `record_invite` after every write (cache busts via the same
    pattern as _TEAM_CACHE/_ALIAS_CACHE)."""
    global _INVITEE_CACHE
    if _INVITEE_CACHE is not None:
        return _INVITEE_CACHE
    invitees = set()
    for row in _rows():
        if row.get("event") == "invite":
            inv = (row.get("invitee") or "").strip()
            if inv:
                invitees.add(resolve_identity(inv))
    _INVITEE_CACHE = invitees
    return invitees


def count_invites_by(inviter: str) -> int:
    """How many active `invite` rows name this inviter (Σ3-canonicalized).
    A row that has been superseded does NOT count — selection lets an
    inviter swap one invitee for another without burning a slot. Active =
    not present in the merged-rows set."""
    if not inviter:
        return 0
    canon_inviter = resolve_identity(inviter)
    # Build merged-out set once so superseded rows are excluded.
    merged_out = set()
    for row in _rows():
        if row.get("event") == "merged" and row.get("id"):
            merged_out.add(row["id"])
    count = 0
    for row in _rows():
        if row.get("event") != "invite":
            continue
        if row.get("invite_id") in merged_out:
            continue
        if resolve_identity(row.get("inviter") or "") == canon_inviter:
            count += 1
    return count


def record_invite(invitee: str) -> tuple[str, str]:
    """Σ5 — record an invite from current_agent() to <invitee>.

    Enforced rules (refused with ValueError if violated):
      1. The inviter (current canonical) MUST be a team member (Σ2 sense:
         in the agent column OR already an invitee). Bootstraps from the
         declarer set; no invite from a stranger.
      2. The inviter MUST have fewer than INVITE_CAP_PER_INVITER active
         invites already (default 2). Superseded invites don't count.
      3. The invitee MUST NOT already be a team member or invitee — no
         re-inviting an existing member; supersession is the explicit
         path to swap.
      4. inviter != invitee (Σ3-canonical). No self-invites.

    Returns (invite_row_id, inviter_canonical) on success. The row has a
    unique `invite_id` field separate from `id` so the standard `id`-keyed
    walkers don't accidentally collide with declared contract ids."""
    inviter = current_agent()
    if not inviter:
        raise ValueError("no current_agent — set CONTRACT_AGENT or git config user.email")
    canon_inviter = resolve_identity(inviter)
    canon_invitee = resolve_identity(invitee) if invitee else ""
    if not canon_invitee:
        raise ValueError("invitee identity is required")
    if canon_inviter == canon_invitee:
        raise ValueError(f"can't invite yourself ({canon_inviter})")
    # Rule 1: inviter must be team
    if not is_team_member(inviter):
        raise ValueError(
            f"inviter {canon_inviter!r} is not a team member — "
            "only allowlisted users can invite (Σ5 bootstrap)"
        )
    # Rule 3: invitee must not already be in the allowlist
    if is_team_member(invitee):
        raise ValueError(
            f"invitee {canon_invitee!r} is already a team member or invitee — "
            "supersede the existing invite to swap"
        )
    # Rule 2: inviter must not be at the cap
    used = count_invites_by(inviter)
    if used >= INVITE_CAP_PER_INVITER:
        raise ValueError(
            f"inviter {canon_inviter!r} has {used}/{INVITE_CAP_PER_INVITER} "
            f"active invites — cap reached (supersede an existing invite to free a slot)"
        )
    invite_id = str(uuid.uuid4())[:8]
    row = {
        "event": "invite",
        "invite_id": invite_id,
        "inviter": canon_inviter,
        "invitee": canon_invitee,
        "ts": _now(),
    }
    _append(row)
    # Bust both caches: a new invitee joins the team set, and the invitee
    # cache obviously needs the new row.
    global _TEAM_CACHE, _INVITEE_CACHE
    _TEAM_CACHE = None
    _INVITEE_CACHE = None
    return invite_id, canon_inviter


def active_inhibitors(target_id: str) -> list[str]:
    """Return ids of contracts that inhibit `target_id` and are currently satisfied.

    Biology: returns the list of inhibitory neurons currently firing on the
    target. An empty list means the target is free to fire (no active
    suppression). A non-empty list means `_mark satisfied` must refuse.
    """
    inhibitors = []
    for row in _rows():
        if row.get("event") != "declared":
            continue
        inh = row.get("inhibits") or []
        if target_id in inh:
            inhibitor_id = row["id"]
            inh_contract = get(inhibitor_id)
            if inh_contract and inh_contract.get("status") == "satisfied":
                inhibitors.append(inhibitor_id)
    return inhibitors
def record_iteration(id: str, wave: int, action_exit: int, action_result: str,
                     agent_verdict: Optional[str], children_spawned: list,
                     log_path: str = "") -> None:
    _append({"event": "iterated", "id": id, "wave": wave, "action_exit": action_exit,
             "action_result": action_result, "agent_verdict": agent_verdict,
             "children_spawned": children_spawned, "log_path": log_path, "ts": _now()})


def record_event(event: str, id: str, **fields) -> None:
    """Append an arbitrary typed event row to the ledger.

    Use for substrate verbs (pre-mortem, baserate, etc.) whose evidence must
    be queryable later but doesn't fit declared/iterated/satisfied/merged.
    The agent judges semantics; the substrate only records the trail.
    """
    row = {"event": event, "id": id, "ts": _now()}
    for k, v in fields.items():
        row[k] = v
    _append(row)


def mark_satisfied(id: str, wave: int, proof: str | None = None, proof_skip_reason: str | None = None) -> None:
    """Append a satisfied row. One of `proof` (plan-fulfillment evidence)
    or `proof_skip_reason` (explicit opt-out) should be present; both None
    is permitted for callers that handle the requirement at the CLI layer
    (the contract bash script enforces the bare-mark refusal)."""
    row = {"event": "satisfied", "id": id, "wave": wave, "ts": _now()}
    if proof is not None:
        row["proof"] = proof
    if proof_skip_reason is not None:
        row["proof_skip_reason"] = proof_skip_reason
    _append(row)


def mark_status(id: str, status: str) -> None:
    _append({"event": "status_update", "id": id, "status": status, "ts": _now()})


def corroborate(id1: str, id2: str, label: str = "") -> None:
    """Record a bidirectional corroboration edge (synapse) between two contracts."""
    _append({"event": "corroborated", "id": id1, "corroborates": id2, "label": label, "ts": _now()})


def get_corroborations(id: str) -> list[str]:
    """Return IDs corroborating (or corroborated by) the given contract (bidirectional)."""
    result = []
    for row in _rows():
        if row.get("event") == "corroborated":
            if row.get("id") == id:
                result.append(row["corroborates"])
            elif row.get("corroborates") == id:
                result.append(row["id"])
    return list(dict.fromkeys(result))  # deduplicate, preserve order


def merge_into(source_id: str, target_id: str, reason: str = "") -> None:
    """Mark source_id as superseded by target_id (cell fusion / apoptosis)."""
    _append({"event": "merged", "id": source_id, "merged_into": target_id, "reason": reason, "ts": _now()})




def record_learning(text: str, source: Optional[str] = None) -> str:
    """Append a `learned` event - an explicit `contract learn` insight that
    is not tied to a contract's satisfaction. Returns the new learning id."""
    lid = str(uuid.uuid4())[:8]
    row = {"event": "learned", "id": lid, "text": text, "ts": _now()}
    if source:
        row["source"] = source
    _append(row)
    return lid


def record_crystallization(id: str, memory_path: str = "",
                           outline_url: str = "") -> None:
    """Append a `crystallized` event - the durable record that a learning
    (a satisfied learning-contract, or a `learned` event) was emitted to a
    memory file and/or an Outline doc. This row is the idempotency key."""
    _append({"event": "crystallized", "id": id,
             "memory_path": memory_path or "", "outline_url": outline_url or "",
             "ts": _now()})


def is_crystallized(id: str) -> bool:
    """True when a `crystallized` event already exists for this id."""
    return any(r.get("event") == "crystallized" and r.get("id") == id
               for r in _rows())

def revise(id: str, new_action: str, reason: str = "") -> None:
    """Append an action revision; future iterates use new_action (membrane update)."""
    _append({"event": "revised", "id": id, "new_action": new_action, "reason": reason, "ts": _now()})



def get(id: str) -> Optional[dict]:
    all_rows = _rows()
    declared = next((r for r in all_rows if r.get("id") == id and r.get("event") == "declared"), None)
    if not declared:
        return None
    children = [r["child_id"] for r in all_rows
                if r.get("id") == id and r.get("event") == "child_added"]
    iter_rows = [r for r in all_rows if r.get("id") == id and r.get("event") == "iterated"]
    satisfied = any(r.get("event") == "satisfied" for r in all_rows if r.get("id") == id)
    merged_rows = [r for r in all_rows if r.get("id") == id and r.get("event") == "merged"]
    revised_rows = [r for r in all_rows if r.get("id") == id and r.get("event") == "revised"]
    status_updates = [r["status"] for r in all_rows
                      if r.get("id") == id and r.get("event") == "status_update" and r.get("status")]
    if merged_rows:
        status = "merged"
    elif status_updates:
        status = status_updates[-1]
    elif satisfied:
        status = "satisfied"
    elif iter_rows:
        status = "active"
    else:
        status = "pending"
    wave = max((r.get("wave", 0) for r in iter_rows), default=0)
    current_action = revised_rows[-1]["new_action"] if revised_rows else declared["action"]
    # Π5 — layer is stored on the row when known; for legacy rows (declared
    # pre-Π5) we infer at read time from the current action so backfill is
    # automatic. pierced_layers stays optional — absent = no cross-layer auth.
    row_layer = declared.get("layer")
    if row_layer is None:
        row_layer = _infer_layer(current_action)
    result = {"id": id, "plan": declared["plan"], "action": current_action,
              "pointer_type": declared.get("pointer_type") or _infer_pointer_type(current_action),
              "layer": int(row_layer),
              "layer_name": layer_name(row_layer),
              "parent_id": declared.get("parent_id"), "children": children,
              "pointers": declared.get("pointers") or [],
              "cwd": declared.get("cwd"), "budget": declared.get("budget"),
              "status": status, "wave": wave}
    if declared.get("pierced_layers"):
        result["pierced_layers"] = list(declared["pierced_layers"])
    if merged_rows:
        result["merged_into"] = merged_rows[-1].get("merged_into")
    if revised_rows:
        result["original_action"] = declared["action"]
    if declared.get("learning"):
        result["learning"] = declared["learning"]
    if declared.get("bind_to"):
        result["bind_to"] = declared["bind_to"]
    if declared.get("inhibits"):
        result["inhibits"] = list(declared["inhibits"])
    if declared.get("audience"):
        # Surface audience on the projection so downstream filters (Σ2
        # visibility) can consult it without re-reading the declared row.
        result["audience"] = list(declared["audience"])
    if declared.get("agent"):
        # Σ1 attribution surfaced for Σ2 visibility (private tier needs to
        # compare declarer.agent against viewer).
        result["agent"] = declared["agent"]
    return result
def get_tree(id: str, depth: int = 0) -> Optional[dict]:
    c = get(id)
    if not c:
        return None
    c["depth"] = depth
    c["child_nodes"] = [n for cid in c["children"]
                        for n in [get_tree(cid, depth + 1)] if n]
    return c


def list_all(show_merged: bool = False, viewer: Optional[str] = None) -> list[dict]:
    """Return every declared contract (most recent state per id).

    viewer (Σ2): optional viewer identity. When set, rows are filtered
    via `visible_to(row, viewer)` — public rows pass through, audience-tagged
    rows pass only when viewer is in the audience list. None means no
    filter (default — same as before the audience gate landed)."""
    seen, result = set(), []
    for row in _rows():
        if row.get("event") == "declared" and row["id"] not in seen:
            seen.add(row["id"])
            c = get(row["id"])
            if c and (show_merged or c.get("status") != "merged"):
                if viewer and not visible_to(c, viewer):
                    continue
                result.append(c)
    return result
def children_satisfy(id: str) -> bool:
    c = get(id)
    if not c or not c["children"]:
        return False
    statuses = [(get(cid) or {}).get("status") for cid in c["children"]]
    # A merged (superseded) child is resolved: its truth claim is carried by
    # the winner it merged into. A fossil must never permanently block its
    # parent funnel. The funnel is satisfied when every child is satisfied or
    # merged, and at least one child is genuinely satisfied (an all-merged
    # organ is hollow, not satisfied).
    if not all(s in ("satisfied", "merged") for s in statuses):
        return False
    return any(s == "satisfied" for s in statuses)
def first_child_satisfies(id: str) -> bool:
    """funnel-first: at least one child satisfied (OR-gate)."""
    c = get(id)
    if not c or not c["children"]:
        return False
    return any((get(cid) or {}).get("status") == "satisfied" for cid in c["children"])


def quorum_satisfied(id: str, k: int) -> bool:
    """quorum:K — the integrate-and-fire neuron. Satisfied when at least K
    of N children are genuinely satisfied. funnel is the K=N extreme;
    funnel-first is the K=1 extreme; quorum:K is every threshold between."""
    c = get(id)
    if not c or not c["children"]:
        return False
    n_sat = sum(1 for cid in c["children"]
                if (get(cid) or {}).get("status") == "satisfied")
    return n_sat >= k


def wavefront(id: str) -> dict:
    """The signal a state change at `id` propagates. Returns the contracts a
    change at `id` should re-evaluate: the parent organ, every contract:<id>
    referrer, and corroborated synapses. Surfaces the wavefront only — it
    satisfies nothing; KEY 2 stays with the agent."""
    me = get(id)
    out = {"parent": None, "referrers": [], "synapses": []}
    if not me:
        return out
    out["parent"] = me.get("parent_id")
    ref = "contract:" + id
    for r in _rows():
        if r.get("event") == "declared" and r.get("action") == ref:
            out["referrers"].append(r["id"])
    out["synapses"] = get_corroborations(id)
    return out
def dag(json_output: bool = False):
    """Build a DAG from all contracts in the active ledger."""
    all_rows = _rows()

    # Collect latest declared row per id
    declared_by_id: dict = {}
    for row in all_rows:
        if row.get("event") == "declared":
            declared_by_id[row["id"]] = row

    # Derive status per id (merged takes priority)
    def _status(cid: str) -> str:
        if any(r.get("event") == "merged" for r in all_rows if r.get("id") == cid):
            return "merged"
        status_updates = [r["status"] for r in all_rows
                          if r.get("id") == cid and r.get("event") == "status_update" and r.get("status")]
        if status_updates:
            return status_updates[-1]
        if any(r.get("event") == "satisfied" for r in all_rows if r.get("id") == cid):
            return "satisfied"
        if any(r.get("event") == "iterated" for r in all_rows if r.get("id") == cid):
            return "active"
        return "pending"

    def _wave(cid: str) -> int:
        waves = [r.get("wave", 0) for r in all_rows
                 if r.get("id") == cid and r.get("event") == "iterated"]
        return max(waves, default=0)

    def _current_action(cid: str, original: str) -> str:
        revisions = [r["new_action"] for r in all_rows
                     if r.get("id") == cid and r.get("event") == "revised" and r.get("new_action")]
        return revisions[-1] if revisions else original

    nodes = []
    edges = []
    for cid, row in declared_by_id.items():
        action = _current_action(cid, row.get("action", ""))
        nodes.append({
            "id": cid,
            "plan": row.get("plan", ""),
            "status": _status(cid),
            "action": action,
            "pointer_type": row.get("pointer_type") or _infer_pointer_type(action),
            "pointers": row.get("pointers") or [],
            "wave": _wave(cid),
        })
        # Parent edges
        if row.get("parent_id"):
            edges.append({"from": cid, "to": row["parent_id"], "type": "parent"})
        # Pointer-to edges
        for tag in (row.get("pointers") or []):
            edges.append({"from": cid, "to": tag, "type": "pointer_to"})

    # Corroboration edges (synapses — bidirectional, deduplicated)
    seen_corr: set = set()
    for row in all_rows:
        if row.get("event") == "corroborated":
            src, tgt = row.get("id"), row.get("corroborates")
            if src and tgt:
                key = tuple(sorted([src, tgt]))
                if key not in seen_corr:
                    seen_corr.add(key)
                    edges.append({"from": src, "to": tgt, "type": "corroborates",
                                  "label": row.get("label", "")})

    # Merge edges (apoptosis — source superseded by target)
    for row in all_rows:
        if row.get("event") == "merged":
            src, tgt = row.get("id"), row.get("merged_into")
            if src and tgt:
                edges.append({"from": src, "to": tgt, "type": "merged_into"})

    result = {"nodes": nodes, "edges": edges}

    if json_output:
        print(json.dumps(result, indent=2))
        return result

    # Human-readable tree: roots = nodes with no parent
    child_ids = {e["from"] for e in edges if e["type"] == "parent"}
    roots = [n for n in nodes if n["id"] not in child_ids]
    children_map: dict = {}
    corr_map: dict = {}
    for e in edges:
        if e["type"] == "parent":
            children_map.setdefault(e["to"], []).append(e["from"])
        elif e["type"] == "corroborates":
            corr_map.setdefault(e["from"], []).append(e["to"])
            corr_map.setdefault(e["to"], []).append(e["from"])

    def _print_node(node: dict, indent: int = 0) -> None:
        prefix = "  " * indent + ("└─ " if indent > 0 else "")
        shape = "organ" if children_map.get(node["id"]) else (
            "judgment" if node["action"] == "agent-judges" else "cell")
        merged_note = f" → {node.get('merged_into', '?')}" if node["status"] == "merged" else ""
        print(f"{prefix}[{node['status']}] {node['id']} ({shape}) w={node['wave']}{merged_note}")
        print(f"{'  ' * (indent + 1)}plan: {node['plan'][:72]}")
        if node["pointers"]:
            print(f"{'  ' * (indent + 1)}-> {', '.join(node['pointers'])}")
        synapse_ids = corr_map.get(node["id"], [])
        if synapse_ids:
            print(f"{'  ' * (indent + 1)}~~ synapses: {', '.join(synapse_ids)}")
        for child_id in children_map.get(node["id"], []):
            child_node = next((n for n in nodes if n["id"] == child_id), None)
            if child_node:
                _print_node(child_node, indent + 1)

    if not nodes:
        print("  (no contracts)")
    else:
        for root in roots:
            _print_node(root)

    return result


def _rows_from_path(ledger_path: Path) -> list[dict]:
    """Read all event rows from a ledger file. A line that is not valid
    JSON is a ledger-integrity problem: it is reported on stderr and
    skipped, never silently dropped."""
    if not ledger_path.exists():
        return []
    out = []
    for n, line in enumerate(ledger_path.read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as e:
            key = (str(ledger_path), n)
            if key not in _WARNED_LINES:
                _WARNED_LINES.add(key)
                print(f"contract: WARNING {ledger_path} line {n} is corrupt "
                      f"and was skipped: {e}", file=sys.stderr)
    return out


def discover(scope: str = "all") -> list[dict]:
    """List contracts from project and/or global stores, tagged by scope."""
    project_path = Path.cwd() / ".claude" / "contracts.jsonl"
    global_path = Path.home() / ".contracts" / "contracts.jsonl"

    stores = []
    if scope in ("project", "all"):
        stores.append(("project", project_path))
    if scope in ("global", "all"):
        stores.append(("global", global_path))

    results = []
    for label, path in stores:
        rows = _rows_from_path(path)
        seen: set = set()
        declared_ids = []
        declared_by_id: dict = {}
        for row in rows:
            if row.get("event") == "declared" and row["id"] not in seen:
                seen.add(row["id"])
                declared_ids.append(row["id"])
                declared_by_id[row["id"]] = row
        for cid in declared_ids:
            row = declared_by_id[cid]
            status_updates = [r["status"] for r in rows
                              if r.get("id") == cid and r.get("event") == "status_update" and r.get("status")]
            if status_updates:
                status = status_updates[-1]
            elif any(r.get("event") == "satisfied" for r in rows if r.get("id") == cid):
                status = "satisfied"
            elif any(r.get("event") == "iterated" for r in rows if r.get("id") == cid):
                status = "active"
            else:
                status = "pending"
            has_children = any(r.get("event") == "child_added" and r.get("id") == cid for r in rows)
            shape = "organ" if has_children else (
                "judgment" if row.get("action") == "agent-judges" else "cell")
            results.append({
                "scope": label,
                "id": cid,
                "shape": shape,
                "status": status,
                "plan": row.get("plan", ""),
            })
    return results


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        for c in list_all():
            print(json.dumps(c))
    elif cmd == "get" and len(sys.argv) > 2:
        print(json.dumps(get(sys.argv[2])))
    elif cmd == "tree" and len(sys.argv) > 2:
        print(json.dumps(get_tree(sys.argv[2]), indent=2))
