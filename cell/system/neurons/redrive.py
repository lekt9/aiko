#!/usr/bin/env python3
# redrive — manifests + prior -> stale (refire) vs compensation (ALREADY SENT, never refire)
def run(inputs, ctx):
    manifests = inputs.get("manifests") or {}
    prior = inputs.get("prior") or {}
    stale = []
    compensation = []
    cur_digests = {}
    if isinstance(manifests, dict):
        for k,v in manifests.items():
            if isinstance(v, dict) and "digest" in v:
                cur_digests[k] = v["digest"]
            elif isinstance(v, str):
                cur_digests[k] = v
            elif isinstance(v, dict) and "inputs" in v:
                cur_digests[k] = v.get("produced_by") or str(v)[:16]
    for port, digest in cur_digests.items():
        if port not in prior:
            stale.append({"port": port, "digest": digest, "reason": "new_or_changed"})
        elif cur_digests[port] != prior.get(port):
            stale.append({"port": port, "from": prior.get(port), "to": digest, "reason": "changed"})
        # else unchanged -> neither
    # Optional: if caller passes prior_sent separately, surface compensation
    prior_sent = inputs.get("prior_sent")
    if isinstance(prior_sent, (list, set)):
        prior_sent = set(prior_sent)
        for s in stale[:]:
            # A changed derivation compensates if either the superseded product
            # or the newly observed product is durably known to have crossed.
            if s.get("digest") in prior_sent or s.get("to") in prior_sent or s.get("from") in prior_sent:
                stale.remove(s)
                compensation.append({**s, "reason": "ALREADY_SENT", "action": "diff_superseded_product"})
    return {"stale": stale, "compensation": compensation}
