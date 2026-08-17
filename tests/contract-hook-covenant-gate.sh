#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
python3 - <<'PY'
from pathlib import Path
import copy, json, re, sys

root = Path.cwd()
doc_path = root / "docs/graph-engineering/AIKO-HOOK-ORGANISM.md"
doc = doc_path.read_text()
m = re.search(r"```json covenant-v1\n(.*?)\n```", doc, re.S)
assert m, "missing covenant-v1 fixture"
policy = json.loads(m.group(1))

INGRESS_FIELDS = {
    "authenticated_subject", "verified_tenant", "transport", "audience",
    "granted_scopes", "canonical_request_digest", "nonce_namespace",
    "idempotency_key", "verification_evidence", "credential_generation",
}
HINTS = {"tenant", "role", "contract_root", "contract_parent",
         "contract_occurrence", "account", "endpoint_id", "effect"}
IDENTITIES = {"principal", "tenant", "contract_root", "contract_parent",
              "contract_occurrence", "execution", "run", "session", "lease",
              "lease_fence", "firing", "logical_effect", "credential_generation"}
WEBHOOK_BINDING = {"endpoint_generation", "verified_tenant",
                   "authenticated_subject", "provider_namespace", "delivery_id",
                   "raw_body_digest", "audience", "granted_scopes",
                   "credential_generation"}
ORDER = ["normalize_confine", "authenticate", "declare_adopt", "scope_authorize",
         "lease", "invoke", "read_back_evidence", "settle_invalidate"]

def validate(p):
    assert p["version"] == 1
    vi = p["verified_ingress"]
    assert vi["exclusive_emitters"] == ["transport_auth_boundary"], "VerifiedIngress emitter is not exclusive"
    assert set(vi["fields"]) == INGRESS_FIELDS, "VerifiedIngress authority/evidence fields changed"
    assert set(vi["envelope_hints_untrusted"]) == HINTS, "caller hints gained authority"

    ident = p["identity"]
    assert set(ident["dimensions"]) == IDENTITIES, "identities were conflated"
    assert ident["occurrence_tuple"] == ["nonce_namespace", "idempotency_key", "contract_root"]
    assert ident["payload_digest_separate"] is True, "payload digest coalesced into/away from occurrence admission"
    assert ident["timestamps_in_identity"] is False, "timestamp became identity"

    wh = p["webhook"]
    assert wh["signature_bytes"] == "raw_received_body", "reserialized body accepted"
    assert set(wh["binding"]) == WEBHOOK_BINDING, "webhook binding permits cross-authority/endpoint replay"
    assert wh["same_tuple_same_digest"] == "replay"
    assert wh["same_tuple_changed_bytes_or_authority"] == "conflict"
    assert wh["endpoint_id_source"] == "authorized_contract_occurrence_output", "caller chose endpoint id"

    hooks = p["hooks"]
    assert set(hooks["critical"]) == {"contract_declaration_projection", "authority", "effect"}
    assert hooks["critical_failure"] == "fail_closed_no_launch", "mandatory hook can launch after failure"
    assert hooks["fail_open"] == ["observational"], "non-observational hook can fail open"
    assert p["order"] == ORDER, "critical choke-point order changed"
    assert p["order"].index("declare_adopt") < p["order"].index("invoke")
    assert p["order"].index("scope_authorize") < p["order"].index("invoke")
    assert p["order"].index("read_back_evidence") < p["order"].index("settle_invalidate")

    storage = p["storage"]
    assert set(storage["durable_rows"]) == {"ContractDeclaration", "ContractOccurrence", "ContractEvidence"}
    assert set(storage["forbidden_ledgers"]) == {"HookOccurrence", "ContextEnvelope"}, "parallel ledger admitted"
    assert storage["context"] == "contract_read_projection", "context is not a Contract read projection"

    cf = p["cloudflare"]
    assert cf["deployment_authority"] == "authorized_contract_occurrence"
    assert cf["required_scope"] == "cloudflare.deploy"
    assert set(cf["pins"]) == {"verified_tenant", "account", "audience", "artifact_digest", "endpoint_generation"}
    assert cf["settlement"] == "provider_read_back_evidence"
    assert cf["prompt_only_authority"] is False, "prompt granted ambient Cloudflare authority"
    assert cf["caller_chosen_endpoint_id"] is False, "caller chose endpoint"

    claims = p["claims"]
    assert claims["hermetic_gate"] is True
    assert claims["native_verified_ingress_shared_choke"] == "implemented", "native ingress status regressed"
    assert claims["public_rust_composition_faces"] == "implemented", "public composition status regressed"
    assert claims["provider_worker_raw_byte_path"] == "hermetic_implemented", "hermetic provider path status regressed"
    assert claims["authorized_live_cloudflare_provider_deployment"] == "absent_without_scoped_credentials", "hermetic evidence was promoted to a live claim"
    assert set(claims["live_missing"]) == {"scoped_provider_credentials",
        "authorized_cloudflare_deployment_receipt", "provider_read_back_evidence"}

