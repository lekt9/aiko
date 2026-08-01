#!/usr/bin/env python3
"""publication-morphogenesis limb conformance witness.

Drives the REAL public CLI (`neuron limb admit|run|revoke|detach`, `neuron agent
init`, `neuron port publish|attach|detach|revoke|list|http`) from an empty
directory and asserts against durable substrate state, real HTTP status lines,
and the boundary's own typed refusals — never stdout resemblance.

The loop under test is inbound interface morphogenesis: a publication gap goes
in, and a published interface that a real listener actually serves comes out —
or nothing does.

  A. reuse search over the node's own port census says `generate`;
  B. the drafter resolves a handler out of the ADMITTED-LIMB census and writes
     an inert `neuron.published-interface/v1` document;
  C. that generated document is handed to the kernel verbs `port publish` and
     `port attach` verbatim. It is accepted, which is the assertion: a document
     that merely looked like a contract would be refused here;
  D. a REAL HTTP client calls the route over a REAL `neuron port http` listener
     in a SEPARATE PROCESS, and the judge verifies the answer;
  E. refusal 1 — a second gap over the same contract resolves to `reuse` and
     the drafter REFUSES to draft, so no second live route ever exists;
  F. refusal 2 — a port whose handler publishes and attaches but answers
     WRONGLY is judged `retire`, and the retirement is executed through the
     kernel verbs until the route 404s over the listener;
  G. refusal 3 — the retired gap has NO pattern record, and the verified gap's
     record only ever advances on a fresh over-the-listener success;
  H. the CRITICAL requirement, enforced inside the limb: the identical probe
     re-labelled as an in-process observation is REFUSED. An in-process probe
     proves the limb works, not that the port works.

Run with PYTHONDONTWRITEBYTECODE=1 and ship no __pycache__: a .pyc inside a
digest-pinned package changes the admission digest with the Python version.
"""

import binascii
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

LIMB_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
REPO = os.path.abspath(os.path.join(LIMB_DIR, "..", ".."))
NEURON = os.path.join(REPO, "zig-out", "bin", "neuron")
if not os.path.exists(NEURON):
    NEURON = "neuron"

sys.path.insert(0, os.path.join(LIMB_DIR, "..", "shared"))
from _neuron import canonical

# A .pyc written into a digest-pinned package would change its admission digest
# with the interpreter version, so the whole witness runs bytecode-free.
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")

AGENT = "porter"


def fail(message):
    raise SystemExit(f"FAIL: {message}")


def run(cmd, check=True):
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, env=ENV)
    if check and proc.returncode != 0:
        fail(f"{' '.join(cmd)} exited {proc.returncode}\n{proc.stdout}\n{proc.stderr}")
    return proc


# ---------------------------------------------------------------------------
# Durable state. Every assertion below reads through these, not through stdout.
# ---------------------------------------------------------------------------

def journal_artifacts(state):
    """Every committed artifact, latest write wins. The journal is the durable
    record; artifact bytes are stored hex-encoded."""
    out = {}
    path = os.path.join(state, "substrate.log")
    if not os.path.exists(path):
        return out
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        for art in record.get("artifacts", []):
            try:
                body = binascii.unhexlify(art["bytes"]).decode()
            except Exception:
                continue
            out[art["id"]] = (art.get("schema", ""), body)
    return out


def artifact(state, artifact_id, required=True):
    entry = journal_artifacts(state).get(artifact_id)
    if entry is None:
        if required:
            fail(f"durable state carries no artifact {artifact_id}")
        return None
    return json.loads(entry[1])


def slug(gap_id):
    return hashlib.sha256(gap_id.encode()).hexdigest()[:32]


def limb_census(state):
    """The node's admitted limbs, read out of its own limb-admission records."""
    ids = json.loads(run([NEURON, "limb", "inspect", state, "--json"]).stdout)["artifact_ids"]
    arts = journal_artifacts(state)
    limbs = []
    for artifact_id in ids:
        if "/limbs/admitted/" not in artifact_id:
            continue
        entry = arts.get(artifact_id)
        if entry is None:
            continue
        record = json.loads(entry[1])
        manifest = json.loads(record["package"])
        limbs.append({
            "digest": record["digest"],
            "package": manifest.get("package", ""),
            "version": manifest.get("version", ""),
            "neurons": [
                {"id": n.get("id", ""),
                 "accepts": n.get("accepts", []),
                 "emits": n.get("emits", [])}
                for n in manifest.get("neurons", [])
            ],
        })
    return {"schema": "neuron.limb-census/v1", "limbs": limbs}


