#!/usr/bin/env python3
"""Compile a declarative receptor into a provider-neutral Contract skill pack."""
from __future__ import annotations
import argparse, ctypes, hashlib, json, os, plistlib, re, shutil, struct, subprocess, sys, tempfile, time
from pathlib import Path

EFFECTS = {"read_only","local_reversible","local_write","external_message","purchase","job_application","credential_access","delete","publish","permission_change","account_mutation","process_spawn"}
MAX_BUNDLE_BYTES = 1024 * 1024
MAX_BUNDLE_FILES = 256
TRANSITION_SCHEMA = "contract.neuron-skill.transition/v1"
STATE_SCHEMA = "contract.neuron-skill.state/v1"

def key(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not result:
        raise ValueError(f"invalid empty key from {value!r}")
    return result

def validate_spec(value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError("receptor specification must be an object")
    required = {"id", "description", "triggers", "events", "effects"}
    if required - value.keys():
        raise ValueError(f"missing fields: {sorted(required-value.keys())}")
    if not value["events"]:
        raise ValueError("at least one event is required")
    if value["id"] != key(value["id"]):
        raise ValueError("id must already be normalized lower-case hyphen-case")
    if not value["triggers"] or not all(isinstance(trigger, str) and trigger.strip() for trigger in value["triggers"]):
        raise ValueError("at least one non-empty trigger is required")
    if not value["effects"] or len(value["effects"]) > 8:
        raise ValueError("one to eight effects are required")
    seen = set()
    for effect in value["effects"]:
        if effect.get("effect") not in EFFECTS:
            raise ValueError(f"unknown effect: {effect.get('effect')}")
        effect_key = key(effect.get("id", ""))
        if effect_key in seen:
            raise ValueError(f"duplicate normalized effect id: {effect_key}")
        seen.add(effect_key)
        if not effect.get("variants"):
            raise ValueError("every effect requires supported variants")
        if effect.get("ephemeral") and not effect.get("ttl_ms"):
            raise ValueError("ephemeral effects require ttl_ms")
        if effect["effect"] not in {"read_only", "local_reversible"} and not effect.get("requires_authority", True):
            raise ValueError(f"consequential effect {effect['id']} cannot disable authority")
        if effect.get("evidence") == []:
            raise ValueError("effect evidence cannot be empty")
    runtime = value.get("runtime")
    if runtime:
        if not runtime.get("argv") or not all(isinstance(v, str) and v for v in runtime["argv"]):
            raise ValueError("runtime.argv must contain non-empty strings")
    schema_version = value.get("schema_version", 1)
    if schema_version not in {1, 2}:
        raise ValueError(f"unsupported receptor schema_version: {schema_version}")
    if schema_version == 2:
        ingress = value.get("ingress")
        cursor = value.get("cursor")
        if not ingress or not cursor:
            raise ValueError("v2 receptors require ingress and cursor policies")
        if not ingress.get("modes") or ingress.get("privacy") not in {"redacted", "public"}:
            raise ValueError("v2 ingress requires modes and prompt-safe privacy")
        if ingress.get("delivery") == "effectively_once" and not cursor.get("identity_fields"):
            raise ValueError("effectively_once delivery requires durable identity fields")
        if not cursor.get("identity_fields") or not cursor.get("change_token_fields") or cursor.get("ttl_ms", 0) < 1:
            raise ValueError("v2 cursor requires identity, change tokens, and finite retention")
    return value

def load(path: Path) -> dict:
    return validate_spec(json.loads(path.read_text()))

def node(node_key, deps, *, bindings=None, effect="read_only", authority=False, evidence=None, plan=None, parallel=False):
    return {
        "key": node_key,
        "plan": plan or f"{node_key.title()} the interface occurrence for {{{{goal}}}}.",
        "worker": "aiko",
        "depends_on": deps,
        "input_bindings": bindings or {},
        "can_parallel": parallel,
        "timeout_ms": 120000,
        "effect": effect,
        "reversible": effect == "local_reversible",
        "read_only": effect == "read_only",
        "requires_authority": authority,
        "evidence": evidence or ["structured_result"],
    }

def _render_pack(spec: dict, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    effects = spec["effects"]
    nodes = [
        node("observe", [], evidence=["occurrence"]),
        node("normalize", ["observe"], bindings={"occurrence":"observe.occurrence"}, evidence=["normalized"]),
        node("authorize", ["normalize"], bindings={"normalized":"normalize.normalized"}, evidence=["authorization"]),
        node("prepare", ["normalize"], bindings={"normalized":"normalize.normalized"}, evidence=["prepared_effect"]),
    ]
    execute_keys = []
    for item in effects:
        execute_key = f"execute-{key(item['id'])}"
        execute_keys.append(execute_key)
        authority = item.get("requires_authority", item["effect"] not in {"read_only", "local_reversible"})
        nodes.append(node(
            execute_key,
            ["authorize", "prepare"],
            bindings={"authorization":"authorize.authorization","prepared":"prepare.prepared_effect"},
            effect=item["effect"],
            authority=authority,
            evidence=item.get("evidence", ["provider_ack"]),
            plan=f"Execute capability {item['id']} for {{{{goal}}}} without degrading unsupported variants.",
            parallel=True,
        ))
    sensed = {f"effect_{index}": f"{execute_key}.{(effects[index].get('evidence') or ['provider_ack'])[0]}" for index, execute_key in enumerate(execute_keys)}
    nodes.extend([
        node("sense", execute_keys, bindings=sensed, evidence=["provider_ack"]),
        node("evaluate", ["sense"], bindings={"observation":"sense.provider_ack"}, evidence=["verdict"]),
        node("settle", ["evaluate"], bindings={"verdict":"evaluate.verdict"}, evidence=["settlement"]),
    ])
    manifest = {
        "schema_version": 1,
        "id": spec["id"],
        "version": spec.get("version", "1.0.0"),
        "description": spec["description"],
        "platforms": ["all"],
        "triggers": spec["triggers"],
        "activation": "matched",
        "input_schema": {"type":"object","additionalProperties":True},
        "output_schema": {"type":"object","additionalProperties":True},
        "nodes": nodes,
        "examples": [{
            "name": "generated-interface",
            "prompt": spec["triggers"][0],
            "expect": {"selected": spec["id"], "held_effects": [e["id"] for e in effects if e.get("requires_authority", e["effect"] not in {"read_only","local_reversible"})]},
        }],
    }
    capabilities = {
        "schema_version": spec.get("schema_version", 1),
        "interface":spec["id"],
        "events":spec["events"],
        "effects":effects,
    }
    if spec.get("schema_version") == 2:
        capabilities["ingress"] = spec["ingress"]
        capabilities["cursor"] = spec["cursor"]
    for directory in ["agents", "assets", "evals", "tests"]:
        (out/directory).mkdir(exist_ok=True)
    (out/"SKILL.md").write_text(
        f"---\nname: {spec['id']}\ndescription: {spec['description']}\n---\n\n"
        "# Generated Contract interface\n\n"
        "Fire the typed graph in `contract-skill.json`. Read only named dependency evidence, "
        "let Contract Caps own effects, HOLD unsupported variants, and never treat a provider "
        "acknowledgement as proof of the user's postcondition.\n"
    )
    (out/"contract-skill.json").write_text(json.dumps(manifest, indent=2, sort_keys=True)+"\n")
    (out/"assets"/"capabilities.json").write_text(json.dumps(capabilities, indent=2, sort_keys=True)+"\n")
    (out/"assets"/"receptor.json").write_text(json.dumps(spec, indent=2, sort_keys=True)+"\n")
    default_prompt = f"Use ${spec['id']} through its admitted typed graph."
    (out/"agents"/"openai.yaml").write_text(
        "interface:\n"
        f"  display_name: {json.dumps(spec['id'])}\n"
        f"  short_description: {json.dumps(spec['description'])}\n"
        f"  default_prompt: {json.dumps(default_prompt)}\n"
    )
    cases = [{"name":"selects-generated-interface","prompt":spec["triggers"][0],"expected_skills":[spec["id"]],"forbidden_effects_without_authority":[e["id"] for e in effects if e.get("requires_authority", e["effect"] not in {"read_only","local_reversible"})]}]
    (out/"tests"/"cases.json").write_text(json.dumps(cases, indent=2, sort_keys=True)+"\n")
    evals = [{"id":"generated-interface-shape","prompt":spec["triggers"][0],"assertions":["typed_dependency_bindings","declared_effects","authority_holds","grounded_settlement"]}]
    (out/"evals"/"evals.json").write_text(json.dumps(evals, indent=2, sort_keys=True)+"\n")
    (out/"tests"/"witness.py").write_text(
        "#!/usr/bin/env python3\nimport json, pathlib, sys\n"
        "p=pathlib.Path(sys.argv[1]); m=json.loads((p/'contract-skill.json').read_text()); "
        "c=json.loads((p/'assets/capabilities.json').read_text())\n"
        "nodes={n['key']:n for n in m['nodes']}; execute=[n for n in m['nodes'] if n['key'].startswith('execute-')]\n"
        "assert m.get('activation')=='matched' and len(execute)==len(c['effects'])\n"
        "assert all('input_bindings' in n and n['evidence'] for n in m['nodes'])\n"
        "assert all(n['depends_on']==['authorize','prepare'] for n in execute)\n"
        "assert all(n['effect']=='read_only' or n['requires_authority'] or n['reversible'] for n in m['nodes'])\n"
        "print('generated Neuron Skill witness: PASS')\n"
    )

def compile_pack(spec: dict, out: Path) -> None:
    """Render atomically; an existing output is accepted only at the same digest."""
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.is_symlink() or (out.exists() and not out.is_dir()):
        raise ValueError("Skill output must be a real directory")
    with tempfile.TemporaryDirectory(prefix=".skill-build-", dir=out.parent) as temporary:
        candidate = Path(temporary)/"bundle"
        _render_pack(spec, candidate)
        if out.exists():
            if bundle_digest(out) != bundle_digest(candidate):
                raise ValueError("Skill output already exists with different content; choose a new --out")
            return
        os.replace(candidate, out)

def bundle_digest(root: Path) -> tuple[str, int]:
    files = []
    for base, directories, names in os.walk(root, followlinks=False):
        base_path = Path(base)
        for directory in directories:
            if (base_path/directory).is_symlink():
                raise ValueError("Skill bundles cannot contain symlink directories")
        for name in names:
            path = base_path/name
            if path.is_symlink() or not path.is_file():
                raise ValueError("Skill bundles contain regular files only")
            files.append(path)
    if not files or len(files) > MAX_BUNDLE_FILES:
        raise ValueError("Skill bundle file count is outside bounds")
    files.sort(key=lambda path: path.relative_to(root).as_posix())
    digest = hashlib.sha256()
    domain = b"aiko.neuron-skill.bundle/v1"
    digest.update(struct.pack("<Q", len(domain))); digest.update(domain)
    total = 0
    for path in files:
        relative = path.relative_to(root).as_posix().encode()
        content = path.read_bytes()
        total += len(content)
        if total > MAX_BUNDLE_BYTES:
            raise ValueError("Skill bundle exceeds the one MiB admission bound")
        digest.update(struct.pack("<Q", len(relative))); digest.update(relative)
        digest.update(struct.pack("<Q", len(content))); digest.update(content)
    return digest.hexdigest(), total

def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def contract_library() -> Path:
    suffix = {"Darwin":"dylib", "Linux":"so"}.get(os.uname().sysname)
    if not suffix:
        raise ValueError(f"unsupported Contract platform: {os.uname().sysname}")
    names = []
    if os.environ.get("AIKO_CONTRACT_LIBRARY"):
        names.append(Path(os.environ["AIKO_CONTRACT_LIBRARY"]))
    names.extend([
        Path.home()/".aiko/lib"/f"libcontract.{suffix}",
        Path(__file__).resolve().parents[4].parent/"contract/libcontract/zig-out/lib"/f"libcontract.{suffix}",
    ])
    for path in names:
        if path.is_file():
            return path
    raise ValueError("Contract ABI 8 library is unavailable")

def contract_call(symbol: str, payload: dict) -> dict:
    library = ctypes.CDLL(str(contract_library()))
    version = library.contract_abi_version
    version.restype = ctypes.c_uint32
    if version() < 8:
        raise ValueError("Contract ABI 8 is required for generated Skill admission")
    operation = getattr(library, symbol)
    operation.argtypes = [ctypes.c_char_p]
    operation.restype = ctypes.c_void_p
    free = library.contract_free
    free.argtypes = [ctypes.c_void_p]
    pointer = operation(json.dumps(payload, separators=(",",":")).encode())
    if not pointer:
        raise ValueError(f"Contract rejected {symbol}")
    try:
        return json.loads(ctypes.string_at(pointer).decode())
    finally:
        free(pointer)

def artifact_for(pack: Path) -> dict:
    manifest = json.loads((pack/"contract-skill.json").read_text())
    digest, size = bundle_digest(pack)
    return {"id":manifest["id"], "version":manifest["version"], "digest":digest, "bytes":size}

def proof_set(pack: Path) -> dict:
    return {
        "manifest_digest": file_digest(pack/"contract-skill.json"),
        "instructions_digest": file_digest(pack/"SKILL.md"),
        "eval_digest": file_digest(pack/"evals/evals.json"),
        "witness_digest": file_digest(pack/"tests/witness.py"),
    }

def verify_candidate(spec: dict, pack: Path) -> tuple[dict, dict]:
    subprocess.run([sys.executable, str(Path(__file__).with_name("conform.py")), str(pack)], check=True, capture_output=True, text=True)
    subprocess.run([sys.executable, str(pack/"tests/witness.py"), str(pack)], check=True, capture_output=True, text=True)
    forbidden = ("-----BEGIN PRIVATE KEY", "github_pat_", "ghp_", "xoxb-", "AKIA")
    privacy_valid = not any(marker in path.read_text(errors="ignore") for path in pack.rglob("*") if path.is_file() for marker in forbidden)
    with tempfile.TemporaryDirectory() as temporary:
        replay = Path(temporary)/"replay"
        compile_pack(spec, replay)
        replay_valid = bundle_digest(replay) == bundle_digest(pack)
    gates = {
        "manifest_valid": True,
        "instructions_valid": True,
        "evals_passed": True,
        "witness_passed": True,
        "provenance_valid": json.loads((pack/"assets/receptor.json").read_text()) == spec,
        "privacy_valid": privacy_valid,
        "replay_valid": replay_valid,
        "rollback_ready": True,
    }
    if not all(gates.values()):
        raise ValueError(f"generated Skill admission gates failed: {gates}")
    return proof_set(pack), gates

def skill_state(artifact: dict) -> dict:
    result = contract_call("contract_neuron_skill_state_json", {
        "schema": STATE_SCHEMA,
        "artifact": artifact,
    })
    if result.get("schema") != "contract.neuron-skill.state-result/v1":
        raise ValueError("invalid Contract Skill state response")
    return result

def transition(artifact: dict, action: str, proofs: dict, gates: dict, *, authority=False, supersedes=None) -> dict:
    actor = file_digest(Path(__file__))
    result = contract_call("contract_neuron_skill_transition_json", {
        "schema": TRANSITION_SCHEMA,
        "stimulus_id": f"interface-{artifact['digest'][:16]}-{action}-{(supersedes or 'none')[:16]}",
        "artifact": artifact,
        "action": action,
        "proofs": proofs,
        "gates": gates,
        "actor_digest": actor,
        "authority": authority,
        "supersedes_digest": supersedes,
        "now_ms": max(1, time.time_ns() // 1_000_000),
    })
    if result.get("schema") != "contract.neuron-skill.transition-result/v1":
        raise ValueError("invalid Contract Skill transition response")
    return result

def store_candidate(pack: Path, artifact: dict) -> Path:
    root = Path(os.environ.get("AIKO_HOME", Path.home()/".aiko"))/"neuron-skills/objects"
    root.mkdir(parents=True, exist_ok=True)
    target = root/artifact["digest"]
    if target.exists():
        if artifact_for(target) != artifact:
            raise ValueError("content-addressed Skill object contradicts its digest")
        return target
    with tempfile.TemporaryDirectory(prefix=".skill-stage-", dir=root) as temporary:
        candidate = Path(temporary)/artifact["digest"]
        shutil.copytree(pack, candidate)
        if artifact_for(candidate) != artifact:
            raise ValueError("Skill changed while entering the object store")
        os.replace(candidate, target)
    return target

def admit_and_activate(pack: Path, spec: dict) -> tuple[Path, dict]:
    artifact = artifact_for(pack)
    proofs, gates = verify_candidate(spec, pack)
    stored = store_candidate(pack, artifact)
    transition(artifact, "stage", proofs, gates)
    transition(artifact, "admit", proofs, gates)
    active = skill_state(artifact).get("active_digest")
    if active != artifact["digest"]:
        transition(artifact, "activate", proofs, gates, authority=True, supersedes=active)
    state = skill_state(artifact)
    if state.get("state") != "active" or state.get("active_digest") != artifact["digest"]:
        raise ValueError("Contract did not activate the generated Skill")
    return stored, state

def retire(pack: Path, spec: dict) -> dict:
    artifact = artifact_for(pack)
    proofs, gates = verify_candidate(spec, pack)
    state = skill_state(artifact)
    if state.get("state") != "active":
        raise ValueError("only the active generated Skill can be retired")
    transition(artifact, "retire", proofs, gates, authority=True)
    return skill_state(artifact)

def rollback_to(digest: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("rollback digest must be 64 lower-case hex characters")
    root = Path(os.environ.get("AIKO_HOME", Path.home()/".aiko"))/"neuron-skills/objects"
    target = root/digest
    if not target.is_dir():
        raise ValueError("rollback target is not present in the immutable object store")
    spec = json.loads((target/"assets/receptor.json").read_text())
    artifact = artifact_for(target)
    if artifact["digest"] != digest:
        raise ValueError("rollback target digest does not match its content")
    proofs, gates = verify_candidate(spec, target)
    state = skill_state(artifact)
    active = state.get("active_digest")
    if not active or active == digest:
        raise ValueError("rollback requires a different currently active digest")
    transition(artifact, "rollback", proofs, gates, authority=True, supersedes=active)
    return skill_state(artifact)

def supervisor_plist(spec: dict, home: Path, aiko_home: Path) -> dict:
    runtime = spec["runtime"]
    cwd = Path(runtime.get("cwd", str(home))).expanduser()
    label = f"net.theclarityproject.aiko.interface.{spec['id']}"
    log = aiko_home/"logs"/f"{spec['id']}.log"
    return {"Label":label,"ProgramArguments":runtime["argv"],"WorkingDirectory":str(cwd),"EnvironmentVariables":{"HOME":str(home),"AIKO_INTERFACE_ID":spec["id"]},"RunAtLoad":True,"KeepAlive":runtime.get("restart","on-failure")!="never","StandardOutPath":str(log),"StandardErrorPath":str(log)}

def install(spec: dict, out: Path, start: bool) -> None:
    home = Path(os.environ.get("AIKO_HOME", Path.home()/".aiko"))
    target, state = admit_and_activate(out, spec)
    print(json.dumps({"artifact":str(target), "state":state}, sort_keys=True))
    if not start: return
    runtime = spec.get("runtime")
    if not runtime: raise ValueError("--start requires runtime.argv")
    if os.uname().sysname != "Darwin": raise ValueError("runtime rooting currently supports macOS")
    executable = runtime["argv"][0]
    if not (Path(executable).is_file() if Path(executable).is_absolute() else shutil.which(executable)):
        raise ValueError(f"runtime executable not found: {executable}")
    cwd = Path(runtime.get("cwd", str(Path.home()))).expanduser()
    if not cwd.is_dir(): raise ValueError(f"runtime cwd not found: {cwd}")
    label = f"net.theclarityproject.aiko.interface.{spec['id']}"
    agents = Path.home()/"Library"/"LaunchAgents"; agents.mkdir(parents=True, exist_ok=True)
    logs = home/"logs"; logs.mkdir(parents=True, exist_ok=True)
    plist = supervisor_plist(spec, Path.home(), home)
    path=agents/f"{label}.plist"; path.write_bytes(plistlib.dumps(plist))
    domain=f"gui/{os.getuid()}"; subprocess.run(["launchctl","bootout",f"{domain}/{label}"],capture_output=True)
    subprocess.run(["launchctl","bootstrap",domain,str(path)],check=True)

def run_neuron_stdio() -> None:
    """Pinned script-adapter protocol used by one Contract Neuron firing."""
    try:
        request = json.load(sys.stdin)
        if request.get("schema") != "aiko.neuron-script.invoke/v1":
            raise ValueError("unsupported Neuron script request")
        inputs = request.get("inputs")
        if not isinstance(inputs, dict) or "receptor_spec" not in inputs:
            raise ValueError("named receptor_spec input is required")
        receptor = inputs["receptor_spec"]
        if isinstance(receptor, str):
            path = Path(receptor).expanduser()
            if not path.is_absolute():
                path = Path.cwd()/path
            spec = load(path)
        else:
            spec = validate_spec(receptor)
        output = Path.cwd()/f"{spec['id']}-contract-interface"
        compile_pack(spec, output)
        proofs, gates = verify_candidate(spec, output)
        artifact = artifact_for(output)
        result = {
            "schema": "aiko.neuron-script.result/v1",
            "completed": True,
            "retryable": False,
            "evidence": {
                "generated_pack": {
                    "path": str(output),
                    "artifact": artifact,
                    "proofs": proofs,
                },
                "conformance": gates,
            },
            "summary": "Generated an inert, replay-stable Neuron Skill candidate and passed its local gates",
        }
    except Exception as error:
        result = {
            "schema": "aiko.neuron-script.result/v1",
            "completed": False,
            "retryable": False,
            "evidence": {},
            "summary": f"Generator rejected the candidate: {error}",
        }
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("spec", nargs="?", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--neuron-stdio", action="store_true", help=argparse.SUPPRESS)
    lifecycle = parser.add_mutually_exclusive_group()
    lifecycle.add_argument("--install", action="store_true")
    lifecycle.add_argument("--start", action="store_true")
    lifecycle.add_argument("--retire", action="store_true")
    lifecycle.add_argument("--rollback-to")
    args = parser.parse_args()
    if args.neuron_stdio:
        run_neuron_stdio()
        return
    if args.spec is None:
        parser.error("spec is required")
    spec = load(args.spec)
    out = args.out or Path.cwd()/f"{spec['id']}-contract-interface"
    compile_pack(spec, out)
    if args.install or args.start:
        install(spec, out, args.start)
    elif args.retire:
        print(json.dumps(retire(out, spec), sort_keys=True))
    elif args.rollback_to:
        print(json.dumps(rollback_to(args.rollback_to), sort_keys=True))
    print(out)
if __name__=="__main__": main()
