#!/usr/bin/env python3
"""hoysan_draft.py — deterministic daily drafting engine.

Order (always): Malaysians -> Locals (+ NTS standby) -> NTS.
Hard filters (refuse, not degrade):
  - no same crane two days running (Malaysians + Locals)
  - no same role two days running (Malaysians + Locals)
  - Skill Exception List (all pools)
  - WAH cert: only wharf CM if WAH=N (STA/LW/onboard CM/onboard WTA require WAH=Y)
  - permanent pair rotation: if pair_state says partner did STA yesterday, this worker must not repeat same mapping naively — we enforce by routing requested role through pair logic (STA<->LW swap)
  - 24h rest after day<->night switch (NTS)
NTS role fairness: least-recently-held role.
Gang validation: 5 workers, 1 STA + 2 LW + 2 CM (or 1 CM replaced by WTA), WAH/exception/pairing respected.

Determinism: sort by NRIC (and last_role) as tiebreakers; no set(), no hash(), no random.
"""
from __future__ import annotations
import collections, json

HARD_ROLES_ONBOARD = {"STA", "LW", "WTA"}  # WAH=Y required; CM wharf allowed WAH=N but onboard CM would also need Y — we treat all CM here as wharf and allow WAH=N for CM only
# Per doc: WAH hard filter for STA, LW, onboard CM, onboard WTA. Workers without WAH can ONLY fill wharf-level CM.
# Our crane gangs: CM slots are wharf-level. So WAH=N workers eligible only for CM.

ROLE_ORDER = ["STA", "LW", "CM", "WTA"]
PAIR_ROTATION_LOGIC = {"STA": "LW", "LW": "STA"}  # confirmed intra-shift 1: YUVARAJA<->PETER

def _eligible_for_role(worker, role: str) -> tuple[bool, str | None]:
    # Skill Exception: disqualified from this role
    if role in (worker.get("exceptions") or []):
        return False, f"skill-exception {worker['name']} disqualified from {role}"
    # WAH filter
    if not worker.get("wah"):
        if role in HARD_ROLES_ONBOARD:
            return False, f"WAH=N {worker['name']} cannot fill onboard {role}"
        # CM is wharf — allowed
    return True, None

def _violates_crane_role_repeat(worker, crane_number: str, role: str) -> tuple[bool, str | None]:
    # Only enforced for TS and SIN (Malaysians + Locals). NTS skips crane, must rotate roles but not via this hard same-role ban — NTS uses least-recently-held instead.
    pool = worker.get("pool")
    if pool not in ("TS", "SIN"):
        return False, None
    last_crane = worker.get("last_crane")
    last_role = worker.get("last_role")
    if last_crane and str(last_crane) == str(crane_number):
        return True, f"same crane two days running: {worker['name']} last {last_crane} -> {crane_number}"
    if last_role and str(last_role) == str(role):
        return True, f"same role two days running: {worker['name']} last {last_role} -> {role}"
    return False, None

def _pair_constrained_role(worker, requested_role: str, pair_state: dict) -> str:
    """If worker is in an intra-shift STA<->LW rotation pair, the partner's yesterday role determines today's.
    pair_state maps NRIC -> partner_last_role. If this worker's NRIC is in pair_state, the value is the PARTNER's yesterday role.
    Rule: they swap. So if partner did STA yesterday, this worker does LW today, etc. We enforce that the requested role equals the swapped role;
    if not, we still honour the swap as the deterministic outcome (pair logic overrides naive allocation).
    For now, pair_state is optional and only used when provided; otherwise requested_role passes through.
    """
    nric = worker.get("nric")
    if not nric or nric not in (pair_state or {}):
        return requested_role
    partner_last = pair_state[nric]
    if partner_last in PAIR_ROTATION_LOGIC:
        swapped = PAIR_ROTATION_LOGIC[partner_last]
        # If caller already requested the swapped role, keep it; if they requested something else, the pair still dictates swapped.
        # To avoid silently violating caller, we return swapped when partner had a rotatable role, otherwise requested.
        return swapped
    return requested_role

def _violates_24h_rest(worker, shift_code: str) -> tuple[bool, str | None]:
    # Only NTS enforced per doc.
    if worker.get("pool") != "NTS":
        return False, None
    last_shift = worker.get("last_shift")
    if not last_shift or not shift_code:
        return False, None
    if str(last_shift) == str(shift_code):
        return False, None
    # Shift switch D<->G
    hours = worker.get("hours_since_last")
    if hours is None:
        # If unknown rest, do not block (conservative) — but record as warning in caller if needed
        return False, None
    if hours < 24:
        return True, f"24h rest violation NTS {worker['name']} last {last_shift} -> {shift_code} with {hours}h"
    return False, None

