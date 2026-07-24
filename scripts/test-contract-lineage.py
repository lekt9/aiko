#!/usr/bin/env python3
import json
import subprocess
import tempfile
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/contract_lineage.py"
with tempfile.TemporaryDirectory() as raw:
    temp = Path(raw)
    key = temp / "key"; key.write_bytes(b"k" * 32)
    prompt1 = temp / "p1"; prompt1.write_text("parent prompt")
    prompt2 = temp / "p2"; prompt2.write_text("child prompt")
    artifact = temp / "artifact"; artifact.write_text("measured output")
    eval_set = temp / "eval"; eval_set.write_text("private cases")
    archive = temp / "lineage.jsonl"
    base = ["python3", str(CLI), "append", "--archive", str(archive), "--key-file", str(key),
            "--artifact", str(artifact), "--eval-set", str(eval_set), "--run-id", "run-1",
            "--judge-id", "judge-1", "--provider-class", "local"]
    subprocess.run(base + ["--prompt", str(prompt1), "--score", "0.5"], check=True, capture_output=True)
    parent = __import__("hashlib").sha256(prompt1.read_bytes()).hexdigest()
    subprocess.run(base + ["--prompt", str(prompt2), "--parent-sha256", parent, "--score", "0.75"],
                   check=True, capture_output=True)
    subprocess.run(["python3", str(CLI), "verify", "--archive", str(archive), "--key-file", str(key)],
                   check=True)
    invalid = subprocess.run(base + ["--prompt", str(prompt2), "--score", "nan"], capture_output=True)
    assert invalid.returncode != 0
    rows = [json.loads(line) for line in archive.read_text().splitlines()]
    rows[0]["score"] = "1.000000"
    archive.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
    bad = subprocess.run(["python3", str(CLI), "verify", "--archive", str(archive), "--key-file", str(key)])
    assert bad.returncode != 0
    automatic = temp / "automatic.jsonl"
    auto_env = dict(os.environ, HOME=str(temp / "isolated-home"))
    auto = ["python3", str(CLI), "append", "--archive", str(automatic),
            "--prompt", str(prompt1), "--artifact", str(artifact), "--eval-set", str(eval_set),
            "--score", "0.9", "--run-id", "auto-run", "--judge-id", "auto-judge",
            "--provider-class", "local"]
    subprocess.run(auto, check=True, env=auto_env, capture_output=True)
    generated_key = temp / "isolated-home/.aiko/keys/evaluation-lineage.key"
    assert generated_key.stat().st_mode & 0o777 == 0o600
    subprocess.run(["python3", str(CLI), "verify", "--archive", str(automatic)],
                   check=True, env=auto_env, capture_output=True)
print("SIGNED-LINEAGE PASS: valid parent chain verifies and score tampering fails")
