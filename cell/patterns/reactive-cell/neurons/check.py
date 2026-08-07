#!/usr/bin/env python3
# check — current + prior manifest -> changed ports + diff (raw, model already knows diff)
import copy
def run(inputs, ctx):
    cur = inputs.get("current") or {}
    prior = inputs.get("prior") or {}
    # Inputs/outputs are digests in out/manifest.json. Compare port-by-port.
    def digests(m):
        # Support both manifest shape {inputs:{port:digest}, outputs:{port:digest}} and flat {cell, produced_by}
        if not isinstance(m, dict):
            return {}
        if "inputs" in m or "outputs" in m:
            d = {}
            d.update({f"in:{k}": v for k, v in (m.get("inputs") or {}).items()})
            d.update({f"out:{k}": v for k, v in (m.get("outputs") or {}).items()})
            d["cell"] = m.get("cell")
            d["produced_by"] = m.get("produced_by")
            return d
        return {k: str(v) for k, v in m.items()}
    cur_d = digests(cur)
    pri_d = digests(prior)
    changed = [k for k in set(list(cur_d.keys()) + list(pri_d.keys())) if cur_d.get(k) != pri_d.get(k)]
    # Also surface which evidence ports changed (upstream dependency moved)
    evidence_changed = []
    for e in (cur.get("evidence") or []):
        if isinstance(e, dict) and e.get("port"):
            port = e["port"]
            digest = e.get("digest")
            prior_ev = {x.get("port"): x.get("digest") for x in (prior.get("evidence") or []) if isinstance(x, dict)}
            if prior_ev.get(port) != digest:
                evidence_changed.append(port)
    diff = {"changed_keys": sorted(changed), "evidence_changed": sorted(evidence_changed), "current_produced_by": cur.get("produced_by"), "prior_produced_by": prior.get("produced_by")}
    return {"changed": sorted(changed), "diff": diff}
