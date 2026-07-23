#!/usr/bin/env python3
"""Compile a declarative receptor into a provider-neutral Contract skill pack."""
from __future__ import annotations
import argparse, json, os, plistlib, re, shutil, subprocess
from pathlib import Path

EFFECTS = {"read_only","local_reversible","local_write","external_message","purchase","job_application","credential_access","delete","publish","permission_change","account_mutation"}

def key(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not result:
        raise ValueError(f"invalid empty key from {value!r}")
    return result

def load(path: Path) -> dict:
    value = json.loads(path.read_text())
    required = {"id", "description", "triggers", "events", "effects"}
    if required - value.keys():
        raise ValueError(f"missing fields: {sorted(required-value.keys())}")
    if not value["events"]:
        raise ValueError("at least one event is required")
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
    return value

def node(node_key, deps, effect="read_only", authority=False, evidence=None, plan=None):
    return {"key":node_key,"plan":plan or f"{node_key.title()} the interface occurrence for {{{{goal}}}}.","worker":"tool" if node_key.startswith("execute-") else "aiko","depends_on":deps,"can_parallel":not deps,"timeout_ms":120000,"effect":effect,"reversible":effect=="local_reversible","read_only":effect=="read_only","requires_authority":authority,"evidence":evidence or ["structured_result"]}

def compile_pack(spec: dict, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    effects = spec["effects"]
    nodes = [
        node("observe", []),
        node("normalize", ["observe"]),
        node("authorize", ["normalize"]),
        node("prepare", ["normalize"]),
    ]
    execute_keys = []
    for item in effects:
        execute_key = f"execute-{key(item['id'])}"
        execute_keys.append(execute_key)
        authority = item.get("requires_authority", item["effect"] not in {"read_only", "local_reversible"})
        nodes.append(node(
            execute_key, ["authorize", "prepare"], item["effect"], authority,
            item.get("evidence", ["provider_ack"]),
            f"Execute capability {item['id']} for {{{{goal}}}} without degrading unsupported variants."
        ))
    nodes.extend([
        node("sense", execute_keys, evidence=["provider_ack"]),
        node("evaluate", ["sense"]),
        node("settle", ["evaluate"]),
    ])
    manifest = {"schema_version":1,"id":spec["id"],"version":"1.0.0","description":spec["description"],"platforms":["all"],"triggers":spec["triggers"],"input_schema":{"type":"object","additionalProperties":True},"output_schema":{"type":"object","additionalProperties":True},"nodes":nodes}
    capabilities = {"schema_version":1,"interface":spec["id"],"events":spec["events"],"effects":effects}
    (out/"assets").mkdir(exist_ok=True)
    (out/"SKILL.md").write_text(f"---\nname: {spec['id']}\ndescription: {spec['description']}\n---\n\n# Generated Contract interface\n\nUse `contract-skill.json`; never bypass its authority and evidence cells.\n")
    (out/"contract-skill.json").write_text(json.dumps(manifest, indent=2, sort_keys=True)+"\n")
    (out/"assets"/"capabilities.json").write_text(json.dumps(capabilities, indent=2, sort_keys=True)+"\n")
    (out/"assets"/"receptor.json").write_text(json.dumps(spec, indent=2, sort_keys=True)+"\n")

def supervisor_plist(spec: dict, home: Path, aiko_home: Path) -> dict:
    runtime = spec["runtime"]
    cwd = Path(runtime.get("cwd", str(home))).expanduser()
    label = f"net.theclarityproject.aiko.interface.{spec['id']}"
    log = aiko_home/"logs"/f"{spec['id']}.log"
    return {"Label":label,"ProgramArguments":runtime["argv"],"WorkingDirectory":str(cwd),"EnvironmentVariables":{"HOME":str(home),"AIKO_INTERFACE_ID":spec["id"]},"RunAtLoad":True,"KeepAlive":runtime.get("restart","on-failure")!="never","StandardOutPath":str(log),"StandardErrorPath":str(log)}

def install(spec: dict, out: Path, start: bool) -> None:
    home = Path(os.environ.get("AIKO_HOME", Path.home()/".aiko"))
    target = home/"skills"/spec["id"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists(): shutil.rmtree(target)
    shutil.copytree(out, target)
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

def main():
    p=argparse.ArgumentParser(); p.add_argument("spec",type=Path); p.add_argument("--out",type=Path); p.add_argument("--install",action="store_true"); p.add_argument("--start",action="store_true")
    a=p.parse_args(); spec=load(a.spec); out=a.out or Path.cwd()/f"{spec['id']}-contract-interface"; compile_pack(spec,out)
    if a.install or a.start: install(spec,out,a.start)
    print(out)
if __name__=="__main__": main()
