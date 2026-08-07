#!/usr/bin/env python3
# confirm — claim + evidence -> confirmed (independent read-back), not sender's word
# This is the encouraged organelle for evidence grounding. Not substrate — compose it where effects matter.
# E.g. after primitives/request, read back GET /orders/:id and compare digest.
import json, hashlib
def _h(v): return hashlib.sha256(json.dumps(v, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
def run(inputs, ctx):
    claim = inputs.get("claim") or {}
    evidence = inputs.get("evidence") or {}
    # evidence should contain an independent observation (headers, body, fetched_at)
    # Confirm if evidence digest matches claim expectation or if evidence was independently fetched
    claim_digest = claim.get("digest") or _h(claim.get("data") or claim)
    ev_digest = evidence.get("digest") or _h(evidence.get("data") or evidence)
    # If evidence carries source == claim source, it's grounded; if it was fetched via a separate request, it's independent
    independent = evidence.get("source") != claim.get("source") or "fetched_at" in evidence or "observed_at" in evidence
    confirmed = (claim_digest == ev_digest) and bool(independent or evidence.get("attested"))
    # Also confirm via helpers if needed: re-read external state is caller responsibility; here we just compare
    diff = {"claim_digest": claim_digest, "evidence_digest": ev_digest, "independent": independent}
    return {"confirmed": bool(confirmed), "diff": diff}