def _pick_for_slot(pool_workers, crane_number: str, role: str, shift_code: str, pair_state: dict, already_used: set[str], forbid_reason_collector: list):
    """Deterministically pick one worker among pool_workers for this crane/role slot."""
    # Determine the role after pair constraint
    # We try in sorted order (NRIC) to be deterministic
    candidates = sorted([w for w in pool_workers if w["nric"] not in already_used], key=lambda w: (w["nric"], w["name"]))
    for w in candidates:
        constrained_role = _pair_constrained_role(w, role, pair_state)
        # If pair changed the role, we must check eligibility against constrained role
        eff_role = constrained_role
        # But the slot is fixed to `role`; if pair wants a different role, this worker cannot fill this slot — try next worker
        if eff_role != role:
            forbid_reason_collector.append(f"pair-rotation {w['name']} partner_last->{pair_state.get(w['nric'])} wants {eff_role} not slot {role}")
            continue
        ok, reason = _eligible_for_role(w, eff_role)
        if not ok:
            forbid_reason_collector.append(reason)
            continue
        violates, reason2 = _violates_crane_role_repeat(w, crane_number, eff_role)
        if violates:
            forbid_reason_collector.append(reason2)
            continue
        violates24, reason3 = _violates_24h_rest(w, shift_code)
        if violates24:
            forbid_reason_collector.append(reason3)
            continue
        if not w.get("available", True):
            forbid_reason_collector.append(f"unavailable {w['name']}")
            continue
        return w
    return None

def _least_recent_role_for_nts(worker) -> list[str]:
    """Order roles by least-recently-held (not in history -> highest priority), then fixed ROLE_ORDER."""
    history = worker.get("role_history") or []
    # distance since last occurrence; not occurred = inf
    scores = {}
    for role in ROLE_ORDER:
        # WTA only if needed — we handle that at gang level, but for NTS fairness we still consider it
        try:
            # last index of role in history
            idx = len(history) - 1 - history[::-1].index(role) if role in history else -1
            # if not found, score huge
            if idx == -1:
                scores[role] = 1_000_000
            else:
                # larger distance = less recent
                scores[role] = len(history) - 1 - idx
                # Actually distance from end: last occurrence position -> larger gap if long ago? We want least recent = largest gap since last.
                # So invert: score = history length - idx - 1? Wait idx is already distance trick.
                # Simpler: last occurrence index (0=oldest). If history=[STA,LW,CM], LW at idx1, then gap = len-1-idx = 1.
                # STA gap=2, CM gap=0. Least recent = largest gap = STA.
                # So indeed scores[role]=len-1 - idx if found else big.
                # But above we did len-1-idx after reverse trick — that's wrong. Let's recompute properly.
                pass
        except ValueError:
            scores[role] = 1_000_000
    # Recompute correctly
    corrected = {}
    for role in ROLE_ORDER:
        if role not in history:
            corrected[role] = 1_000_000 + ROLE_ORDER.index(role)
        else:
            # find last occurrence index
            last_idx = max(i for i, r in enumerate(history) if r == role)
            gap = (len(history) - 1) - last_idx
            corrected[role] = gap
    # Sort descending gap (least recent first), break ties by ROLE_ORDER then NRIC at caller
    return sorted(ROLE_ORDER, key=lambda r: (-corrected[r], ROLE_ORDER.index(r)))

