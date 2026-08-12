#!/usr/bin/env python3
"""Content-addressed registry for already-admitted GraphHarness envelopes.

This module deliberately does not execute a harness, admit dependencies, schedule
nodes, or record settlement.  It verifies the transport/admission identity it is
handed, then stores immutable canonical bytes and an immutable name/version ref.
"""
from __future__ import annotations

import argparse
import datetime as _datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any, Iterable

API_VERSION = "graph-harness/v1"
MEDIA_TYPE = "application/vnd.aiko.graph-harness+json;version=1"
AUTH_ALGORITHM = "ed25519"
VERIFY_KEY_ENV = "AIKO_CONTRACT_VERIFY_KEY"
OPENSSL = "/usr/bin/openssl"
MAX_PUBLIC_KEY_BYTES = 65536
MAX_SAFE_INTEGER = 9007199254740991
RFC3339_T = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$")
SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$")

class RegistryError(ValueError):
    """Fail-closed registry refusal."""


def _no_duplicate_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RegistryError(f"duplicate JSON member: {key!r}")
        result[key] = value
    return result


def parse_json(raw: bytes | str) -> Any:
    """Parse strict JSON: duplicates and non-finite numbers are refused."""
    try:
        return json.loads(raw, object_pairs_hook=_no_duplicate_object,
                          parse_constant=lambda value: (_ for _ in ()).throw(
                              RegistryError(f"non-finite JSON number: {value}")))
    except RegistryError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RegistryError(f"malformed JSON: {exc}") from exc


def _utf16_key(value: str) -> bytes:
    try:
        return value.encode("utf-16-be")
    except UnicodeEncodeError as exc:
        raise RegistryError("JSON contains an unpaired surrogate") from exc


def canonical_json(value: Any) -> bytes:
    """RFC 8785 canonical bytes for the schema's integer-only JSON domain.

    GraphHarness permits integers but no arbitrary JSON `number` fields.  Rather
    than claim incomplete IEEE-754 formatting, floats are rejected explicitly.
    Object names use RFC 8785's UTF-16 code-unit ordering.
    """
    if value is None:
        return b"null"
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise RegistryError("GraphHarness canonicalization refuses integers outside the I-JSON exact range")
        return str(value).encode("ascii")
    if isinstance(value, float):
        raise RegistryError("GraphHarness canonicalization refuses floating-point numbers")
    if isinstance(value, str):
        _utf16_key(value)
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if isinstance(value, list):
        return b"[" + b",".join(canonical_json(item) for item in value) + b"]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise RegistryError("JSON object member names must be strings")
        fields = []
        for key in sorted(value, key=_utf16_key):
            fields.append(canonical_json(key) + b":" + canonical_json(value[key]))
        return b"{" + b",".join(fields) + b"}"
    raise RegistryError(f"not a JSON value: {type(value).__name__}")


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


class SchemaValidator:
    """Small stdlib validator for the JSON-Schema vocabulary used by v1."""
    def __init__(self, schema: dict[str, Any]):
        self.root = schema

    def validate(self, value: Any) -> None:
        self._check(value, self.root, "$")

    def _resolve(self, ref: str) -> dict[str, Any]:
        if not ref.startswith("#/"):
            raise RegistryError(f"unsupported non-local schema reference: {ref}")
        current: Any = self.root
        for part in ref[2:].split("/"):
            current = current[part.replace("~1", "/").replace("~0", "~")]
        return current

    def _valid(self, value: Any, rule: dict[str, Any], path: str) -> bool:
        try:
            self._check(value, rule, path)
            return True
        except RegistryError:
            return False

    def _check(self, value: Any, rule: dict[str, Any], path: str) -> None:
        if "$ref" in rule:
            self._check(value, self._resolve(rule["$ref"]), path)
            return
        if "const" in rule and value != rule["const"]:
            raise RegistryError(f"{path}: expected constant {rule['const']!r}")
        if "enum" in rule and value not in rule["enum"]:
            raise RegistryError(f"{path}: value is not in the admitted enum")
        typ = rule.get("type")
        if typ:
            good = {"object": isinstance(value, dict), "array": isinstance(value, list),
                    "string": isinstance(value, str),
                    "integer": isinstance(value, int) and not isinstance(value, bool),
                    "boolean": isinstance(value, bool)}.get(typ)
            if not good:
                raise RegistryError(f"{path}: expected {typ}")
        if isinstance(value, dict):
            props = rule.get("properties", {})
            missing = [key for key in rule.get("required", []) if key not in value]
            if missing:
                raise RegistryError(f"{path}: missing required member(s): {', '.join(missing)}")
            extra_rule = rule.get("additionalProperties", True)
            for key, item in value.items():
                if key in props:
                    self._check(item, props[key], f"{path}.{key}")
                elif extra_rule is False:
                    raise RegistryError(f"{path}: unknown member {key!r}")
                elif isinstance(extra_rule, dict):
                    self._check(item, extra_rule, f"{path}.{key}")
                if "propertyNames" in rule:
                    self._check(key, rule["propertyNames"], f"{path}.<name>")
        if isinstance(value, list):
            if len(value) < rule.get("minItems", 0):
                raise RegistryError(f"{path}: too few items")
            if "maxItems" in rule and len(value) > rule["maxItems"]:
                raise RegistryError(f"{path}: too many items")
            if "items" in rule:
                for index, item in enumerate(value):
                    self._check(item, rule["items"], f"{path}[{index}]")
            if rule.get("uniqueItems"):
                seen: set[bytes] = set()
                for item in value:
                    encoded = canonical_json(item)
                    if encoded in seen:
                        raise RegistryError(f"{path}: duplicate array item")
                    seen.add(encoded)
        if isinstance(value, str):
            if len(value) < rule.get("minLength", 0):
                raise RegistryError(f"{path}: string is too short")
            if "maxLength" in rule and len(value) > rule["maxLength"]:
                raise RegistryError(f"{path}: string is too long")
            if "pattern" in rule and re.fullmatch(rule["pattern"], value) is None:
                raise RegistryError(f"{path}: string does not match required pattern")
            if rule.get("format") == "date-time":
                try:
                    if RFC3339_T.fullmatch(value) is None:
                        raise ValueError
                    parsed = _datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        raise ValueError
                except ValueError as exc:
                    raise RegistryError(f"{path}: invalid RFC 3339 date-time with required T separator") from exc
        if isinstance(value, int) and not isinstance(value, bool):
            if value < rule.get("minimum", value):
                raise RegistryError(f"{path}: integer below minimum")
            if value > rule.get("maximum", value):
                raise RegistryError(f"{path}: integer above maximum")
        for subrule in rule.get("allOf", []):
            self._check(value, subrule, path)
        if "anyOf" in rule and not any(self._valid(value, sub, path) for sub in rule["anyOf"]):
            raise RegistryError(f"{path}: no anyOf branch matched")
        if "if" in rule and self._valid(value, rule["if"], path) and "then" in rule:
            self._check(value, rule["then"], path)


