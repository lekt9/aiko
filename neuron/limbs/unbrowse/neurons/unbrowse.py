#!/usr/bin/env python3
"""Pure Contract projection for Unbrowse route lifecycle evidence."""
import hashlib, json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "shared"))
from _neuron import Reject, artifact_ref, canonical, cas_write, decision, run

EVENT = "neuron.unbrowse-boundary-event/v1"
PROJECTION = "contract.unbrowse-route-projection/v1"
HEX = re.compile(r"^[0-9a-f]{64}$")

def _require_event(event):
    required = ("kind", "route_id", "route", "method", "credential_handle",
                "source_firing_id", "sealing")
    for key in required:
        if key not in event: raise Reject("validation", f"boundary event missing {key}")
    if event["kind"] not in ("observation", "replay", "drift"):
        raise Reject("validation", "unsupported boundary event kind")
    if not HEX.match(event["route_id"]): raise Reject("validation", "route id is not a digest")
    if event["method"] != "GET": raise Reject("validation", "only read routes may be projected")
    if not event["credential_handle"].startswith("cred:"):
        raise Reject("validation", "credential must remain an opaque handle")
    sealed = event["sealing"]
    if any(sealed.get(k) is not False for k in ("raw_request_retained", "raw_response_retained", "secret_values_retained")):
        raise Reject("validation", "unsealed boundary evidence refused")
    forbidden = {"request", "response", "raw_request", "raw_response", "secret", "authorization", "headers", "body"}
    if forbidden.intersection(k.lower() for k in event):
        raise Reject("validation", "raw traffic or credential material present in lifecycle evidence")
    if event["kind"] in ("observation", "replay"):
        if not HEX.match(event.get("response_digest", "")) or not isinstance(event.get("response_schema"), dict):
            raise Reject("validation", "observation lacks sealed response evidence")

def _prior_for(stim, route_id):
    wanted = "contract/projections/unbrowse/" + route_id
    for ref in stim.get("reads", []):
        if ref.get("id") == wanted and ref.get("schema") == PROJECTION:
            try: return ref, json.loads(ref["bytes"])
            except Exception as exc: raise Reject("poisoned_input", f"projection is not JSON: {exc}")
    return None, None

def fire(stim):
    event_ref, event = artifact_ref(stim, EVENT)
    _require_event(event)
    prior_ref, prior = _prior_for(stim, event["route_id"])
    kind = event["kind"]
    base = {"schema": PROJECTION, "contract": "unbrowse/read-route/v1",
            "route_id": event["route_id"], "route": event["route"], "method": "GET",
            "credential_handle": event["credential_handle"],
            "sealing": event["sealing"]}
    sources = [event_ref["id"]]
    if prior_ref: sources.append(prior_ref["id"])

    if kind == "observation":
        if prior is not None: raise Reject("conflict", "observation cannot replace an existing Contract projection")
        projection = {**base, "status": "observed", "observation_firing_id": event["source_firing_id"],
                      "replay_firing_id": None, "response_digest": event["response_digest"],
                      "response_schema": event["response_schema"], "promotion": None,
                      "demotion": None}
        result = "observation-projected"
    else:
        if prior is None: raise Reject("dependency", f"{kind} requires the prior Contract projection")
        for key in ("route_id", "route", "method", "credential_handle"):
            if prior.get(key) != event.get(key): raise Reject("validation", f"event changes pinned {key}")
        if kind == "replay":
            if prior.get("status") != "observed": raise Reject("conflict", "replay requires exactly one unpromoted observation")
            independent = event["source_firing_id"] != prior.get("observation_firing_id")
            agrees = (event["response_digest"] == prior.get("response_digest") and
                      event["response_schema"] == prior.get("response_schema"))
            if independent and agrees:
                projection = {**prior, "status": "promoted", "replay_firing_id": event["source_firing_id"],
                              "promotion": {"basis": "observation_and_independent_replay_agreement",
                                            "observation_firing_id": prior["observation_firing_id"],
                                            "replay_firing_id": event["source_firing_id"], "independent": True}}
                result = "route-promoted"
            else:
                projection = {**prior, "status": "demoted", "replay_firing_id": event["source_firing_id"],
                              "demotion": {"reason": "replay_not_independent" if not independent else "independent_replay_disagreed",
                                           "source_firing_id": event["source_firing_id"]}}
                result = "route-demoted"
        else:
            if prior.get("status") != "promoted": raise Reject("conflict", "drift can demote only a promoted route")
            projection = {**prior, "status": "demoted",
                          "demotion": {"reason": "response_schema_drift",
                                       "source_firing_id": event["source_firing_id"],
                                       "expected_schema_digest": event.get("expected_schema_digest"),
                                       "actual_schema_digest": event.get("actual_schema_digest")}}
            result = "route-demoted"

    body = canonical(projection).decode()
    aid = "contract/projections/unbrowse/" + event["route_id"]
    effect = cas_write(stim, aid, PROJECTION, body)
    evidence = [{"claim": result.replace("-", " "), "sources": sources,
                 "method": "deterministic Contract projection of cited boundary firing(s)",
                 "confidence_milli": 1000}]
    return decision({"kind": "terminate", "result": result}, [effect], evidence, stim)

if __name__ == "__main__":
    sys.exit(run(fire))
