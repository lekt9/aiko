#!/usr/bin/env python3
# redrive — manifests + prior -> stale (refire) vs compensation (ALREADY SENT, never refire)
# Contract-style case 3: boundary already crossed -> diff, don't re-fire.
def run(inputs, ctx):
    manifests = inputs.get("manifests") or {}
    prior = inputs.get("prior") or {}
    # manifests: {port: {digest, manifest}} or {digests: {}}
    # prior: previous manifests or known sent digests
    stale = []
    compensation = []
    # Normalize to dicts of digests if passed as manifests dict
    cur_digests = {}
    if isinstance(manifests, dict):
        for k,v in manifests.items():
            if isinstance(v, dict) and "digest" in v:
                cur_digests[k] = v["digest"]
            elif isinstance(v, str):
                cur_digests[k] = v
            elif isinstance(v, dict) and "inputs" in v:
                # raw manifest
                cur_digests[k] = v.get("produced_by") or str(v)[:16]
    prior_sent = set()
    if isinstance(prior, dict):
        for v in prior.values():
            if isinstance(v, str):
                prior_sent.add(v)
            elif isinstance(v, dict) and "digest" in v:
                prior_sent.add(v["digest"])
    for port, digest in cur_digests.items():
        if digest not in prior:
            if digest in prior_sent or port in prior_sent:
                compensation.append({"port": port, "digest": digest, "reason": "ALREADY_SENT"})
            else:
                stale.append({"port": port, "digest": digest, "reason": "new_or_changed"})
        elif cur_digests[port] != prior.get(port):
            if prior.get(port) in prior_sent:
                compensation.append({"port": port, "from": prior.get(port), "to": digest, "reason": "ALREADY_SENT_DIFF"})
            else:
                stale.append({"port": port, "from": prior.get(port), "to": digest, "reason": "changed"})
    return {"stale": stale, "compensation": compensation}