def load_schema(path: Path | None = None) -> dict[str, Any]:
    default = Path(__file__).resolve().parents[1] / "schemas/graph-harness-v1.schema.json"
    value = parse_json((path or default).read_bytes())
    if not isinstance(value, dict):
        raise RegistryError("schema root is not an object")
    return value


def _expected_judges(package: dict[str, Any]) -> dict[str, dict[str, Any]]:
    acceptances = [package["north_star"]] + [node["acceptance"] for node in package["nodes"]]
    expected: dict[str, dict[str, Any]] = {}
    for acceptance in acceptances:
        witness_id = acceptance["witness"]["id"]
        if witness_id in expected:
            raise RegistryError(f"package witness id is not globally unique: {witness_id!r}")
        expected[witness_id] = acceptance["judge"]["implementation"]
    return expected


def _reconstruct_attestation(admission: dict[str, Any]) -> dict[str, Any]:
    return {
        "api_version": "graph-harness-attestation/v1",
        "kind": "GraphHarnessAdmissionAttestation",
        "owner": "contract",
        "subject_digest": admission["subject_digest"],
        "transitive_digest": admission["transitive_digest"],
        "verdicts": admission["verdicts"],
        "admitted_by": admission["admitted_by"],
        "admitted_at": admission["admitted_at"],
        "evidence_refs": admission["evidence_refs"],
        "ledger_ref": admission["ledger_ref"],
        "authentication": admission["authentication"],
    }


