#!/usr/bin/env python3
"""Aiko stack packages — list, check, install, update.

Layers are versioned packages with a shared lock. Mixing an ABI that the
lock does not name is a refusal. Neuron must not require contract.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / "sdk" / "registry" / "stack.lock.json"
MANIFESTS = {
    "neuron": ROOT / "neuron" / "aiko-package.json",
    "contract": ROOT / "contract" / "aiko-package.json",
    "cell": ROOT / "cell" / "aiko-package.json",
    "control": ROOT / "aiko-flow" / "aiko-package.json",
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def version_file() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def check(lock: dict) -> list[str]:
    errs: list[str] = []
    stack = lock.get("stack")
    if stack != version_file():
        errs.append(f"stack {stack!r} != VERSION {version_file()!r}")
    abi = lock.get("abi") or {}
    if abi.get("cell") != "cell/v0":
        errs.append(f"cell ABI must be cell/v0, got {abi.get('cell')!r}")
    if abi.get("neuron_standalone") is not True:
        errs.append("abi.neuron_standalone must be true")
    if not isinstance(abi.get("contract"), int) or abi["contract"] < 2:
        errs.append(f"contract ABI missing or too old: {abi.get('contract')!r}")

    pkgs = lock.get("packages") or {}
    for name, path in MANIFESTS.items():
        if name == "control" and not path.exists():
            continue
        if not path.exists():
            errs.append(f"missing {path}")
            continue
        man = load_json(path)
        pin = pkgs.get(name) or {}
        if man.get("name") != name:
            errs.append(f"{path}: name {man.get('name')!r} != {name!r}")
        if pin.get("version") and man.get("version") != pin["version"]:
            errs.append(f"{name}: manifest version {man.get('version')!r} != lock {pin['version']!r}")
        if list(man.get("requires") or []) != list(pin.get("requires") or []):
            errs.append(f"{name}: requires {man.get('requires')!r} != lock {pin.get('requires')!r}")

    neuron = load_json(MANIFESTS["neuron"]) if MANIFESTS["neuron"].exists() else {}
    if neuron.get("requires"):
        errs.append("neuron must require nothing — standalone is the handoff proof")
    if "contract" in (neuron.get("requires") or []):
        errs.append("neuron must not require contract")

    cell = load_json(MANIFESTS["cell"]) if MANIFESTS["cell"].exists() else {}
    if cell.get("api") != "cell/v0":
        errs.append(f"cell api must be cell/v0, got {cell.get('api')!r}")
    if cell.get("requires"):
        errs.append("cell must require nothing")

    contract = load_json(MANIFESTS["contract"]) if MANIFESTS["contract"].exists() else {}
    if contract.get("requires") != ["neuron"]:
        errs.append(f"contract must require [neuron], got {contract.get('requires')!r}")
    if contract.get("abi") != abi.get("contract"):
        errs.append(f"contract abi {contract.get('abi')!r} != lock {abi.get('contract')!r}")

    control = MANIFESTS["control"]
    if control.exists():
        ctl = load_json(control)
        if "cell" not in (ctl.get("requires") or []):
            errs.append("control must require cell")
        if "contract" in (ctl.get("requires") or []) or "neuron" in (ctl.get("requires") or []):
            errs.append("control must not import contract or neuron — Cell is the native harness")
    return errs


def home() -> Path:
    return Path(os.environ.get("AIKO_HOME") or Path.home() / ".aiko")


def install(lock: dict, *, with_control: bool = False, aiko_bin: str | None = None) -> tuple[Path, Path | None]:
    dest_root = home() / "packages"
    dest_root.mkdir(parents=True, exist_ok=True)
    ver = (lock.get("packages") or {}).get("cell", {}).get("version") or lock.get("stack")
    cell_src = ROOT / "cell"
    if not (cell_src / "run.py").is_file():
        raise SystemExit("cell/run.py missing — cannot install cell package")
    cell_ver = dest_root / "cell" / ver
    if cell_ver.exists():
        shutil.rmtree(cell_ver)
    cell_ver.mkdir(parents=True)
    for name in ("run.py", "helpers.py", "SKILL.md", "SPEC.md", "aiko-package.json"):
        src = cell_src / name
        if src.is_file():
            shutil.copy2(src, cell_ver / name)
    for name in ("primitives", "patterns", "schemas", "system", "example"):
        src = cell_src / name
        if src.is_dir():
            shutil.copytree(src, cell_ver / name, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules", "zig-out", ".zig-cache"))
    current = dest_root / "cell" / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(cell_ver, target_is_directory=True)
    (dest_root / "stack.lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
    # Also point the classic runtime if it is not already a real tree.
    classic = home() / "cell"
    if not (classic / "run.py").is_file():
        if classic.exists() or classic.is_symlink():
            if classic.is_symlink():
                classic.unlink()
        else:
            classic.parent.mkdir(parents=True, exist_ok=True)
            classic.symlink_to(cell_ver, target_is_directory=True)
    control_ver = None
    if with_control:
        control_src = ROOT / "aiko-flow"
        plugin_src = control_src / "claude-plugin"
        missing = [
            control_src / "apps" / "cli" / "src" / "index.js",
            control_src / "packages" / "gateway-client" / "src" / "data" / "createSmithersCollections.ts",
            plugin_src / ".mcp.json",
        ]
        if any(not path.is_file() for path in missing):
            raise SystemExit("control package is incomplete — refusing to install a Smithers limb that cannot boot")
        control_version = (lock.get("packages") or {}).get("control", {}).get("version")
        if not control_version:
            raise SystemExit("control version missing from stack lock")
        control_ver = dest_root / "control" / control_version
        if control_ver.exists():
            shutil.rmtree(control_ver)
        shutil.copytree(
            plugin_src,
            control_ver,
            ignore=shutil.ignore_patterns("node_modules", "*.log", ".DS_Store"),
        )
        runtime_dir = control_ver / "runtime"
        shutil.copytree(
            control_src,
            runtime_dir,
            ignore=shutil.ignore_patterns(
                ".git", "smithers.db*", "node_modules", "dist", "coverage",
                "*.log", ".DS_Store",
            ),
        )
        # The workspace package set must be complete before its dependency tree is
        # resolved. Never fall back to bunx: that would silently run different bytes.
        source_modules = control_src / "node_modules"
        if not source_modules.is_dir():
            raise SystemExit("Smithers dependencies missing — run bun install --frozen-lockfile before packaging")
        mcp_path = control_ver / ".mcp.json"
        mcp = load_json(mcp_path)
        server = mcp.get("mcpServers", {}).get("smithers")
        if not isinstance(server, dict):
            raise SystemExit("Smithers MCP declaration missing")
        server.setdefault("env", {})["AIKO_SMITHERS_RUNTIME"] = str(control_src)
        mcp_path.write_text(json.dumps(mcp, indent=2) + "\n", encoding="utf-8")
        current_control = dest_root / "control" / "current"
        if current_control.is_symlink() or current_control.exists():
            if current_control.is_dir() and not current_control.is_symlink():
                shutil.rmtree(current_control)
            else:
                current_control.unlink()
        current_control.symlink_to(control_ver, target_is_directory=True)

        executable = aiko_bin or os.environ.get("AIKO_BIN") or shutil.which("aiko")
        if not executable:
            candidate = ROOT / "aiko" / "target" / "debug" / "aiko"
            if candidate.is_file():
                executable = str(candidate)
        if not executable:
            raise SystemExit("Aiko binary missing — set AIKO_BIN; control must install through Aiko's native plugin loader")
        env = os.environ.copy()
        env["AIKO_HOME"] = str(home())
        env["GROK_HOME"] = str(home() / ".grok")
        subprocess.run(
            [executable, "plugin", "install", str(current_control), "--trust"],
            env=env,
            check=True,
        )
    return cell_ver, control_ver


def list_pkgs(lock: dict) -> None:
    print(f"stack {lock.get('stack')}  cell {lock.get('abi', {}).get('cell')}  contract-abi {lock.get('abi', {}).get('contract')}")
    for name, pin in (lock.get("packages") or {}).items():
        req = ",".join(pin.get("requires") or []) or "-"
        opt = "optional" if pin.get("optional") else "required"
        print(f"  {name:10} {pin.get('version')}  requires={req}  {opt}")
    current = home() / "packages" / "cell" / "current" / "run.py"
    print(f"installed cell runner: {current if current.is_file() else 'none'}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="aiko-packages")
    ap.add_argument("cmd", choices=("check", "list", "install", "update"))
    ap.add_argument("--with-control", action="store_true", help="also install Smithers as an Aiko plugin limb")
    ap.add_argument("--aiko-bin", help="Aiko binary used for native plugin installation")
    args = ap.parse_args(argv)
    if not LOCK_PATH.is_file():
        print(f"missing {LOCK_PATH}", file=sys.stderr)
        return 2
    lock = load_json(LOCK_PATH)
    if args.cmd in ("check", "update", "install"):
        errs = check(lock)
        if errs:
            print("aiko-packages: INCOMPATIBLE", file=sys.stderr)
            for e in errs:
                print(f"  {e}", file=sys.stderr)
            return 1
        if args.cmd == "check":
            print("aiko-packages: compatible")
            return 0
        path, control_path = install(lock, with_control=args.with_control, aiko_bin=args.aiko_bin)
        print(f"aiko-packages: installed cell → {path}")
        if control_path:
            print(f"aiko-packages: installed control limb → {control_path}")
        return 0
    list_pkgs(lock)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