def port_census(node, agent):
    """The node's published interfaces plus which of them are LIVE.

    Digests and live routes come from `neuron port list`; the typed surface of
    each port comes from its own durable `interfaces/published/<hex>` record. A
    published record is not an edge, so `live` is decided by the route table.
    """
    state = os.path.join(node, "state")
    listing = json.loads(run([NEURON, "port", "list", node, "--agent", agent, "--json"]).stdout)
    arts = journal_artifacts(state)
    ports = []
    for hexd in listing["published"]:
        entry = arts.get("interfaces/published/" + hexd)
        if entry is None:
            continue
        record = json.loads(entry[1])
        manifest = json.loads(record["manifest"])
        path = manifest["bind"]["path"]
        ports.append({
            "published": hexd,
            "id": manifest["id"],
            "path": path,
            "method": manifest["bind"].get("method", "POST"),
            "mode": manifest["invocation"]["mode"],
            "accepts": manifest["accepts"],
            "emits": manifest["emits"],
            "errors": manifest["errors"],
            "live": f"/agents/{agent}{path}" in listing["routes"],
            "revoked": ("interfaces/published-revoked/" + hexd) in arts,
        })
    return {"schema": "neuron.port-census/v1", "agent": agent,
            "routes": listing["routes"], "ports": ports}


# ---------------------------------------------------------------------------
# Firing the limb through the real admitted path
# ---------------------------------------------------------------------------

def read_of(read_id, schema, obj):
    body = canonical(obj).decode()
    return {"id": read_id, "schema": schema, "bytes": body,
            "digest": hashlib.sha256(body.encode()).hexdigest()}


def prior_reads(state, *artifact_ids):
    """Stage the records a firing is about to replace, verbatim from durable
    state. The interpreter refuses a write over an artifact whose prior digest
    the decision does not name, so a neuron that was not handed the record it
    would overwrite fails closed instead of clobbering it."""
    arts = journal_artifacts(state)
    out = []
    for artifact_id in artifact_ids:
        entry = arts.get(artifact_id)
        if entry is None:
            continue
        schema, body = entry
        out.append({"id": artifact_id, "schema": schema, "bytes": body,
                    "digest": hashlib.sha256(body.encode()).hexdigest()})
    return out


def limb_run(state, neuron_id, firing_id, reads, receptor, expect_failure=False):
    stim = {
        "schema": "neuron.stimulus/v1",
        "firing_id": firing_id,
        "receptor_schema": receptor,
        "now_ms": 0,
        "reads": reads,
        "permitted_reads": [r["id"] for r in reads],
        "messages": [],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stim, fh)
        path = fh.name
    try:
        proc = run([NEURON, "limb", "run", state, "--package", LIMB_DIR,
                    "--neuron", neuron_id, "--stimulus", path, "--json"],
                   check=not expect_failure)
        if expect_failure:
            return proc
        return json.loads(proc.stdout) if proc.stdout.strip() else None
    finally:
        os.unlink(path)


# ---------------------------------------------------------------------------
# The listener. A separate PROCESS, a real socket, a real HTTP client.
# ---------------------------------------------------------------------------