validate(policy)

# Exercise the declared replay rule rather than accepting labels alone.
def classify(original, candidate):
    tuple_fields = policy["identity"]["occurrence_tuple"]
    if any(original[k] != candidate[k] for k in tuple_fields):
        return "distinct"
    authority = ["authenticated_subject", "verified_tenant", "audience",
                 "granted_scopes", "credential_generation", "endpoint_generation"]
    if any(original[k] != candidate[k] for k in authority):
        return "conflict"
    return "replay" if original["raw_body_digest"] == candidate["raw_body_digest"] else "conflict"
base = {"nonce_namespace":"stripe", "idempotency_key":"delivery-7", "contract_root":"root-a",
        "authenticated_subject":"provider-key-1", "verified_tenant":"tenant-a", "audience":"hook-a",
        "granted_scopes":["orders.write"], "credential_generation":"gen-3",
        "endpoint_generation":"endpoint-2", "raw_body_digest":"sha256:aaa"}
assert classify(base, copy.deepcopy(base)) == "replay"
for field, value in [("raw_body_digest", "sha256:bbb"), ("authenticated_subject", "provider-key-2"),
                     ("verified_tenant", "tenant-b"), ("audience", "hook-b"),
                     ("granted_scopes", ["admin"]), ("credential_generation", "gen-4"),
                     ("endpoint_generation", "endpoint-3")]:
    changed = copy.deepcopy(base); changed[field] = value
    assert classify(base, changed) == "conflict", f"{field} change was coalesced"
changed = copy.deepcopy(base); changed["idempotency_key"] = "delivery-8"
assert classify(base, changed) == "distinct"

# Every falsifier gets a destructive mutation. A validator that merely greps
# prose would not notice these structured policy weakenings.
mutations = []
def mutate(name, fn):
    q = copy.deepcopy(policy); fn(q); mutations.append((name, q))
mutate("second VerifiedIngress emitter", lambda q: q["verified_ingress"]["exclusive_emitters"].append("dispatcher"))
mutate("caller tenant authoritative", lambda q: q["verified_ingress"]["envelope_hints_untrusted"].remove("tenant"))
mutate("principal/session conflated", lambda q: q["identity"]["dimensions"].remove("principal"))
mutate("tenant omitted from identity matrix", lambda q: q["identity"]["dimensions"].remove("tenant"))
mutate("timestamp identity", lambda q: q["identity"].__setitem__("timestamps_in_identity", True))
mutate("payload digest not separately pinned", lambda q: q["identity"].__setitem__("payload_digest_separate", False))
mutate("reserialized signature body", lambda q: q["webhook"].__setitem__("signature_bytes", "reserialized_json"))
mutate("cross-endpoint replay", lambda q: q["webhook"]["binding"].remove("endpoint_generation"))
mutate("caller endpoint id", lambda q: q["webhook"].__setitem__("endpoint_id_source", "caller"))
mutate("mandatory projection fail-open", lambda q: q["hooks"].__setitem__("critical_failure", "fail_open"))
mutate("invoke before authorize", lambda q: q.__setitem__("order", ["normalize_confine", "authenticate", "declare_adopt", "invoke", "scope_authorize", "lease", "read_back_evidence", "settle_invalidate"]))
mutate("HookOccurrence ledger", lambda q: q["storage"]["durable_rows"].append("HookOccurrence"))
mutate("ContextEnvelope ledger", lambda q: q["storage"]["durable_rows"].append("ContextEnvelope"))
mutate("context append", lambda q: q["storage"].__setitem__("context", "context_envelope_append"))
mutate("prompt Cloudflare authority", lambda q: q["cloudflare"].__setitem__("prompt_only_authority", True))
mutate("Cloudflare settlement without read-back", lambda q: q["cloudflare"].__setitem__("settlement", "sender_report"))
mutate("native ingress marked absent", lambda q: q["claims"].__setitem__("native_verified_ingress_shared_choke", "absent"))
mutate("public faces marked design-only", lambda q: q["claims"].__setitem__("public_rust_composition_faces", "design_only"))
mutate("hermetic Worker promoted live", lambda q: q["claims"].__setitem__("provider_worker_raw_byte_path", "live_implemented"))
mutate("live deployment claimed without credentials", lambda q: q["claims"].__setitem__("authorized_live_cloudflare_provider_deployment", "implemented"))
mutate("live read-back requirement omitted", lambda q: q["claims"]["live_missing"].remove("provider_read_back_evidence"))
for name, q in mutations:
    try: validate(q)
    except (AssertionError, KeyError): pass
    else: raise AssertionError(f"falsifier escaped validator: {name}")

