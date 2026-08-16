#!/usr/bin/env python3
"""Aiko stack packages — list, check, install, update.

Layers are versioned packages with a shared lock. Mixing an ABI that the
lock does not name is a refusal. Neuron must not require contract.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_symlink(target: Path, link: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    temporary = link.with_name(f".{link.name}.new-{os.getpid()}")
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(target, target_is_directory=True)
    os.replace(temporary, link)


def write_control_integrity(package_root: Path, lock: dict) -> None:
    critical = [
        ".mcp.json",
        "bin/smithers.mjs",
        "lib/resolve-smithers-cli.mjs",
        "runtime/aiko-package.json",
        "runtime/bun.lock",
        "runtime/package.json",
        "runtime/apps/cli/src/index.js",
        "runtime/packages/components/package.json",
        "runtime/packages/components/src/index.js",
        "runtime/packages/components/src/index.d.ts",
        "runtime/packages/components/src/components/ContractCell.js",
        "runtime/packages/gateway-client/src/index.ts",
        "runtime/packages/gateway-client/src/ContractLifecycleClient.ts",
        "runtime/packages/smithers/package.json",
        "runtime/packages/smithers/src/index.js",
        "runtime/packages/smithers/src/index.d.ts",
        "runtime/packages/smithers/src/contractDriver.js",
        "runtime/packages/smithers/src/contractRecovery.js",
        "runtime/packages/smithers/src/contractRecoveryPolicy.js",
    ]
    missing = [name for name in critical if not (package_root / name).is_file()]
    if missing:
        raise SystemExit(f"control package critical files missing: {', '.join(missing)}")
    pin = (lock.get("packages") or {}).get("control") or {}
    dependency_lock = package_root / "runtime" / "bun.lock"
    expected_dependency_digest = pin.get("dependency_lock_sha256")
    actual_dependency_digest = sha256_file(dependency_lock)
    if actual_dependency_digest != expected_dependency_digest:
        raise SystemExit(
            f"control dependency lock digest {actual_dependency_digest} != stack pin {expected_dependency_digest}"
        )
    receipt = {
        "format": 1,
        "name": "control",
        "version": pin.get("version"),
        "abi": pin.get("abi"),
        "stack": lock.get("stack"),
        "dependency_lock_sha256": actual_dependency_digest,
        "files": {name: sha256_file(package_root / name) for name in critical},
    }
    canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
    receipt["digest"] = hashlib.sha256(canonical).hexdigest()
    (package_root / ".aiko-control-integrity.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )


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
        control_pin = pkgs.get("control") or {}
        if "cell" not in (ctl.get("requires") or []):
            errs.append("control must require cell")
        if "contract" in (ctl.get("requires") or []) or "neuron" in (ctl.get("requires") or []):
            errs.append("control must not import contract or neuron — Cell is the native harness")
        if ctl.get("abi") != "smithers-control/v1" or control_pin.get("abi") != ctl.get("abi"):
            errs.append(f"control ABI must be pinned to smithers-control/v1, got manifest={ctl.get('abi')!r} lock={control_pin.get('abi')!r}")
        dependency_pin = control_pin.get("dependency_lock_sha256")
        dependency_lock = ROOT / "aiko-flow" / "bun.lock"
        if not isinstance(dependency_pin, str) or len(dependency_pin) != 64:
            errs.append("control dependency lock digest is not pinned")
        elif not dependency_lock.is_file() or sha256_file(dependency_lock) != dependency_pin:
            errs.append("control bun.lock bytes do not match stack digest pin")
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
        control_pin = (lock.get("packages") or {}).get("control") or {}
        control_version = control_pin.get("version")
        if not control_version:
            raise SystemExit("control version missing from stack lock")
        control_parent = dest_root / "control"
        control_parent.mkdir(parents=True, exist_ok=True)
        control_ver = control_parent / control_version
        stage = Path(tempfile.mkdtemp(prefix=f".{control_version}.staging-", dir=control_parent))
        backup = control_parent / f".{control_version}.backup-{os.getpid()}"
        deployed = False
        try:
            shutil.copytree(
                plugin_src,
                stage,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("node_modules", "*.log", ".DS_Store"),
            )
            runtime_dir = stage / "runtime"
            shutil.copytree(
                control_src,
                runtime_dir,
                ignore=shutil.ignore_patterns(
                    ".git", "smithers.db*", "node_modules", "dist", "coverage",
                    "*.log", ".DS_Store",
                ),
            )
            # A source snapshot without its exact Bun dependency closure is not a runtime.
            source_modules = control_src / "node_modules"
            if not source_modules.is_dir():
                raise SystemExit("Smithers dependencies missing — run bun install --frozen-lockfile before packaging")
            shutil.copytree(
                source_modules,
                runtime_dir / "node_modules",
                symlinks=True,
                ignore=shutil.ignore_patterns("*.log", ".DS_Store"),
            )
            for workspace_modules in control_src.rglob("node_modules"):
                if not workspace_modules.is_dir() or workspace_modules == source_modules or source_modules in workspace_modules.parents:
                    continue
                shutil.copytree(
                    workspace_modules,
                    runtime_dir / workspace_modules.relative_to(control_src),
                    symlinks=True,
                    dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("*.log", ".DS_Store"),
                )
            runtime_root = runtime_dir.resolve()
            dependency_links: list[dict[str, str]] = []
            for link in runtime_dir.rglob("*"):
                if not link.is_symlink():
                    continue
                resolved = link.resolve(strict=False)
                if not resolved.is_relative_to(runtime_root) or not resolved.exists():
                    raise SystemExit(f"Smithers dependency closure escapes packaged runtime: {link} -> {os.readlink(link)}")
                dependency_links.append({
                    "path": link.relative_to(runtime_dir).as_posix(),
                    "target": os.readlink(link),
                })
            (runtime_dir / ".aiko-node-links.json").write_text(
                json.dumps(sorted(dependency_links, key=lambda row: row["path"]), separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            mcp_path = stage / ".mcp.json"
            mcp = load_json(mcp_path)
            server = mcp.get("mcpServers", {}).get("smithers")
            if not isinstance(server, dict):
                raise SystemExit("Smithers MCP declaration missing")
            env_block = server.get("env")
            if isinstance(env_block, dict):
                env_block.pop("AIKO_SMITHERS_RUNTIME", None)
                if not env_block:
                    server.pop("env", None)
            mcp_path.write_text(json.dumps(mcp, indent=2) + "\n", encoding="utf-8")
            write_control_integrity(stage, lock)

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
            # Validate/native-install the complete staging tree before touching current.
            subprocess.run([executable, "plugin", "install", str(stage), "--trust"], env=env, check=True)

            if backup.exists():
                shutil.rmtree(backup)
            if control_ver.exists() or control_ver.is_symlink():
                os.replace(control_ver, backup)
            try:
                os.replace(stage, control_ver)
                atomic_symlink(control_ver, control_parent / "current")
                deployed = True
            except BaseException:
                if control_ver.exists() or control_ver.is_symlink():
                    if control_ver.is_dir() and not control_ver.is_symlink():
                        shutil.rmtree(control_ver)
                    else:
                        control_ver.unlink()
                if backup.exists():
                    os.replace(backup, control_ver)
                raise
            if backup.exists():
                shutil.rmtree(backup)
        finally:
            if not deployed and stage.exists():
                shutil.rmtree(stage)

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
    ap.add_argument("--with-control", action="store_true", help="also install Smithers as an Aiko plugin limb (now the default when the control source is present)")
    ap.add_argument("--without-control", action="store_true", help="skip Smithers control limb even when its source is present")
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
        # Smithers is the default control plane: install it whenever the source
        # is present unless the caller explicitly opts out. --with-control is
        # kept for compatibility and forces the install (failing if incomplete).
        with_control = args.with_control
        if not with_control and not args.without_control and args.cmd == "install":
            control_src = ROOT / "aiko-flow"
            plugin_src = control_src / "claude-plugin"
            if (control_src / "apps" / "cli" / "src" / "index.js").is_file() and (control_src / "node_modules").is_dir() and (plugin_src / ".mcp.json").is_file():
                with_control = True
        try:
            path, control_path = install(lock, with_control=with_control, aiko_bin=args.aiko_bin)
        except SystemExit as e:
            # Auto-detected installs must not break `install` on a bare tree;
            # fall back to cell-only with a warning when dependencies are missing.
            if not args.with_control and not args.without_control and with_control:
                print(f"aiko-packages: control auto-install skipped — {e}", file=sys.stderr)
                path, control_path = install(lock, with_control=False, aiko_bin=args.aiko_bin)
            else:
                raise
        print(f"aiko-packages: installed cell → {path}")
        if control_path:
            print(f"aiko-packages: installed control limb → {control_path}")
        return 0
    list_pkgs(lock)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