def _openssl(arguments: list[str], *, input_bytes: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            [OPENSSL, *arguments], input=input_bytes, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env={"LANG": "C", "LC_ALL": "C"},
            timeout=10, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RegistryError(f"fixed OpenSSL verifier unavailable at {OPENSSL}: {exc}") from exc


def _public_key_der(public_key: bytes) -> bytes:
    public_pem = re.compile(
        rb"\A-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,64}\r?\n)+-----END PUBLIC KEY-----\r?\n?\Z"
    )
    if public_pem.fullmatch(public_key) is None:
        raise RegistryError("Contract verifier must be a public-only SubjectPublicKeyInfo PEM")
    result = _openssl(["pkey", "-pubin", "-outform", "DER"], input_bytes=public_key)
    if result.returncode != 0 or not result.stdout:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RegistryError(f"Contract Ed25519 public key is invalid: {detail}")
    der = result.stdout
    # id-Ed25519 AlgorithmIdentifier without parameters plus one 32-byte key.
    if len(der) != 44 or not der.startswith(bytes.fromhex("302a300506032b6570032100")):
        raise RegistryError("Contract verify key is not Ed25519 SubjectPublicKeyInfo")
    return der


def _verify_authentication(attestation: dict[str, Any], public_key: bytes) -> None:
    authentication = attestation["authentication"]
    if authentication["algorithm"] != AUTH_ALGORITHM:
        raise RegistryError("Contract authentication algorithm is not ed25519")
    expected_key_id = "sha256:" + hashlib.sha256(_public_key_der(public_key)).hexdigest()
    if authentication["key_id"] != expected_key_id:
        raise RegistryError("Contract authentication key id mismatch")
    value = authentication["value"]
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{128}", value) is None:
        raise RegistryError("Contract Ed25519 signature is not 64-byte lowercase hex")
    unsigned = dict(attestation)
    unsigned["authentication"] = dict(authentication)
    unsigned["authentication"]["value"] = ""
    payload = canonical_json(unsigned)
    signature = bytes.fromhex(value)
    with tempfile.TemporaryDirectory(prefix="aiko-contract-verify-") as temporary:
        directory = Path(temporary)
        key_path = directory / "public.pem"
        signature_path = directory / "signature.bin"
        payload_path = directory / "attestation.json"
        key_path.write_bytes(public_key)
        signature_path.write_bytes(signature)
        payload_path.write_bytes(payload)
        os.chmod(key_path, 0o600)
        os.chmod(signature_path, 0o600)
        os.chmod(payload_path, 0o600)
        result = _openssl([
            "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(key_path),
            "-in", str(payload_path), "-sigfile", str(signature_path),
        ])
    if result.returncode != 0:
        raise RegistryError("Contract attestation Ed25519 verification failed")


def verify_envelope(envelope: Any, schema: dict[str, Any] | None = None,
                    *, public_key: bytes | None = None) -> str:
    """Verify all material-independent v1 identities and admission bindings."""
    if not isinstance(envelope, dict):
        raise RegistryError("envelope must be a JSON object")
    SchemaValidator(schema or load_schema()).validate(envelope)
    package = envelope["package"]
    admission = envelope["admission"]
    registry = envelope["registry"]
    if admission["state"] != "admitted":
        raise RegistryError("registry accepts only state=admitted envelopes")

    actual = sha256(package)
    claimed = admission["subject_digest"]["value"]
    if claimed != actual:
        raise RegistryError(f"admission subject digest mismatch: claimed {claimed}, computed {actual}")

    closure = admission["dependency_closure"]
    closure_keys = [canonical_json(entry) for entry in closure]
    if closure_keys != sorted(set(closure_keys)):
        raise RegistryError("admission dependency_closure is not canonical sorted unique closure")
    computed_transitive = sha256({
        "subject_digest": admission["subject_digest"],
        "dependency_closure": closure,
    })
    if admission["transitive_digest"]["value"] != computed_transitive:
        raise RegistryError("admission transitive digest mismatch")

    expected = _expected_judges(package)
    got: dict[str, dict[str, Any]] = {}
    evidence_refs = set(admission["evidence_refs"])
    for verdict in admission["verdicts"]:
        witness_id = verdict["witness_id"]
        if witness_id in got:
            raise RegistryError(f"duplicate admission verdict for witness {witness_id!r}")
        got[witness_id] = verdict
        if verdict["verdict_ref"] not in evidence_refs:
            raise RegistryError(f"verdict reference for {witness_id!r} is absent from evidence_refs")
    if set(got) != set(expected):
        raise RegistryError("admission verdicts do not cover exactly every package witness")
    for witness_id, judge in expected.items():
        if canonical_json(got[witness_id]["judge"]) != canonical_json(judge):
            raise RegistryError(f"admission judge binding mismatch for witness {witness_id!r}")

    attestation = _reconstruct_attestation(admission)
    if admission["attestation_digest"]["value"] != sha256(attestation):
        raise RegistryError("admission attestation digest mismatch")
    if public_key is not None:
        _verify_authentication(attestation, public_key)

    cell_projection = registry["projections"].get("cell_v0")
    if cell_projection is not None:
        same_ref = [entry for entry in closure
                    if entry["kind"] == "cell" and entry["ref"] == cell_projection["ref"]]
        if len(same_ref) != 1:
            raise RegistryError(
                "registry cell_v0 projection ref must appear exactly once in authenticated cell closure")
        if canonical_json(same_ref[0]["digest"]) != canonical_json(cell_projection["digest"]):
            raise RegistryError(
                "registry cell_v0 projection digest does not match authenticated cell closure")

    metadata = package["metadata"]
    for field in ("name", "version", "description"):
        if registry[field] != metadata[field]:
            raise RegistryError(f"registry.{field} does not equal package.metadata.{field}")
    return actual


def _canonical_document(value: Any) -> bytes:
    return canonical_json(value) + b"\n"


def _read_regular_file(path: Path) -> bytes:
    """Read without following a final-component symlink."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise RegistryError(f"registry file cannot be opened safely: {path}: {exc}") from exc
    try:
        import stat
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RegistryError(f"registry path is not a regular file: {path}")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def _parse_canonical_file(path: Path) -> tuple[Any, bytes]:
    raw = _read_regular_file(path)
    value = parse_json(raw)
    if raw != _canonical_document(value):
        raise RegistryError(f"stored bytes are not the published canonical document: {path}")
    return value, raw


def _read_public_key(path: Path) -> bytes:
    """Read the deployment verifier without following its final symlink."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise RegistryError(f"Contract verify key cannot be opened safely: {path}: {exc}") from exc
    try:
        import stat
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RegistryError("Contract verify key must be a regular non-symlink file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(MAX_PUBLIC_KEY_BYTES + 1)
    finally:
        os.close(fd)
    if not raw:
        raise RegistryError("Contract verify key must not be empty")
    if len(raw) > MAX_PUBLIC_KEY_BYTES:
        raise RegistryError(f"Contract verify key exceeds {MAX_PUBLIC_KEY_BYTES} bytes")
    # Parsing here makes malformed or non-public bootstrap material fail before
    # any registry bytes are published or selected.
    _public_key_der(raw)
    return raw


def _bootstrap_public_key_path() -> Path:
    configured = os.environ.get(VERIFY_KEY_ENV)
    if not configured:
        raise RegistryError(f"missing deployment bootstrap environment {VERIFY_KEY_ENV}")
    path = Path(configured)
    if not path.is_absolute():
        raise RegistryError(f"deployment bootstrap environment {VERIFY_KEY_ENV} must be absolute")
    return path


def _semver(value: str) -> tuple[Any, ...]:
    match = SEMVER.fullmatch(value)
    if not match:
        raise RegistryError(f"invalid semantic version: {value!r}")
    pre = match.group(4)
    # A release sorts above its pre-releases. Numeric identifiers sort below text.
    prekey: tuple[Any, ...] = ((2,),) if pre is None else tuple(
        (0, int(part)) if part.isdigit() else (1, part) for part in pre.split("."))
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)), pre is None, prekey)

