#!/usr/bin/env python3
"""Emit a complete Contract-owned fixture attestation signed by Ed25519."""
from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

OPENSSL = "/usr/bin/openssl"


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def checked(*argv: str) -> bytes:
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise SystemExit(result.stderr.decode("utf-8", "replace"))
    return result.stdout


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: contract-attester.py PREPARED OUTPUT ROOT PRIVATE_KEY")
    prepared_path, output_path, root_path, private_key_path = map(pathlib.Path, sys.argv[1:])
    prepared = json.loads(prepared_path.read_text(encoding="utf-8"))
    root = root_path
    admitter = root / "implementations/contract-attester.py"
    public_der = checked(OPENSSL, "pkey", "-in", str(private_key_path), "-pubout", "-outform", "DER")

    def verdict(acceptance: dict[str, object]) -> dict[str, object]:
        witness_id = acceptance["witness"]["id"]
        return {"witness_id": witness_id, "judge": acceptance["judge"]["implementation"],
                "verdict_ref": f"contract:verdict/{witness_id}"}

    acceptances = [prepared["package"]["north_star"]] + [
        node["acceptance"] for node in prepared["package"]["nodes"]
    ]
    verdicts = [verdict(acceptance) for acceptance in acceptances]
    authentication = {"algorithm": "ed25519",
                      "key_id": "sha256:" + hashlib.sha256(public_der).hexdigest(), "value": ""}
    attestation = {
        "api_version": "graph-harness-attestation/v1", "kind": "GraphHarnessAdmissionAttestation",
        "owner": "contract", "subject_digest": prepared["admission"]["subject_digest"],
        "transitive_digest": prepared["admission"]["transitive_digest"], "verdicts": verdicts,
        "admitted_by": {"ref": "implementations/contract-attester.py",
            "digest": {"algorithm": "sha256", "value": hashlib.sha256(admitter.read_bytes()).hexdigest()},
            "entrypoint": "contract-admission", "media_type": "text/x-python"},
        "admitted_at": "2026-03-10T00:00:00Z",
        "evidence_refs": [v["verdict_ref"] for v in verdicts] + ["contract:evidence/execution-set"],
        "ledger_ref": f"contract:ledger/graph-harness/{prepared['package']['metadata']['name']}/1",
        "authentication": authentication,
    }
    with tempfile.TemporaryDirectory(prefix="aiko-contract-sign.") as directory:
        statement = pathlib.Path(directory) / "statement.json"
        signature = pathlib.Path(directory) / "signature.bin"
        statement.write_bytes(canonical(attestation))
        checked(OPENSSL, "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key_path),
                "-in", str(statement), "-out", str(signature))
        authentication["value"] = signature.read_bytes().hex()
    output_path.write_bytes(canonical(attestation))


if __name__ == "__main__":
    main()