def run(inputs, ctx):
    # membrane is inputs.request -> unwrap; also accept flat for direct python calls
    if "request" in inputs and isinstance(inputs["request"], dict) and "shift_date" in inputs["request"]:
        req = inputs["request"]
    elif "shift_date" in inputs:
        req = inputs
    else:
        req = inputs.get("request", inputs)
    shift_date = req["shift_date"]
    shift_code = req["shift_code"]
    cranes_in = list(req["cranes"])
    workers_in = list(req["workers"])
    pair_state = req.get("pair_state") or {}

    # Deterministic ordering of cranes: by crane_number string
    cranes_in = sorted(cranes_in, key=lambda c: str(c["crane_number"]))
    # Deterministic workers: by NRIC
    workers_in = sorted(workers_in, key=lambda w: (w["nric"], w["name"]))

    # Partition by pool
    by_pool = {"TS": [], "NTS": [], "SIN": []}
    for w in workers_in:
        by_pool[w["pool"]].append(w)

    already_used: set[str] = set()
    gangs = []
    standby = []
    errors: list[str] = []
    debug_forbid: list[str] = []

    # Derive available counts for stats
    # Allocation plan per crane: composition 1 STA + 2 LW + 2 CM, but if wta_required then 1 STA + 2 LW + 1 CM + 1 WTA
    # Drafting order per doc: Malaysians first, Locals second (each confirmed Local triggers NTS standby), NTS last.

    # We allocate gang-by-gang in crane order, filling STA first then LW then CM/WTA, always respecting drafting order within each slot.
    # To honour "Malaysians first, Locals second, NTS last" globally, we for each role slot try pools in priority TS -> SIN -> NTS,
    # except for NTS role-fairness we reorder candidates by least-recently-held inside NTS pool.

    # Track which SIN locals got assigned, to create standby
    assigned_locals = []

    # For NTS: to implement least-recently-held fairly we sort NTS candidates per slot by gap then NRIC
    def nts_sorted_for_slot(role_slot: str, avail_nts):
        # avail_nts already filtered by already_used
        def gap_for(w):
            hist = w.get("role_history") or []
            if role_slot not in hist:
                return 1_000_000
            last_idx = max(i for i, r in enumerate(hist) if r == role_slot)
            return (len(hist) - 1) - last_idx
        # For a given slot, prefer NTS workers whose least-recent includes this slot? But we only rank candidates for SLOT=role_slot.
        # So least-recent ordering is just gap descending for that role.
        return sorted(avail_nts, key=lambda w: (-gap_for(w), w["nric"], w["name"]))

    # Keep NTS pool sorted by NRIC as baseline, but re-rank per slot by gap
    # For TS/SIN: deterministic NRIC order only

    for crane in cranes_in:
        cn = str(crane["crane_number"])
        vessel = crane.get("vessel", "")
        wta_required = bool(crane.get("wta_required"))
        stroking = crane.get("stroking")
        # Desired slot sequence
        if wta_required:
            slots = ["STA", "LW", "LW", "CM", "WTA"]
        else:
            slots = ["STA", "LW", "LW", "CM", "CM"]
        gang_workers = []
        for slot_role in slots:
            picked = None
            forbid_local: list[str] = []
            # Drafting priority: TS -> SIN -> NTS
            # For TS
            avail_ts = [w for w in by_pool["TS"] if w["nric"] not in already_used]
            avail_ts_sorted = sorted(avail_ts, key=lambda w: (w["nric"], w["name"]))
            # Reuse _pick but need to honour priority: try TS first, then SIN, then NTS
            # Build candidate pools in priority and pick first that succeeds
            for pool_code in ("TS", "SIN", "NTS"):
                if picked is not None:
                    break
                pool_avail = [w for w in by_pool[pool_code] if w["nric"] not in already_used]
                if not pool_avail:
                    continue
                if pool_code == "NTS":
                    # sort by gap for this slot to enforce role fairness among NTS
                    pool_avail = nts_sorted_for_slot(slot_role, pool_avail)
                    # Try each in that order using single-slot checker
                    for cand in pool_avail:
                        constrained_role = _pair_constrained_role(cand, slot_role, pair_state)
                        if constrained_role != slot_role:
                            forbid_local.append(f"pair-rotation {cand['name']} wants {constrained_role} not {slot_role}")
                            continue
                        ok, r = _eligible_for_role(cand, constrained_role)
                        if not ok:
                            forbid_local.append(r)
                            continue
                        viol, r2 = _violates_crane_role_repeat(cand, cn, constrained_role)
                        if viol:
                            forbid_local.append(r2)
                            continue
                        viol24, r3 = _violates_24h_rest(cand, shift_code)
                        if viol24:
                            forbid_local.append(r3)
                            continue
                        if not cand.get("available", True):
                            forbid_local.append(f"unavailable {cand['name']}")
                            continue
                        # Also check NTS least-recently-held is not violated by giving them same role repeatedly?
                        # The slot itself is the role we assign; the fairness is embodied in the ordering (least recent first),
                        # not as a hard block. So picking the highest-gap candidate satisfies "least-recently-held".
                        picked = cand
                        break
                else:
                    # For TS/SIN, deterministic NRIC order and single pass via _pick logic
                    # We can call _pick_for_slot with only this pool
                    solo = _pick_for_slot(pool_avail, cn, slot_role, shift_code, pair_state, already_used, forbid_local)
                    if solo:
                        picked = solo
            if picked is None:
                errors.append(f"no eligible worker for crane {cn} slot {slot_role} (wta_required={wta_required})")
                debug_forbid.extend(forbid_local[-8:])
                # Leave gang incomplete for validation to catch
                continue
            already_used.add(picked["nric"])
            gang_workers.append({
                "nric": picked["nric"],
                "name": picked["name"],
                "pool": picked["pool"],
                "role": slot_role,
                "wah": bool(picked["wah"]),
            })
            if picked["pool"] == "SIN":
                assigned_locals.append(picked)

        gangs.append({
            "crane_number": cn,
            "vessel": vessel,
            "stroking": stroking,
            "wta_required": wta_required,
            "workers": gang_workers,
        })

    # Standby: each confirmed Local triggers an NTS standby designation. The standby is a designated NTS worker not yet used.
    # Deterministic: sort remaining NTS by NRIC, take min(len(assigned_locals), remaining) in order.
    remaining_nts = sorted([w for w in by_pool["NTS"] if w["nric"] not in already_used], key=lambda w: (w["nric"], w["name"]))
    # Filter available and not violating 24h rest (but not crane/role repeat — standby has no slot yet)
    filtered_standby_cands = []
    for w in remaining_nts:
        viol24, _ = _violates_24h_rest(w, shift_code)
        if viol24:
            continue
        if not w.get("available", True):
            continue
        # Still must be WAH-eligible for whatever wharf CM might be needed, but standby not role-bound — keep eligible for CM at least
        ok_cm, _ = _eligible_for_role(w, "CM")
        if not ok_cm:
            continue
        filtered_standby_cands.append(w)
    for idx, local in enumerate(assigned_locals):
        if idx >= len(filtered_standby_cands):
            errors.append(f"no NTS standby available for Local {local['name']} ({local['nric']})")
            break
        nts = filtered_standby_cands[idx]
        already_used.add(nts["nric"])
        standby.append({
            "for_local_nric": local["nric"],
            "for_local_name": local["name"],
            "nts_nric": nts["nric"],
            "nts_name": nts["name"],
        })

    # Unassigned: workers not used (deterministic by NRIC)
    unassigned = sorted([{"nric": w["nric"], "name": w["name"], "pool": w["pool"]} for w in workers_in if w["nric"] not in already_used], key=lambda x: x["nric"])

    # Gang validation (hard): exactly 5, composition, WAH, exception (already enforced but double-check)
    for g in gangs:
        ws = g["workers"]
        if len(ws) != 5:
            errors.append(f"gang {g['crane_number']} has {len(ws)} workers, expected 5")
            continue
        roles = [w["role"] for w in ws]
        c = collections.Counter(roles)
        if g["wta_required"]:
            # must be 1 STA + 2 LW + 1 CM + 1 WTA
            if c.get("STA", 0) != 1 or c.get("LW", 0) != 2 or c.get("CM", 0) != 1 or c.get("WTA", 0) != 1:
                errors.append(f"gang {g['crane_number']} composition invalid with WTA: {dict(c)}")
        else:
            if c.get("STA", 0) != 1 or c.get("LW", 0) != 2 or c.get("CM", 0) != 2:
                errors.append(f"gang {g['crane_number']} composition invalid: {dict(c)}")
        for w in ws:
            # Find original worker for deeper checks
            orig = next((x for x in workers_in if x["nric"] == w["nric"]), None)
            if orig is None:
                continue
            if w["role"] in (orig.get("exceptions") or []):
                errors.append(f"skill-exception violated gang {g['crane_number']} {w['name']} in {w['role']}")
            if not w["wah"] and w["role"] in HARD_ROLES_ONBOARD:
                errors.append(f"WAH violation gang {g['crane_number']} {w['name']} WAH=N in {w['role']}")
            # Also check onboard CM misclassification: we treat all CM as wharf, so WAH=N CM is allowed — no error.

    validation = {"ok": len(errors) == 0, "errors": sorted(set(errors))}

    summary_lines = []
    summary_lines.append(f"{shift_date} {shift_code} — {len(cranes_in)} cranes -> {sum(len(g['workers']) for g in gangs)} workers, filled {sum(1 for g in gangs if len(g['workers'])==5)}/{len(cranes_in)} gangs, standby {len(standby)}, validation={'OK' if validation['ok'] else 'FAIL'}")
    for g in gangs:
        roles = ", ".join(f"{w['role']}:{w['pool']}:{w['name'][:12]}" for w in g["workers"])
        summary_lines.append(f"CR{g['crane_number']} {g['vessel'][:18]:18s} WTA={g['wta_required']} stroking={g['stroking'] or '-':12s} -> {roles}")
    if validation["errors"]:
        summary_lines.append("ERRORS: " + "; ".join(validation["errors"][:6]))
    summary = "\n".join(summary_lines)

    result = {
        "shift_date": shift_date,
        "shift_code": shift_code,
        "gangs": gangs,
        "standby": standby,
        "unassigned": unassigned,
        "stats": {
            "cranes_requested": len(cranes_in),
            "cranes_filled": sum(1 for g in gangs if len(g["workers"]) == 5),
            "workers_deployed": sum(len(g["workers"]) for g in gangs),
        },
        "validation": validation,
    }
    return {"result": result, "summary": summary}