# Inspect actual cited repository facts. These checks bind the covenant to the
# current implementation surface rather than treating the document as evidence.
scheduler = (root / "contract/libcontract/src/scheduler.zig").read_text()
assert "fn collectDeadIds" in scheduler, "tick/plan regained per-id isDead scans"
assert scheduler.index("fn collectDeadIds") < scheduler.index("if (dead.contains(id))"), "dead-id index is unused"
ledger_src = (root / "contract/libcontract/src/ledger.zig").read_text()
acq = ledger_src.index("pub fn acquireExclusive")
house = ledger_src.index("pub fn housekeep")
assert "maybeCompact(allocator, env);" not in ledger_src[acq:acq+400], "declare lock regained inline compact"
assert house > 0 and "maybeCompact(allocator, env);" in ledger_src[house:house+200]
w6h = (root / "contract/libcontract/src/w6h.zig").read_text()
assert "pub const W6H = struct" in w6h and all((x + ":") in w6h for x in ("who", "what", "when", "where", "why", "how"))
assert "fromDeclaredRow" in w6h and "MissingWho" in w6h and "MissingHow" in w6h
schema = (root / "contract/libcontract/src/event_schema.zig").read_text()
assert "they never contain secrets" in schema and "prompts, payloads, credentials" in schema
assert "timestamp_ms: i64" in schema and "InvalidTimestamp" in schema
hook_event = (root / "aiko/crates/codegen/xai-grok-hooks/src/event.rs").read_text()
assert "pub struct HookEventEnvelope" in hook_event
assert "pub timestamp: String" in hook_event and "pub transcript_path: Option<String>" in hook_event
assert "pub session_id: String" in hook_event and "pub workspace_root: String" in hook_event
dispatcher = (root / "aiko/crates/codegen/xai-grok-hooks/src/dispatcher.rs").read_text()
assert "Hook failures" in dispatcher and "fail-open" in dispatcher
bridge = (root / "aiko/crates/codegen/xai-grok-shell/src/contract_native.rs").read_text()
assert "Every prompt is registered before it runs" in bridge

# Bind each implemented status to production modules, while keeping live provider
# deployment absent unless independent credentialed receipts are supplied.
projection = (root / "aiko/crates/codegen/xai-grok-hooks/src/contract_projection.rs").read_text()
assert "pub struct VerifiedIngress" in projection and "pub struct IngressChokePoint" in projection
assert "pub fn from_transport_auth" in projection and "raw_request: &[u8]" in projection
assert "Err(IngressError::Conflict)" in projection and "ProjectionTimeout" in projection
routes = (root / "aiko/crates/codegen/xai-grok-shell/src/contract_native/ingress_routes.rs").read_text()
assert "pub const PUBLIC_INGRESS_ROUTES: [PublicIngressRoute; 8]" in routes
for face in ("cli", "headless", "acp", "mcp", "plugin", "gateway", "webhook", "cron"):
    assert f'face: "{face}"' in routes, f"public composition face missing: {face}"
assert "shared_ingress()" in routes and "admit_public_ingress" in routes
native = (root / "aiko/crates/codegen/xai-grok-shell/src/contract_native/hook_ingress.rs").read_text()
assert "contract_declare_turn_context_json" in native and "verified_ingress" in native
assert "Contract remains the only ledger" in native
worker = (root / "aiko-flow/packages/cloudflare-webhook/src/worker.ts").read_text()
assert "request.arrayBuffer()" in worker and "verifyWebhookDelivery" in worker
assert worker.index("request.arrayBuffer()") < worker.index("const verified = await verifyWebhookDelivery")
assert "WEBHOOK_SECRETS.get" in worker and "CONTRACT_GATEWAY_AUDIENCE" in worker
worker_test = (root / "aiko-flow/packages/cloudflare-webhook/tests/worker.test.ts").read_text()
verifier_test = (root / "aiko-flow/packages/cloudflare-webhook/tests/verifiers.test.ts").read_text()
assert "verifies opaque raw bytes" in worker_test
assert "signatures computed after body mutation" in verifier_test
release_gate = (root / "tests/cloudflare-webhook-release-gate.sh").read_text()
assert "Missing credentials are an explicit capability gap" in release_gate
assert '"productionChanged":false' in release_gate

# No implementation source may introduce a forbidden parallel durable type.
for rel in ["contract", "aiko"]:
    for path in (root / rel).rglob("*"):
        if path.is_file():
            try: text = path.read_text()
            except (UnicodeDecodeError, OSError): continue
            assert "HookOccurrence" not in text, f"parallel HookOccurrence storage/type introduced: {path}"
            assert "ContextEnvelope" not in text, f"parallel ContextEnvelope storage/type introduced: {path}"

print(f"contract-hook-covenant gate: PASS ({len(mutations)} falsifier mutations rejected; native ingress/public faces/provider hermetic path inspected; live deployment absent)")
PY