def _atomic_write_once(path: Path, data: bytes) -> bool:
    """Durable write-if-absent. Return True only when identical bytes existed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".register-", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temp, path)  # atomic no-clobber publication
            dir_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
            deduped = False
        except FileExistsError:
            existing = _read_regular_file(path)
            if existing != data:
                raise RegistryError(f"immutable registry conflict at {path}")
            deduped = True
        if _read_regular_file(path) != data:
            raise RegistryError(f"durable read-back mismatch at {path}")
        return deduped
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


class HarnessRegistry:
    def __init__(self, root: str | os.PathLike[str], schema_path: str | os.PathLike[str] | None = None):
        self.root = Path(root).absolute()
        self.schema = load_schema(Path(schema_path) if schema_path else None)

    def _object_path(self, digest: str) -> Path:
        return self.root / "objects" / "sha256" / digest[:2] / digest[2:4] / (digest + ".json")

    def _ref_path(self, name: str, version: str) -> Path:
        return self.root / "refs" / name / (version + ".json")

    def _confined(self, path: Path, *, create_parents: bool = False, target_dir: bool = False) -> Path:
        """Refuse symlinks and prove the selected path remains below the root."""
        if self.root.is_symlink():
            raise RegistryError(f"registry root symlink refused: {self.root}")
        self.root.mkdir(parents=True, exist_ok=True)
        root = self.root.resolve(strict=True)
        try:
            relative = path.absolute().relative_to(self.root)
        except ValueError as exc:
            raise RegistryError(f"registry path escapes root: {path}") from exc
        if any(part in ("", ".", "..") for part in relative.parts):
            raise RegistryError(f"unsafe registry path: {path}")
        current = root
        parts = relative.parts if target_dir else relative.parts[:-1]
        for part in parts:
            current = current / part
            if create_parents:
                try:
                    current.mkdir()
                except FileExistsError:
                    pass
            if current.is_symlink():
                raise RegistryError(f"registry symlink refused: {current}")
            if not current.exists() or not current.is_dir():
                raise RegistryError(f"registry path component is not a directory: {current}")
        candidate = root.joinpath(*relative.parts)
        # is_symlink also detects a broken link, unlike exists().
        if candidate.is_symlink():
            raise RegistryError(f"registry symlink refused: {candidate}")
        try:
            candidate.resolve(strict=False).relative_to(root)
        except ValueError as exc:
            raise RegistryError(f"registry path escapes root: {candidate}") from exc
        return candidate

    def register(self, envelope: dict[str, Any], *,
                 public_key_path: str | os.PathLike[str]) -> dict[str, Any]:
        public_key = _read_public_key(Path(public_key_path))
        subject_digest = verify_envelope(envelope, self.schema, public_key=public_key)
        canonical = _canonical_document(envelope)
        envelope_digest = hashlib.sha256(canonical_json(envelope)).hexdigest()
        transitive_digest = envelope["admission"]["transitive_digest"]["value"]
        obj = self._confined(self._object_path(envelope_digest), create_parents=True)
        object_deduped = _atomic_write_once(obj, canonical)
        metadata = envelope["package"]["metadata"]
        ref_value = {
            "api_version": API_VERSION,
            "name": metadata["name"],
            "version": metadata["version"],
            "envelope_digest": envelope_digest,
            "subject_digest": subject_digest,
            "transitive_digest": transitive_digest,
        }
        ref_bytes = _canonical_document(ref_value)
        ref_path = self._confined(
            self._ref_path(metadata["name"], metadata["version"]), create_parents=True)
        ref_deduped = _atomic_write_once(ref_path, ref_bytes)
        stored, stored_bytes = _parse_canonical_file(obj)
        if hashlib.sha256(stored_bytes[:-1]).hexdigest() != envelope_digest:
            raise RegistryError("registered object failed envelope digest read-back")
        if verify_envelope(stored, self.schema, public_key=public_key) != subject_digest:
            raise RegistryError("registered object failed authenticated independent read-back verification")
        return {
            "name": metadata["name"], "version": metadata["version"],
            "envelope_digest": envelope_digest, "subject_digest": subject_digest,
            "transitive_digest": transitive_digest,
            "deduped": object_deduped and ref_deduped,
        }

    def _read_ref(self, path: Path) -> dict[str, Any]:
        ref, _ = _parse_canonical_file(path)
        required = {"api_version", "name", "version", "envelope_digest",
                    "subject_digest", "transitive_digest"}
        if not isinstance(ref, dict) or set(ref) != required:
            raise RegistryError(f"malformed registry ref: {path}")
        if ref["api_version"] != API_VERSION or path.parent.name != ref["name"] or path.stem != ref["version"]:
            raise RegistryError(f"registry ref identity mismatch: {path}")
        for field in ("envelope_digest", "subject_digest", "transitive_digest"):
            digest = ref[field]
            if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
                raise RegistryError(f"malformed {field} in {path}")
        return ref

    def lookup(self, name: str, *, public_key_path: str | os.PathLike[str],
               version: str | None = None, min_version: str | None = None,
               tags: Iterable[str] = (), projection: str | None = None) -> dict[str, Any]:
        public_key = _read_public_key(Path(public_key_path))
        if re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", name) is None:
            raise RegistryError("invalid registry name")
        if version is not None:
            _semver(version)
        minimum = _semver(min_version) if min_version is not None else None
        required_tags = set(tags)
        if projection not in (None, "aiko_skill_v1", "cell_v0"):
            raise RegistryError("unsupported compatibility projection")
        directory = self.root / "refs" / name
        if directory.exists() or directory.is_symlink():
            directory = self._confined(directory, target_dir=True)
            enumerated = sorted(directory.glob("*.json")) if version is None else [self._ref_path(name, version)]
        else:
            enumerated = [self._ref_path(name, version)] if version is not None else []
        candidates: list[tuple[tuple[Any, ...], str, dict[str, Any]]] = []
        for untrusted_path in enumerated:
            # Glob results are hostile too: confine and reject links before any
            # is_file, open, parse, or identity decision.
            path = self._confined(untrusted_path)
            if not path.exists():
                continue
            if not path.is_file():
                raise RegistryError(f"registry ref is not a regular file: {path}")
            ref = self._read_ref(path)
            key = _semver(ref["version"])
            if minimum is not None and key < minimum:
                continue
            obj = self._confined(self._object_path(ref["envelope_digest"]))
            envelope, raw = _parse_canonical_file(obj)
            computed_envelope = hashlib.sha256(raw[:-1]).hexdigest()
            if computed_envelope != ref["envelope_digest"]:
                raise RegistryError(f"registry ref points at a tampered envelope: {path}")
            subject_digest = verify_envelope(envelope, self.schema, public_key=public_key)
            if subject_digest != ref["subject_digest"]:
                raise RegistryError(f"registry ref subject metadata mismatch: {path}")
            transitive_digest = envelope["admission"]["transitive_digest"]["value"]
            if transitive_digest != ref["transitive_digest"]:
                raise RegistryError(f"registry ref transitive metadata mismatch: {path}")
            metadata = envelope["package"]["metadata"]
            if metadata["name"] != ref["name"] or metadata["version"] != ref["version"]:
                raise RegistryError(f"registry ref points at the wrong envelope: {path}")
            registry = envelope["registry"]
            if not required_tags.issubset(set(registry.get("tags", []))):
                continue
            if projection and projection not in registry["projections"]:
                continue
            candidates.append((key, ref["envelope_digest"], envelope))
        if not candidates:
            raise RegistryError(f"no compatible admitted GraphHarness for {name!r}")
        candidates.sort(key=lambda item: (item[0], item[1]))
        return candidates[-1][2]


def _sign_ed25519(private_key_path: Path, payload: bytes) -> str:
    with tempfile.TemporaryDirectory(prefix="aiko-contract-sign-test-") as temporary:
        payload_path = Path(temporary) / "attestation.json"
        payload_path.write_bytes(payload)
        result = _openssl([
            "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key_path),
            "-in", str(payload_path),
        ])
    if result.returncode != 0 or len(result.stdout) != 64:
        raise RegistryError("self-test Ed25519 signing failed")
    return result.stdout.hex()


def _fixture(private_key_path: Path, public_key: bytes, version: str = "1.0.0", *,
             name: str = "example-harness", cell_projection: bool = False) -> dict[str, Any]:
    """Produce a fully derived, authenticated synthetic admitted envelope."""
    zeros = "0" * 64
    ones = "1" * 64
    digest0 = {"algorithm": "sha256", "value": zeros}
    impl = lambda ref, digest=zeros: {"ref": ref, "digest": {"algorithm": "sha256", "value": digest}}

    def acceptance(witness_id: str) -> dict[str, Any]:
        witness = {
            "id": witness_id, "implementation": impl(witness_id + "-witness.py"),
            "argv": ["python3", witness_id + "-witness.py"], "timeout_ms": 1000,
            "expected": {"exit_codes": [0]},
            "evidence": [{"name": "result", "kind": "structured-output", "ref": "out/result.json"}],
        }
        judge = {
            "independent": True, "implementation": impl(witness_id + "-judge.py", ones),
            "consumes": ["result"], "verdict_schema": impl("verdict.schema.json"), "policy": "all",
        }
        return {"claim": "A durable structured result is independently observed",
                "witness": witness, "judge": judge}

    root_acceptance = acceptance("observe-harness")
    node_acceptance = acceptance("observe-result")
    package = {
        "metadata": {"name": name, "version": version, "description": "Synthetic admitted harness"},
        "membrane": {"inputs": {}, "outputs": {},
                     "authority": {"filesystem": [], "network": [], "process": [], "secrets": []}},
        "north_star": root_acceptance,
        "nodes": [{
            "id": "produce", "depends_on": [], "reads": [], "produces": ["result"], "writes": [],
            "resources": [],
            "effects": [{"kind": "none", "scope": "local", "external_boundary": False,
                         "readback": "not-applicable", "on_invalidation": "recompute"}],
            "implementation": {"ref": "producer.cell.json", "digest": digest0,
                               "media_type": "application/vnd.aiko.cell+json;version=0"},
            "determinism": "required", "grounding": {"capability_gaps": ["synthetic-self-test"]},
            "acceptance": node_acceptance,
        }],
        "edges": [],
        "recursion": {"max_depth": 0, "max_children_per_node": 0, "max_total_nodes": 1,
                      "max_wall_time_ms": 2000, "max_tool_calls": 2, "on_exhaustion": "refuse"},
        "provenance": {"authored_by": "registry-self-test", "source_digests": [impl("source.txt")],
                       "generator": impl("generator.py")},
    }
    subject_digest = {"algorithm": "sha256", "value": sha256(package)}
    closure = [{"kind": "source", "ref": "source.txt",
                "digest": {"algorithm": "sha256", "value": zeros}}]
    if cell_projection:
        closure.append({"kind": "cell", "ref": "producer.cell.json", "digest": dict(digest0)})
    closure.sort(key=canonical_json)
    transitive_digest = {"algorithm": "sha256", "value": sha256({
        "subject_digest": subject_digest, "dependency_closure": closure})}
    verdicts = [
        {"witness_id": "observe-harness", "judge": root_acceptance["judge"]["implementation"],
         "verdict_ref": "verdict:harness-self-test"},
        {"witness_id": "observe-result", "judge": node_acceptance["judge"]["implementation"],
         "verdict_ref": "verdict:node-self-test"},
    ]
    authentication = {
        "algorithm": AUTH_ALGORITHM,
        "key_id": "sha256:" + hashlib.sha256(_public_key_der(public_key)).hexdigest(),
        "value": "",
    }
    attestation = {
        "api_version": "graph-harness-attestation/v1", "kind": "GraphHarnessAdmissionAttestation",
        "owner": "contract", "subject_digest": subject_digest,
        "transitive_digest": transitive_digest, "verdicts": verdicts,
        "admitted_by": impl("admitter.py"), "admitted_at": "2026-01-01T00:00:00Z",
        "evidence_refs": ["verdict:harness-self-test", "verdict:node-self-test", "evidence:self-test"],
        "ledger_ref": "ledger:self-test-admission", "authentication": authentication,
    }
    authentication["value"] = _sign_ed25519(private_key_path, canonical_json(attestation))
    admission = {
        "state": "admitted", "subject": "/package", "subject_digest": subject_digest,
        "canonicalization": "rfc8785-json", "transitive_digest": transitive_digest,
        "dependency_closure": closure, "admitted_by": attestation["admitted_by"],
        "admitted_at": attestation["admitted_at"], "evidence_refs": attestation["evidence_refs"],
        "ledger_ref": attestation["ledger_ref"], "verdicts": verdicts,
        "authentication": authentication,
        "attestation_digest": {"algorithm": "sha256", "value": sha256(attestation)},
    }
    return {
        "api_version": API_VERSION, "kind": "GraphHarness", "package": package,
        "admission": admission,
        "registry": {
            "media_type": MEDIA_TYPE, "name": name, "version": version,
            "description": "Synthetic admitted harness", "schema": API_VERSION,
            "tags": ["self-test"],
            "projections": {
                "aiko_skill_v1": {
                    "name": name, "description": "Synthetic admitted harness",
                    "probe_input": "produce structured evidence", "expect_contains": "observed-result",
                },
                **({"cell_v0": {"ref": "producer.cell.json", "digest": dict(digest0)}}
                   if cell_projection else {}),
            },
        },
    }


def self_test() -> None:
    import contextlib
    import copy
    import io

    with tempfile.TemporaryDirectory(prefix="graph-harness-registry-test-") as temporary:
        base = Path(temporary)
        private_key = base / "contract-private.pem"
        public_key_path = base / "contract-public.pem"
        wrong_private = base / "wrong-private.pem"
        wrong_public_path = base / "wrong-public.pem"
        for private, public in ((private_key, public_key_path), (wrong_private, wrong_public_path)):
            generated = _openssl(["genpkey", "-algorithm", "ED25519", "-out", str(private)])
            assert generated.returncode == 0, generated.stderr
            exported = _openssl(["pkey", "-in", str(private), "-pubout", "-out", str(public)])
            assert exported.returncode == 0, exported.stderr
        public_key = _read_public_key(public_key_path)
        try: _public_key_der(private_key.read_bytes())
        except RegistryError: pass
        else: raise AssertionError("private Ed25519 PEM was accepted as registry verifier material")

        registry = HarnessRegistry(base / "registry")
        first = _fixture(private_key, public_key)
        result = registry.register(first, public_key_path=public_key_path)
        assert result["deduped"] is False
        assert registry.register(copy.deepcopy(first), public_key_path=public_key_path)["deduped"] is True
        assert registry.lookup("example-harness", version="1.0.0",
                               public_key_path=public_key_path)["package"]["metadata"]["version"] == "1.0.0"

        prerelease = _fixture(private_key, public_key, "2.0.0-rc.1")
        release = _fixture(private_key, public_key, "2.0.0")
        registry.register(prerelease, public_key_path=public_key_path)
        registry.register(release, public_key_path=public_key_path)
        chosen = registry.lookup(
            "example-harness", min_version="1.1.0", tags=["self-test"],
            projection="aiko_skill_v1", public_key_path=public_key_path)
        assert chosen["package"]["metadata"]["version"] == "2.0.0"

        bad_digest = copy.deepcopy(first)
        bad_digest["package"]["metadata"]["description"] = "changed after admission"
        try:
            registry.register(bad_digest, public_key_path=public_key_path)
            raise AssertionError("digest mismatch was accepted")
        except RegistryError as exc:
            assert "digest mismatch" in str(exc)

        hand_authored = copy.deepcopy(first)
        hand_authored["admission"]["authentication"]["value"] = "aa" * 64
        forged_attestation = _reconstruct_attestation(hand_authored["admission"])
        hand_authored["admission"]["attestation_digest"]["value"] = sha256(forged_attestation)
        try:
            HarnessRegistry(base / "hand-authored").register(
                hand_authored, public_key_path=public_key_path)
            raise AssertionError("invalid signature was accepted on fresh publication")
        except RegistryError as exc:
            assert "Ed25519 verification failed" in str(exc)

        try:
            HarnessRegistry(base / "wrong-key").register(first, public_key_path=wrong_public_path)
            raise AssertionError("wrong Contract verify key was accepted")
        except RegistryError as exc:
            assert "key id mismatch" in str(exc)

        invalid_time = copy.deepcopy(first)
        invalid_time["admission"]["admitted_at"] = "2026-01-01 00:00:00Z"
        try:
            HarnessRegistry(base / "bad-time").register(invalid_time, public_key_path=public_key_path)
            raise AssertionError("RFC3339 date-time without T was accepted")
        except RegistryError:
            pass

        projected_registry = HarnessRegistry(base / "projection-registry")
        projected = _fixture(private_key, public_key, name="projected-harness", cell_projection=True)
        projected_registry.register(projected, public_key_path=public_key_path)
        assert projected_registry.lookup(
            "projected-harness", projection="cell_v0",
            public_key_path=public_key_path)["registry"]["projections"]["cell_v0"]["ref"] == "producer.cell.json"
        drifted = copy.deepcopy(projected)
        drifted["registry"]["projections"]["cell_v0"]["digest"]["value"] = "f" * 64
        try:
            HarnessRegistry(base / "projection-drift").register(
                drifted, public_key_path=public_key_path)
            raise AssertionError("cell_v0 projection drift was accepted")
        except RegistryError as exc:
            assert "projection digest" in str(exc)

        # Build a coherent replacement CAS object and ref whose only invalid
        # fact is the signature. Lookup must authenticate the durable read-back,
        # not trust coherent CAS/ref hashes or a prior publication check.
        direct = HarnessRegistry(base / "direct-tamper")
        direct_envelope = _fixture(private_key, public_key, name="direct-harness")
        direct_result = direct.register(direct_envelope, public_key_path=public_key_path)
        forged = copy.deepcopy(direct_envelope)
        forged["admission"]["authentication"]["value"] = "bb" * 64
        forged_attestation = _reconstruct_attestation(forged["admission"])
        forged["admission"]["attestation_digest"]["value"] = sha256(forged_attestation)
        forged_bytes = _canonical_document(forged)
        forged_digest = hashlib.sha256(forged_bytes[:-1]).hexdigest()
        forged_object = direct._confined(direct._object_path(forged_digest), create_parents=True)
        forged_object.write_bytes(forged_bytes)
        ref_path = direct._ref_path("direct-harness", "1.0.0")
        ref, _ = _parse_canonical_file(ref_path)
        ref["envelope_digest"] = forged_digest
        ref_path.write_bytes(_canonical_document(ref))
        try:
            direct.lookup("direct-harness", public_key_path=public_key_path)
            raise AssertionError("coherent CAS/ref with invalid signature was returned")
        except RegistryError as exc:
            assert "Ed25519 verification failed" in str(exc)

        public_envelope = base / "public-envelope.json"
        public_envelope.write_bytes(_canonical_document(first))
        old_bootstrap = os.environ.pop(VERIFY_KEY_ENV, None)
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                assert main(["lookup", "example-harness", "--registry", str(base / "registry")]) == 2
                assert main(["register", str(public_envelope), "--registry",
                             str(base / "missing-bootstrap-register")]) == 2
            os.environ[VERIFY_KEY_ENV] = str(wrong_public_path)
            with contextlib.redirect_stderr(io.StringIO()):
                assert main(["lookup", "example-harness", "--registry", str(base / "registry")]) == 2
                assert main(["register", str(public_envelope), "--registry",
                             str(base / "wrong-bootstrap-register")]) == 2
            os.environ[VERIFY_KEY_ENV] = str(public_key_path)
            # Exercise the public path without inventing a verifier argument.
            assert _bootstrap_public_key_path() == public_key_path
        finally:
            if old_bootstrap is None:
                os.environ.pop(VERIFY_KEY_ENV, None)
            else:
                os.environ[VERIFY_KEY_ENV] = old_bootstrap

        try:
            with contextlib.redirect_stderr(io.StringIO()):
                _parser().parse_args([
                    "register", "envelope.json", "--registry", "registry",
                    "--verify-key", "attacker-selected.pem"])
            raise AssertionError("public CLI accepted a command-selected verifier")
        except SystemExit as exc:
            assert exc.code == 2

        try:
            parse_json('{"x":1,"x":2}')
            raise AssertionError("duplicate JSON member was accepted")
        except RegistryError:
            pass

        linked = HarnessRegistry(base / "symlink-registry")
        linked.register(_fixture(private_key, public_key, name="symlink-harness"),
                        public_key_path=public_key_path)
        ref_path = linked._ref_path("symlink-harness", "1.0.0")
        outside = base / "outside-ref.json"
        outside.write_bytes(ref_path.read_bytes())
        ref_path.unlink()
        ref_path.symlink_to(outside)
        try:
            linked.lookup("symlink-harness", public_key_path=public_key_path)
            raise AssertionError("versionless symlinked ref was accepted")
        except RegistryError as exc:
            assert "symlink refused" in str(exc)

        assert canonical_json({"\U00010000": 1, "\ue000": 2}).startswith(b'{"\xf0\x90\x80\x80"')
    print("graph_harness_registry self-test: ok")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run dependency-free refusal and durability tests")
    parser.add_argument("--schema", type=Path, help="override the v1 schema path")
    sub = parser.add_subparsers(dest="command")
    register = sub.add_parser("register", help="register one already-admitted envelope")
    register.add_argument("envelope", type=Path)
    register.add_argument("--registry", required=True, type=Path)
    lookup = sub.add_parser("lookup", help="select the highest compatible admitted envelope")
    lookup.add_argument("name")
    lookup.add_argument("--registry", required=True, type=Path)
    lookup.add_argument("--version")
    lookup.add_argument("--min-version")
    lookup.add_argument("--tag", action="append", default=[])
    lookup.add_argument("--projection", choices=["aiko_skill_v1", "cell_v0"])
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.self_test:
            self_test()
            return 0
        if args.command == "register":
            envelope = parse_json(_read_regular_file(args.envelope))
            registry = HarnessRegistry(args.registry, args.schema)
            result = registry.register(
                envelope, public_key_path=_bootstrap_public_key_path())
            print(canonical_json(result).decode("utf-8"))
            return 0
        if args.command == "lookup":
            registry = HarnessRegistry(args.registry, args.schema)
            result = registry.lookup(
                args.name, version=args.version, min_version=args.min_version,
                tags=args.tag, projection=args.projection,
                public_key_path=_bootstrap_public_key_path())
            sys.stdout.buffer.write(canonical_json(result) + b"\n")
            return 0
        _parser().print_help(sys.stderr)
        return 2
    except (RegistryError, OSError) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