class Listener:
    def __init__(self, node, log_path):
        self.node = node
        self.log_path = log_path
        self.proc = None
        self.address = None

    def __enter__(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        self.address = f"127.0.0.1:{port}"
        self.log = open(self.log_path, "w")
        self.proc = subprocess.Popen(
            [NEURON, "port", "http", self.node, "--listen", self.address],
            stdout=self.log, stderr=subprocess.STDOUT, env=ENV)
        deadline = time.time() + 15
        while time.time() < deadline:
            if self.proc.poll() is not None:
                fail(f"the listener exited: {open(self.log_path).read()[:2000]}")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    return self
            except OSError:
                time.sleep(0.1)
        fail("the listener never came up")

    def __exit__(self, *exc):
        if self.proc is not None:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        self.log.close()

    def call(self, path, body, method="POST", key=None):
        """One real HTTP request across the socket. Returns the observation a
        publication probe is built from — status, headers and body as they came
        off the wire."""
        url = f"http://{self.address}{path}"
        request = urllib.request.Request(
            url, data=body.encode(), method=method,
            headers={"Content-Type": "application/json",
                     **({"X-Neuron-Idempotency-Key": key} if key else {})})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, headers, text = response.status, response.headers, response.read().decode()
        except urllib.error.HTTPError as err:
            status, headers, text = err.code, err.headers, err.read().decode()
        return {
            "url": url, "method": method, "status": status,
            "product_schema": headers.get("X-Neuron-Product-Schema", ""),
            "product_digest": headers.get("X-Neuron-Product-Digest", ""),
            "neuron_status": headers.get("X-Neuron-Status", ""),
            "response_body": text,
        }


def probe_doc(gap, published, agent, listener, observation, transport="http-listener"):
    return {
        "schema": "neuron.publication-probe/v1",
        "gap": gap["id"], "published": published, "agent": agent,
        "transport": transport, "listener": listener,
        "request_body": gap["_probe_body"],
        **{k: observation[k] for k in
           ("url", "method", "status", "product_schema", "product_digest",
            "neuron_status", "response_body")},
    }


# ---------------------------------------------------------------------------
# Handler limb packages the witness writes itself
# ---------------------------------------------------------------------------

HANDLER_PY = '''#!/usr/bin/env python3
import hashlib, json, sys
stim = json.load(sys.stdin)
prefix = stim.get("caps", {}).get("write_prefix", "")
reads = stim.get("reads", [])
body = json.loads(reads[0]["bytes"]) if reads else {}
product = json.dumps({"schema": %(emits)r, "answer": %(answer_expr)s})
slot = hashlib.sha256(stim["firing_id"].encode()).hexdigest()[:16]
print(json.dumps({
    "schema": "neuron.decision/v1",
    "control": {"kind": "terminate", "result": "served"},
    "effects": [{"kind": "write", "artifact": {
        "id": prefix + "product/" + slot, "schema": %(emits)r, "bytes": product}}],
    "evidence": [{"claim": "answer derived from the admitted request body",
                  "method": "pure function of the stimulus",
                  "sources": [reads[0]["id"] if reads else "stimulus"]}]
}))
'''


def write_handler(root, name, neuron_id, accepts, emits, answer_expr):
    package = os.path.join(root, name)
    os.makedirs(os.path.join(package, "neurons"), exist_ok=True)
    manifest = {
        "schema": "typed-neuron.limb-manifest/v1",
        "package": f"witness/{name}",
        "version": "0.1.0",
        "description": f"Witness handler {name}.",
        "neurons": [{
            "id": neuron_id,
            "accepts": accepts,
            "emits": emits,
            "argv": ["python3", f"neurons/{neuron_id}.py"],
            "caps_request": {
                "allow_write": True, "write_prefix": "agents/",
                "allow_send": False, "allow_spawn": False,
                "budget": {"max_effects": 4, "max_writes": 2, "max_messages": 0,
                           "max_spawns": 0, "max_bytes": 65536, "max_depth": 1,
                           "max_turns": 1},
            },
        }],
        "budgets": {"deadline_ms_per_firing": 10000},
    }
    with open(os.path.join(package, "neuron.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
    with open(os.path.join(package, "neurons", f"{neuron_id}.py"), "w") as fh:
        fh.write(HANDLER_PY % {"emits": emits[0], "answer_expr": answer_expr})
    return package


# ---------------------------------------------------------------------------
# The gaps. Only `_probe_body` is witness bookkeeping; everything else is the
# operator-authored document, and every route, schema and digest downstream is
# read back out of it.
# ---------------------------------------------------------------------------

GAP_A = {
    "id": "witness/greet", "version": "1.0.0",
    "need": "a caller hands this node a name and receives a typed greeting",
    "route": "/greet", "method": "POST", "mode": "read",
    "accepts": ["witness.greet-request/v1"], "emits": ["witness.greeting/v1"],
    "errors": ["witness.greet-failed/v1"],
    "callers": ["ip4:127.0.0.1"], "idempotency": "keyed",
    "firing_id_source": "caller_supplied",
    "expect_contains": "hello ada",
    "_probe_body": '{"name": "ada"}',
}

# The same CONTRACT at a different route. Reuse must find the live port and
# refuse generation: a gap asks for a capability, not for a URL.
GAP_B = dict(GAP_A, id="witness/greet-again", route="/greet-v2")

# A different contract, served by a handler that answers WRONGLY. It publishes,
# it attaches, it returns 200 under the promised schema — and it still does not
# serve the gap.
GAP_C = {
    "id": "witness/tally", "version": "1.0.0",
    "need": "a caller hands this node a count and receives the running total",
    "route": "/tally", "method": "POST", "mode": "read",
    "accepts": ["witness.tally-request/v1"], "emits": ["witness.tally/v1"],
    "errors": ["witness.tally-failed/v1"],
    "callers": ["ip4:127.0.0.1"], "idempotency": "keyed",
    "firing_id_source": "caller_supplied",
    "expect_contains": "total 42",
    "_probe_body": '{"count": 42}',
}


def gap_read(gap, name):
    document = {k: v for k, v in gap.items() if not k.startswith("_")}
    return read_of(f"witness/gap/{name}", "neuron.publication-gap/v1", document)


# ---------------------------------------------------------------------------
# One full pass of the loop, driven entirely through the public CLI
# ---------------------------------------------------------------------------

def plan_id(gap):
    return "publication-morphogenesis/plans/" + slug(gap["id"])


def pattern_id(gap):
    return "publication-morphogenesis/patterns/" + slug(gap["id"])


def verdict_id(gap):
    return "publication-morphogenesis/verdicts/" + slug(gap["id"])


def draft_id(gap):
    return "publication-morphogenesis/drafts/" + slug(gap["id"])


def record_id(gap):
    return "publication-morphogenesis/draft-records/" + slug(gap["id"])


def search(state, node, gap, name, firing, extra=(), expect_failure=False):
    reads = [gap_read(gap, name),
             read_of("witness/port-census", "neuron.port-census/v1", port_census(node, AGENT))]
    # This gap's own pattern is both the ranking input and the prior the plan
    # write compares against.
    reads += prior_reads(state, plan_id(gap), pattern_id(gap), *extra)
    proc = limb_run(state, "reuse-searcher", firing, reads,
                    "neuron.publication-gap/v1", expect_failure=expect_failure)
    if expect_failure:
        return proc
    return artifact(state, plan_id(gap))


def draft(state, gap, name, plan, firing, expect_failure=False):
    reads = [gap_read(gap, name),
             read_of("witness/plan", "neuron.publication-plan/v1", plan),
             read_of("witness/limb-census", "neuron.limb-census/v1", limb_census(state))]
    reads += prior_reads(state, draft_id(gap), record_id(gap))
    return limb_run(state, "port-drafter", firing, reads,
                    "neuron.publication-gap/v1", expect_failure=expect_failure)


def judge(state, gap, name, probe, firing, expect_failure=False):
    reads = [gap_read(gap, name),
             read_of("witness/probe", "neuron.publication-probe/v1", probe)]
    reads += prior_reads(state, verdict_id(gap), pattern_id(gap))
    return limb_run(state, "publication-judge", firing, reads,
                    "neuron.publication-probe/v1", expect_failure=expect_failure)


def publish_and_attach(node, state, gap, handler_package):
    """Hand the GENERATED document to the kernel verbs, verbatim."""
    document = artifact(state, draft_id(gap))
    path = os.path.join(node, f"drafted-{slug(gap['id'])}.json")
    with open(path, "w") as fh:
        json.dump(document, fh)
    published = json.loads(
        run([NEURON, "port", "publish", node, path, "--json"]).stdout)["published"]
    if len(published) != 64:
        fail("port publish did not return a digest")
    run([NEURON, "port", "attach", node, AGENT, "--published", published,
         "--handler", handler_package, "--json"])
    return document, published


def main():
    root = tempfile.mkdtemp(prefix="publication-morphogenesis.")
    node = os.path.join(root, "node")
    state = os.path.join(node, "state")
    print("root:", root)

    # --- admit the limb itself, through the real path ----------------------
    run([NEURON, "agent", "init", node, AGENT])
    digest = run([NEURON, "limb", "admit", LIMB_DIR, state]).stdout.strip().split()[-1]
    if len(digest) != 64:
        fail("the limb was not admitted")
    if digest != run([NEURON, "limb", "admit", LIMB_DIR, state]).stdout.strip().split()[-1]:
        fail("admission is not digest-stable")
    print("admitted digest:", digest)

    greeter = write_handler(root, "greeter", "greeter", GAP_A["accepts"], GAP_A["emits"],
                            '"hello " + str(body.get("name", "world"))')
    liar = write_handler(root, "liar", "tallier", GAP_C["accepts"], GAP_C["emits"],
                         '"total " + str(int(body.get("count", 0)) + 1)')
    run([NEURON, "limb", "admit", greeter, state])
    run([NEURON, "limb", "admit", liar, state])

    # --- A. the reuse search runs first and finds nothing -------------------
    plan_a = search(state, node, GAP_A, "a", "witness/search/a")
    if plan_a["route"] != "generate":
        fail(f"an empty node resolved to {plan_a['route']}")
    if plan_a["candidates_considered"] != 0:
        fail("the search saw ports on an empty node")
    print("A. reuse search on an empty node: generate")

    # --- B. generation: an inert document, from substrate state -------------
    draft(state, GAP_A, "a", plan_a, "witness/draft/a")
    document, published_a = publish_and_attach(node, state, GAP_A, greeter)
    record = artifact(state, "publication-morphogenesis/draft-records/" + slug(GAP_A["id"]))

    # The handler was RESOLVED from the admitted-limb census, not named by the
    # gap: the gap document has no handler_digest field at all.
    census_digests = {limb["digest"] for limb in limb_census(state)["limbs"]}
    if record["handler_digest"] not in census_digests:
        fail("the drafted handler digest is not an admitted limb")
    if document["handler_digest"] != record["handler_digest"]:
        fail("the draft and its provenance record disagree on the handler")
    # A contract never names its own authority: the kernel derives both prefixes
    # from (agent, published digest) at attach time.
    if "write_prefix" in document["requested_caps"] or "send_prefix" in document["requested_caps"]:
        fail("the generated contract named its own capability namespace")
    if document["requested_caps"]["allow_send"]:
        fail("a generated read contract may not send")
    print(f"B. generated + published + attached: {published_a[:16]}")

    # --- C/D. a real HTTP client over a real listener ------------------------
    route = f"/agents/{AGENT}{GAP_A['route']}"
    with Listener(node, os.path.join(root, "serve-a.log")) as listener:
        observation = listener.call(route, GAP_A["_probe_body"], key="probe-1")
        if observation["status"] != 200:
            fail(f"the generated port answered {observation['status']}: {observation}")
        probe = probe_doc(GAP_A, published_a, AGENT, listener.address, observation)

        # H. THE CRITICAL REFUSAL. The identical observation, re-labelled as an
        # in-process one, must be refused — and nothing may be written.
        in_process = dict(probe, transport="in-process")
        rejected = judge(state, GAP_A, "a", in_process, "witness/judge/in-process",
                         expect_failure=True)
        if rejected.returncode == 0:
            fail("an in-process probe was accepted as evidence about a port")
        # The typed rejection class, as the harness itself reports it — not the
        # neuron's own message text.
        if "ScriptInsufficientEvidence" not in rejected.stderr:
            fail(f"the in-process probe was refused for the wrong reason: {rejected.stderr}")
        if artifact(state, verdict_id(GAP_A), required=False) is not None:
            fail("a refused probe still produced a verdict")

        # A probe that names a listener it did not cross is refused the same way.
        forged = dict(probe, listener="127.0.0.1:1")
        if judge(state, GAP_A, "a", forged, "witness/judge/forged",
                 expect_failure=True).returncode == 0:
            fail("a probe whose url did not match its attested listener was accepted")
        print("H. in-process and mis-attested probes: REFUSED")

        # The real one is accepted.
        judge(state, GAP_A, "a", probe, "witness/judge/a")

    verdict_a = artifact(state, verdict_id(GAP_A))
    if not verdict_a["verified"] or verdict_a["action"] != "retain":
        fail(f"a working port was not retained: {verdict_a}")
    pattern_a = artifact(state, pattern_id(GAP_A))
    if pattern_a["verified_successes"] != 1 or pattern_a["interface"] != published_a:
        fail(f"the verified pattern is wrong: {pattern_a}")
    print("C/D. served over the listener and verified · pattern successes = 1")

    # --- E. refusal 1: reuse is searched before generation -------------------
    plan_b = search(state, node, GAP_B, "b", "witness/search/b", extra=[pattern_id(GAP_A)])
    if plan_b["route"] != "reuse":
        fail(f"a live port over the same contract did not resolve to reuse: {plan_b}")
    if plan_b["reuse_published"] != published_a:
        fail("reuse named the wrong port")
    # A pattern belongs to one gap. GAP_B reuses the port on its typed surface,
    # but it does not inherit a ranking earned by another gap.
    if plan_b["reuse_verified_successes"] != 0:
        fail("a different gap inherited a ranking it never earned")
    # The ranking IS read for the gap that earned it.
    plan_a2 = search(state, node, GAP_A, "a", "witness/search/a-ranked")
    if plan_a2["route"] != "reuse" or plan_a2["reuse_verified_successes"] != 1:
        fail(f"the verified pattern did not rank its own port: {plan_a2}")
    refused = draft(state, GAP_B, "b", plan_b, "witness/draft/b", expect_failure=True)
    if refused.returncode == 0:
        fail("a second port was drafted over a contract already served")
    if "ScriptInvariantViolation" not in refused.stderr:
        fail(f"the duplicate draft was refused for the wrong reason: {refused.stderr}")
    if artifact(state, draft_id(GAP_B), required=False) is not None:
        fail("the refused draft still landed in durable state")
    routes = json.loads(
        run([NEURON, "port", "list", node, "--agent", AGENT, "--json"]).stdout)["routes"]
    if routes != [route]:
        fail(f"the node grew a second route for the same contract: {routes}")
    print("E. refusal 1 — a contract already served spawns no second port")

    # A plan for a different gap does not authorize this one either.
    if draft(state, GAP_B, "b", dict(plan_a, route="generate"), "witness/draft/b-borrowed",
             expect_failure=True).returncode == 0:
        fail("a plan belonging to another gap authorized a draft")

    # --- F. refusal 2: nothing is retained on compilation alone -------------
    plan_c = search(state, node, GAP_C, "c", "witness/search/c")
    if plan_c["route"] != "generate":
        fail("a genuinely new contract did not resolve to generate")
    draft(state, GAP_C, "c", plan_c, "witness/draft/c")
    _, published_c = publish_and_attach(node, state, GAP_C, liar)
    route_c = f"/agents/{AGENT}{GAP_C['route']}"

    with Listener(node, os.path.join(root, "serve-c.log")) as listener:
        observation_c = listener.call(route_c, GAP_C["_probe_body"], key="probe-c")
        # It publishes, it attaches, it answers 200 under the promised schema.
        if observation_c["status"] != 200:
            fail(f"the liar port did not even answer: {observation_c}")
        if observation_c["product_schema"] != GAP_C["emits"][0]:
            fail("the liar port answered outside its own contract, weakening the test")
        judge(state, GAP_C, "c", probe_doc(GAP_C, published_c, AGENT,
                                           listener.address, observation_c),
              "witness/judge/c")

    verdict_c = artifact(state, verdict_id(GAP_C))
    if verdict_c["verified"] or verdict_c["action"] != "retire":
        fail(f"a port that does not serve its gap was retained: {verdict_c}")
    if not verdict_c["retire_calls"]:
        fail("a retire verdict named no withdrawal")

    # --- G. refusal 3: no pattern for a port that never worked --------------
    if artifact(state, pattern_id(GAP_C), required=False) is not None:
        fail("a retired port trained the ranking")
    print("F/G. refusal 2 + 3 — 200 with the wrong answer is retired, and unranked")

    # The verdict is carried out through the kernel verbs, and the route dies.
    run([NEURON, "port", "detach", node, AGENT, "--published", published_c])
    run([NEURON, "port", "revoke", node, "--published", published_c])
    with Listener(node, os.path.join(root, "serve-c2.log")) as listener:
        after = listener.call(route_c, GAP_C["_probe_body"], key="probe-c2")
        if after["status"] != 404:
            fail(f"a retired port still answered {after['status']}")
        still = listener.call(route, GAP_A["_probe_body"], key="probe-a2")
        if still["status"] != 200:
            fail("retiring one port took the verified one down with it")
    routes = json.loads(
        run([NEURON, "port", "list", node, "--agent", AGENT, "--json"]).stdout)["routes"]
    if routes != [route]:
        fail(f"the retired route survived detach: {routes}")
    # The audit record survives the withdrawal: retirement is not erasure.
    if "interfaces/published/" + published_c not in journal_artifacts(state):
        fail("the publication record did not survive revocation")
    print("G. retirement executed through the kernel verbs · route 404s · record intact")

    # --- refusal 3, the other half: a pattern only advances on a fresh,
    #     verified, over-the-listener success ---------------------------------
    with Listener(node, os.path.join(root, "serve-a2.log")) as listener:
        again = listener.call(route, GAP_A["_probe_body"], key="probe-2")
        fresh = probe_doc(GAP_A, published_a, AGENT, listener.address, again)

        # An observation of some OTHER served surface, on the same live
        # listener, is not evidence about this gap's route.
        elsewhere = dict(fresh, url=f"http://{listener.address}/agents/{AGENT}/elsewhere")
        if judge(state, GAP_A, "a", elsewhere, "witness/judge/elsewhere",
                 expect_failure=True).returncode == 0:
            fail("a probe of another route was accepted as evidence about this one")

        judge(state, GAP_A, "a", fresh, "witness/judge/a2")
    advanced = artifact(state, pattern_id(GAP_A))
    if advanced["verified_successes"] != 2:
        fail(f"a second verified success did not advance the ranking: {advanced}")
    if advanced["interface"] != published_a:
        fail("the advanced pattern names the wrong interface")
    print("G. pattern advanced to 2 on a fresh verified probe")

    # --- lifecycle: duplicate, mismatch, revoke, detach ----------------------
    # A redelivery is the SAME firing id over the SAME stimulus. The reads are
    # built once and replayed verbatim, because `now_ms` and every staged digest
    # are inside the firing identity.
    dup_reads = [gap_read(GAP_A, "a"),
                 read_of("witness/port-census", "neuron.port-census/v1",
                         port_census(node, AGENT))]
    dup_reads += prior_reads(state, plan_id(GAP_A), pattern_id(GAP_A))
    first = limb_run(state, "reuse-searcher", "witness/search/dup", dup_reads,
                     "neuron.publication-gap/v1")
    if first["effects_committed"] != 1:
        fail(f"the first firing committed {first['effects_committed']} effects")
    dup = limb_run(state, "reuse-searcher", "witness/search/dup", dup_reads,
                   "neuron.publication-gap/v1")
    if dup["duplicates_skipped"] <= 0:
        fail("a redelivered firing was not suppressed")
    if dup["effects_committed"] != 0:
        fail("a redelivered firing committed effects a second time")

    # The same identity over a DIFFERENT stimulus is a contradiction, not a
    # replay, and fails closed rather than overwriting the settled result.
    contradiction = limb_run(state, "reuse-searcher", "witness/search/dup",
                             dup_reads[:1] + [read_of(
                                 "witness/port-census", "neuron.port-census/v1",
                                 {"schema": "neuron.port-census/v1", "agent": AGENT,
                                  "routes": [], "ports": []})],
                             "neuron.publication-gap/v1", expect_failure=True)
    if contradiction.returncode == 0:
        fail("a settled firing id accepted a different decision")

    run([NEURON, "limb", "revoke", state, "--package", LIMB_DIR])
    revoked = limb_run(state, "reuse-searcher", "witness/search/post-revoke",
                       [gap_read(GAP_A, "a"),
                        read_of("witness/port-census", "neuron.port-census/v1",
                                port_census(node, AGENT))],
                       "neuron.publication-gap/v1", expect_failure=True)
    if revoked.returncode == 0:
        fail("a revoked limb still fired")

    pre = json.loads(run([NEURON, "limb", "inspect", state, "--json"]).stdout)
    run([NEURON, "limb", "detach", state, "--package", LIMB_DIR])
    post = json.loads(run([NEURON, "limb", "inspect", state, "--json"]).stdout)
    if post["detached"] < 1 or post["firings"] < pre["firings"]:
        fail("detach lost audit firings")
    print(f"lifecycle: duplicate-proof · revoked · detached · {pre['firings']} firings intact")

    # No bytecode may be left inside a digest-pinned package.
    for base, dirs, _ in os.walk(LIMB_DIR):
        if "__pycache__" in dirs:
            fail(f"__pycache__ inside the pinned package: {os.path.join(base, '__pycache__')}")
    if run([NEURON, "limb", "admit", LIMB_DIR, state],
           check=False).stdout.strip().split()[-1] != digest:
        fail("the package digest moved during the run")

    shutil.rmtree(root, ignore_errors=True)
    print("\npublication-morphogenesis limb conformance: PASS")
    print(f"digest {digest} — searched · generated · published · attached · "
          f"served over a real listener · verified · duplicate-refused · retired · unranked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
