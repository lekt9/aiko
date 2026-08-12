#!/usr/bin/env python3
"""Deterministic, fail-closed GraphHarness v1 package compiler.

This module validates and packages declarations.  It intentionally contains no
scheduler, executor, ledger, lease, or settlement implementation.
"""
from __future__ import annotations

import argparse
import copy
import datetime as _datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import stat
import tempfile
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse

API_VERSION = "graph-harness/v1"
MEDIA_TYPE = "application/vnd.aiko.graph-harness+json;version=1"
SHA = re.compile(r"^[0-9a-f]{64}$")
MAX_SAFE_INTEGER = 9007199254740991
MAX_VERIFY_KEY_BYTES = 65536
AUTH_ALGORITHM = "ed25519"
OPENSSL = "/usr/bin/openssl"

class Refusal(ValueError):
    """The declaration cannot safely be admitted."""


def _refuse(path: str, message: str) -> None:
    raise Refusal(f"{path}: {message}")


def _key_bytes(value: str) -> bytes:
    return value.encode("utf-16-be", "strict")


def canonical_json(value: Any) -> bytes:
    """Return RFC-8785-compatible bytes for this schema's integer-only domain."""
    def emit(v: Any, path: str) -> str:
        if v is None: return "null"
        if v is True: return "true"
        if v is False: return "false"
        if isinstance(v, int) and not isinstance(v, bool):
            if abs(v) > MAX_SAFE_INTEGER: _refuse(path, "integer is outside the I-JSON exact range")
            return str(v)
        if isinstance(v, float): _refuse(path, "floating point JSON is unsupported; admission refuses ambiguity")
        if isinstance(v, str):
            try: v.encode("utf-8", "strict")
            except UnicodeError: _refuse(path, "unpaired Unicode surrogate")
            return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        if isinstance(v, list): return "[" + ",".join(emit(x, f"{path}/{i}") for i, x in enumerate(v)) + "]"
        if isinstance(v, dict):
            for k in v:
                if not isinstance(k, str): _refuse(path, "object key is not a string")
            keys = sorted(v, key=_key_bytes)
            return "{" + ",".join(emit(k, path) + ":" + emit(v[k], f"{path}/{k}") for k in keys) + "}"
        _refuse(path, f"unsupported value type {type(v).__name__}")
    return emit(value, "$").encode("utf-8")


def digest_value(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _attestation_statement(attestation: dict[str, Any]) -> bytes:
    statement = copy.deepcopy(attestation)
    statement["authentication"]["value"] = ""
    return canonical_json(statement)


def _write_0600(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=True) as stream:
            fd = -1
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        if fd >= 0:
            os.close(fd)


def _openssl(argv: list[str]) -> bool:
    try:
        completed = subprocess.run(
            [OPENSSL, *argv], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, env={"LANG": "C", "LC_ALL": "C"}, timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def _read_verifier_pem(path: Path) -> bytes:
    fd = -1
    try:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            _refuse("$AIKO_CONTRACT_VERIFY_KEY", "verifier key must be a regular non-symlink file")
        with os.fdopen(fd, "rb", closefd=True) as stream:
            fd = -1
            pem = stream.read(MAX_VERIFY_KEY_BYTES + 1)
    except OSError as exc:
        raise Refusal(f"$AIKO_CONTRACT_VERIFY_KEY: cannot read verifier key: {exc}") from exc
    finally:
        if fd >= 0:
            os.close(fd)
    if not pem:
        _refuse("$AIKO_CONTRACT_VERIFY_KEY", "verifier key is empty")
    if len(pem) > MAX_VERIFY_KEY_BYTES:
        _refuse("$AIKO_CONTRACT_VERIFY_KEY", f"verifier key exceeds {MAX_VERIFY_KEY_BYTES} bytes")
    # OpenSSL's file-based `pkey -pubin` will derive a public key from some
    # PKCS#8 private PEM inputs. Refuse by envelope before invoking it: a
    # verifier deployment may possess public SPKI only, never signing custody.
    public_pem = re.compile(
        rb"\A-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,64}\r?\n)+-----END PUBLIC KEY-----\r?\n?\Z"
    )
    if public_pem.fullmatch(pem) is None:
        _refuse("$AIKO_CONTRACT_VERIFY_KEY", "verifier must be a public-only SubjectPublicKeyInfo PEM")
    return pem


def _verifier_material(path: Path) -> tuple[bytes, str]:
    pem = _read_verifier_pem(path)
    with tempfile.TemporaryDirectory() as td:
        directory = Path(td)
        key_file, der_file = directory / "verify.pem", directory / "verify.der"
        _write_0600(key_file, pem)
        if not _openssl(["pkey", "-pubin", "-in", str(key_file), "-outform", "DER", "-out", str(der_file)]):
            _refuse("$AIKO_CONTRACT_VERIFY_KEY", "OpenSSL refused the PEM public key")
        try:
            der = der_file.read_bytes()
        except OSError as exc:
            raise Refusal(f"$AIKO_CONTRACT_VERIFY_KEY: cannot read OpenSSL-derived public key: {exc}") from exc
    # An Ed25519 SubjectPublicKeyInfo has the id-Ed25519 AlgorithmIdentifier
    # (with no parameters) and exactly one 32-byte public key BIT STRING.
    if len(der) != 44 or not der.startswith(bytes.fromhex("302a300506032b6570032100")):
        _refuse("$AIKO_CONTRACT_VERIFY_KEY", "public key is not Ed25519 SubjectPublicKeyInfo")
    return pem, "sha256:" + hashlib.sha256(der).hexdigest()


def _authenticate_attestation(attestation: dict[str, Any], verifier_path: Path) -> None:
    pem, expected_key_id = _verifier_material(verifier_path)
    authentication = attestation["authentication"]
    if authentication["key_id"] != expected_key_id:
        _refuse("$/authentication/key_id", "does not identify the deployment verifier key")
    try:
        signature = bytes.fromhex(authentication["value"])
    except ValueError:
        _refuse("$/authentication/value", "invalid Ed25519 signature encoding")
    if len(signature) != 64:
        _refuse("$/authentication/value", "invalid Ed25519 signature length")
    with tempfile.TemporaryDirectory() as td:
        directory = Path(td)
        key_file, message_file, signature_file = (
            directory / "verify.pem", directory / "attestation.json", directory / "signature.bin"
        )
        _write_0600(key_file, pem)
        _write_0600(message_file, _attestation_statement(attestation))
        _write_0600(signature_file, signature)
        verified = _openssl([
            "pkeyutl", "-verify", "-pubin", "-rawin", "-inkey", str(key_file),
            "-in", str(message_file), "-sigfile", str(signature_file),
        ])
    if not verified:
        _refuse("$/authentication/value", "Ed25519 verification failed")


def _bootstrap_verifier_path() -> Path:
    value = os.environ.get("AIKO_CONTRACT_VERIFY_KEY", "")
    if not value:
        _refuse("$AIKO_CONTRACT_VERIFY_KEY", "deployment verifier key path is not configured")
    path = Path(value)
    if not path.is_absolute():
        _refuse("$AIKO_CONTRACT_VERIFY_KEY", "deployment verifier key path must be absolute")
    return path



def _equal_unique(items: list[Any]) -> bool:
    seen: set[bytes] = set()
    for item in items:
        encoded = canonical_json(item)
        if encoded in seen: return False
        seen.add(encoded)
    return True

class SchemaValidator:
    """Small complete validator for the checked-in, self-contained v1 schema."""
    def __init__(self, schema: dict[str, Any]): self.root = schema
    def validate(self, value: Any) -> None: self._check(value, self.root, "$")
    def _resolve(self, ref: str) -> dict[str, Any]:
        if not ref.startswith("#/"): raise Refusal(f"schema: unsupported external $ref {ref!r}")
        node: Any = self.root
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(node, dict) or part not in node: raise Refusal(f"schema: unresolved $ref {ref!r}")
            node = node[part]
        if not isinstance(node, dict): raise Refusal(f"schema: $ref {ref!r} is not a schema")
        return node
    def _matches(self, value: Any, schema: dict[str, Any], path: str) -> bool:
        try: self._check(value, schema, path); return True
        except Refusal: return False
    def _check(self, value: Any, s: dict[str, Any], path: str) -> None:
        if "$ref" in s: self._check(value, self._resolve(s["$ref"]), path)
        if "const" in s and value != s["const"]: _refuse(path, f"must equal {s['const']!r}")
        if "enum" in s and value not in s["enum"]: _refuse(path, f"not one of {s['enum']!r}")
        typ=s.get("type")
        good={"object": isinstance(value,dict), "array": isinstance(value,list), "string": isinstance(value,str),
              "integer": isinstance(value,int) and not isinstance(value,bool), "boolean": isinstance(value,bool),
              "null": value is None}
        if typ and not good.get(typ,False): _refuse(path, f"expected {typ}")
        if isinstance(value,dict):
            required=s.get("required",[])
            for key in required:
                if key not in value: _refuse(path, f"missing required field {key!r}")
            props=s.get("properties",{})
            extra=s.get("additionalProperties", True)
            for key,val in value.items():
                if key in props: self._check(val,props[key],f"{path}/{key}")
                elif isinstance(extra,dict): self._check(val,extra,f"{path}/{key}")
                elif extra is False: _refuse(path, f"unknown field {key!r}")
            pn=s.get("propertyNames",{})
            if "pattern" in pn:
                for key in value:
                    if re.search(pn["pattern"],key) is None: _refuse(path,f"invalid property name {key!r}")
        if isinstance(value,list):
            if len(value)<s.get("minItems",0): _refuse(path,"too few items")
            if "maxItems" in s and len(value)>s["maxItems"]: _refuse(path,"too many items")
            if s.get("uniqueItems") and not _equal_unique(value): _refuse(path,"items are not unique")
            if "items" in s:
                for i,item in enumerate(value): self._check(item,s["items"],f"{path}/{i}")
        if isinstance(value,str):
            if len(value)<s.get("minLength",0): _refuse(path,"string is too short")
            if "maxLength" in s and len(value)>s["maxLength"]: _refuse(path,"string is too long")
            if "pattern" in s and re.search(s["pattern"],value) is None: _refuse(path,"string does not match pattern")
            if s.get("format")=="date-time":
                try:
                    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value) is None: raise ValueError
                    _datetime.datetime.fromisoformat(value.replace("Z","+00:00"))
                except ValueError: _refuse(path,"invalid RFC 3339 date-time")
        if isinstance(value,int) and not isinstance(value,bool):
            if "minimum" in s and value<s["minimum"]: _refuse(path,"below minimum")
            if "maximum" in s and value>s["maximum"]: _refuse(path,"above maximum")
        for sub in s.get("allOf",[]): self._check(value,sub,path)
        if "anyOf" in s and not any(self._matches(value,x,path) for x in s["anyOf"]): _refuse(path,"does not match any allowed shape")
        if "if" in s and self._matches(value,s["if"],path): self._check(value,s.get("then",{}),path)


def _load_json(path: Path) -> Any:
    def no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise Refusal(f"duplicate JSON member {key!r}")
            result[key] = value
        return result
    try:
        with path.open("r",encoding="utf-8") as f:
            return json.load(f, object_pairs_hook=no_duplicates,
                             parse_float=lambda x: (_ for _ in ()).throw(Refusal("floating point JSON is unsupported")),
                             parse_constant=lambda x: (_ for _ in ()).throw(Refusal(f"invalid JSON constant {x}")))
    except (OSError,json.JSONDecodeError) as e: raise Refusal(f"{path}: cannot read JSON: {e}") from e

def _schema() -> dict[str,Any]:
    path=Path(__file__).resolve().parent.parent/"schemas"/"graph-harness-v1.schema.json"
    result=_load_json(path)
    if not isinstance(result,dict): raise Refusal("checked-in schema is not an object")
    return result

def _canonicalise_declaration(e:dict[str,Any]) -> None:
    """Normalise fields whose schema semantics are sets, never execution order."""
    p=e.get("package",{})
    def sort_scalars(obj:dict[str,Any],keys:tuple[str,...]) -> None:
        for k in keys:
            if isinstance(obj.get(k),list): obj[k]=sorted(obj[k])
    membrane=p.get("membrane",{})
    for values in membrane.get("authority",{}).values():
        if isinstance(values,list): values.sort()
    for side in ("inputs","outputs"):
        # Object ordering is handled by JCS.
        for port in membrane.get(side,{}).values(): pass
    for a in [p.get("north_star")]+[n.get("acceptance") for n in p.get("nodes",[])]:
        if not isinstance(a,dict): continue
        w=a.get("witness",{}); sort_scalars(w.get("expected",{}),("exit_codes","artifacts"))
        if isinstance(w.get("evidence"),list): w["evidence"].sort(key=lambda x:canonical_json(x))
        sort_scalars(a.get("judge",{}),("consumes",))
    for n in p.get("nodes",[]):
        sort_scalars(n,("depends_on","reads","produces","writes"))
        for key in ("resources","effects"):
            if isinstance(n.get(key),list): n[key].sort(key=lambda x:canonical_json(x))
        g=n.get("grounding",{}); sort_scalars(g,("capability_gaps",))
        for key in ("skills","sources"):
            if isinstance(g.get(key),list): g[key].sort(key=lambda x:canonical_json(x))
    if isinstance(p.get("nodes"),list): p["nodes"].sort(key=lambda x:x.get("id",""))
    if isinstance(p.get("edges"),list):
        p["edges"].sort(key=lambda x:(x.get("from",{}).get("node",""),x.get("from",{}).get("port",""),x.get("to",{}).get("node",""),x.get("to",{}).get("port","")))
    if isinstance(p.get("provenance",{}).get("source_digests"),list):
        p["provenance"]["source_digests"].sort(key=lambda x:canonical_json(x))
    reg=e.get("registry",{}); sort_scalars(reg,("tags",))


class Compiler:
    def __init__(self, root: Path, verifier_path: Path | None = None):
        self.root=root.resolve(strict=True)
        if not self.root.is_dir(): raise Refusal(f"reference root is not a directory: {root}")
        self.validator=SchemaValidator(_schema())
        self.verifier_path=verifier_path
        self._nested: set[Path]=set()

    def resolve(self, ref: str) -> Path:
        parsed=urlparse(ref)
        if parsed.scheme not in ("","file"): raise Refusal(f"reference {ref!r}: unsupported URI scheme")
        if parsed.scheme=="file":
            if parsed.netloc not in ("","localhost"): raise Refusal(f"reference {ref!r}: remote file authority refused")
            raw=unquote(parsed.path)
            candidate=Path(raw)
        else:
            if parsed.query or parsed.fragment: raise Refusal(f"reference {ref!r}: query/fragment refused")
            candidate=Path(unquote(parsed.path))
        path=(candidate if candidate.is_absolute() else self.root/candidate)
        try: real=path.resolve(strict=True)
        except OSError as e: raise Refusal(f"reference {ref!r}: unresolved: {e}") from e
        try: real.relative_to(self.root)
        except ValueError: raise Refusal(f"reference {ref!r}: escapes reference root")
        if not real.is_file(): raise Refusal(f"reference {ref!r}: not a regular file")
        return real

    @staticmethod
    def _skill_frontmatter(data: bytes, expected_name: str, path: str) -> dict[str, str]:
        try:
            text=data.decode("utf-8", "strict")
        except UnicodeDecodeError as ex:
            raise Refusal(f"{path}: SKILL.md is not UTF-8: {ex}") from ex
        lines=text.splitlines()
        if not lines or lines[0] != "---":
            raise Refusal(f"{path}: SKILL.md must begin with YAML frontmatter")
        try:
            end=lines.index("---",1)
        except ValueError as ex:
            raise Refusal(f"{path}: SKILL.md frontmatter is not closed") from ex
        allowed={"name","description","probe_input","expect_contains"}; values:dict[str,str]={}
        for number,line in enumerate(lines[1:end],2):
            match=re.fullmatch(r"([a-z_]+):[ ]*(.*)",line)
            if not match: raise Refusal(f"{path}:{number}: unsupported SKILL.md frontmatter syntax")
            key,raw=match.groups()
            if key not in allowed: raise Refusal(f"{path}:{number}: unknown SKILL.md field {key!r}")
            if key in values: raise Refusal(f"{path}:{number}: duplicate SKILL.md field {key!r}")
            if raw.startswith(('"', "'")):
                if not raw.startswith('"'):
                    raise Refusal(f"{path}:{number}: only JSON-quoted or plain scalar values are supported")
                try: value=json.loads(raw)
                except json.JSONDecodeError as ex: raise Refusal(f"{path}:{number}: invalid quoted scalar") from ex
            else:
                value=raw
            if not isinstance(value,str) or not value.strip(): raise Refusal(f"{path}:{number}: {key} must be a non-empty string")
            values[key]=value
        missing=sorted(allowed-values.keys())
        if missing: raise Refusal(f"{path}: SKILL.md missing required frontmatter: {', '.join(missing)}")
        if values["name"] != expected_name: raise Refusal(f"{path}: SKILL.md name {values['name']!r} does not match grounding name {expected_name!r}")
        if re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*",values["name"]) is None:
            raise Refusal(f"{path}: invalid SKILL.md name")
        return values

    def material(self, ref: str, claimed: dict[str,Any], kind: str, expected_name: str|None=None) -> dict[str,Any]:
        path=self.resolve(ref)
        data=path.read_bytes()
        actual=hashlib.sha256(data).hexdigest()
        if claimed.get("algorithm")!="sha256" or claimed.get("value")!=actual:
            raise Refusal(f"reference {ref!r}: digest mismatch (claimed {claimed.get('value')}, actual {actual})")
        if kind=="skill":
            if expected_name is None: raise Refusal(f"reference {ref!r}: skill grounding lacks an expected identity")
            self._skill_frontmatter(data,expected_name,ref)
        entry={"kind":kind,"ref":ref,"digest":{"algorithm":"sha256","value":actual}}
        if kind=="graph-harness":
            if path in self._nested: raise Refusal(f"reference {ref!r}: recursive package closure cycle")
            self._nested.add(path)
            try: nested=self.inspect(_load_json(path), verify_closure=True)
            finally: self._nested.remove(path)
            entry["transitive_digest"]=nested["admission"]["transitive_digest"]
        return entry

    def _implementations(self,e:dict[str,Any]) -> Iterable[tuple[str,dict[str,Any],str]]:
        p=e["package"]
        for side in ("inputs","outputs"):
            for port in p["membrane"][side].values(): yield ("schema",port["schema"],f"membrane.{side}")
        def acc(a:dict[str,Any]):
            w=a["witness"]; yield ("witness",w["implementation"],"witness")
            if "stdout_schema" in w["expected"]: yield ("schema",w["expected"]["stdout_schema"],"stdout_schema")
            for ev in w["evidence"]:
                if "schema" in ev: yield ("schema",ev["schema"],"evidence_schema")
            j=a["judge"]; yield ("judge",j["implementation"],"judge"); yield ("schema",j["verdict_schema"],"verdict_schema")
        yield from acc(p["north_star"])
        for n in p["nodes"]:
            yield ("cell",n["implementation"],f"node {n['id']}")
            for sk in n["grounding"].get("skills",[]): yield ("skill",sk["declaration"],sk["name"])
            for src in n["grounding"].get("sources",[]): yield ("source",src,f"node {n['id']} source")
            yield from acc(n["acceptance"])
        for src in p["provenance"]["source_digests"]:
            kind="graph-harness" if src.get("media_type")==MEDIA_TYPE else "source"
            yield (kind,src,"provenance source")
        yield ("generator",p["provenance"]["generator"],"generator")
        # The external attester is pinned and verified separately; it is not
        # package material and cannot mutate the prepared transitive identity.
        cell=e["registry"]["projections"].get("cell_v0")
        if cell: yield ("cell",cell,"cell projection")

    def closure(self,e:dict[str,Any]) -> list[dict[str,Any]]:
        entries=[]
        for kind,impl,context in self._implementations(e):
            entries.append(self.material(impl["ref"],impl["digest"],kind,context if kind=="skill" else None))
        # A repeated material identity is one closure member; conflicting kinds remain explicit.
        by_key:dict[bytes,dict[str,Any]]={}
        for x in entries: by_key[canonical_json(x)]=x
        return [by_key[k] for k in sorted(by_key)]

    def build(self, candidate:dict[str,Any]) -> dict[str,Any]:
        e=copy.deepcopy(candidate)
        if not isinstance(e,dict): raise Refusal("$: envelope must be an object")
        # Build can establish identity and material closure, never behavior.
        # Discard any caller-supplied admission claim; only `admit` can create it.
        e.pop("admission",None)
        _canonicalise_declaration(e)
        adm=e["admission"]={"state":"prepared", "subject":"/package", "canonicalization":"rfc8785-json"}
        adm["subject_digest"]={"algorithm":"sha256","value":digest_value(e.get("package"))}
        # Temporarily provide valid derived shapes so traversal can validate material.
        # One valid-shaped sentinel satisfies structural validation only; it is
        # replaced before the result can escape the compiler.
        adm["dependency_closure"]=[{"kind":"source","ref":"compiler-sentinel","digest":{"algorithm":"sha256","value":"0"*64}}]
        adm["transitive_digest"]={"algorithm":"sha256","value":"0"*64}
        self.validator.validate(e)
        closure=self.closure(e)
        if not closure: raise Refusal("$/admission/dependency_closure: empty material closure")
        adm["dependency_closure"]=closure
        adm["transitive_digest"]={"algorithm":"sha256","value":digest_value({"subject_digest":adm["subject_digest"],"dependency_closure":closure})}
        self.validator.validate(e); self.semantic(e)
        return e

    def inspect(self,e:dict[str,Any],verify_closure:bool=True) -> dict[str,Any]:
        self.validator.validate(e); self.semantic(e)
        actual=digest_value(e["package"])
        if e["admission"]["subject_digest"]["value"]!=actual: raise Refusal("$/admission/subject_digest: package digest mismatch")
        closure=self.closure(e)
        if verify_closure and canonical_json(closure)!=canonical_json(e["admission"]["dependency_closure"]): raise Refusal("$/admission/dependency_closure: not the canonical material closure")
        trans=digest_value({"subject_digest":e["admission"]["subject_digest"],"dependency_closure":closure})
        if e["admission"]["transitive_digest"]["value"]!=trans: raise Refusal("$/admission/transitive_digest: mismatch")
        if e["admission"]["state"]=="admitted":
            adm=e["admission"]
            self._verify_verdicts(e,adm["verdicts"],adm["evidence_refs"])
            self.material(adm["admitted_by"]["ref"],adm["admitted_by"]["digest"],"judge")
            attestation={"api_version":"graph-harness-attestation/v1","kind":"GraphHarnessAdmissionAttestation","owner":"contract",
                         "subject_digest":adm["subject_digest"],"transitive_digest":adm["transitive_digest"],
                         "verdicts":adm["verdicts"],"admitted_by":adm["admitted_by"],"admitted_at":adm["admitted_at"],
                         "evidence_refs":adm["evidence_refs"],"ledger_ref":adm["ledger_ref"],
                         "authentication":adm["authentication"]}
            if adm["attestation_digest"]["value"]!=digest_value(attestation):
                _refuse("$/admission/attestation_digest","admitted metadata no longer matches the external attestation identity")
            if self.verifier_path is None:
                _refuse("$AIKO_CONTRACT_VERIFY_KEY","admitted inspection requires the deployment verifier key")
            _authenticate_attestation(attestation,self.verifier_path)
        return e

    @staticmethod
    def _expected_judges(e:dict[str,Any]) -> dict[str,dict[str,Any]]:
        pairs=[(e["package"]["north_star"]["witness"]["id"],e["package"]["north_star"]["judge"]["implementation"])]
        pairs += [(n["acceptance"]["witness"]["id"],n["acceptance"]["judge"]["implementation"]) for n in e["package"]["nodes"]]
        result:dict[str,dict[str,Any]]={}
        for witness_id,judge in pairs:
            if witness_id in result: _refuse("$/package",f"witness id {witness_id!r} is not globally unique")
            result[witness_id]=judge
        return result

    def _verify_verdicts(self,e:dict[str,Any],verdicts:list[dict[str,Any]],evidence_refs:list[str]) -> None:
        expected=self._expected_judges(e); got:dict[str,dict[str,Any]]={}
        for i,v in enumerate(verdicts):
            wid=v["witness_id"]
            if wid in got: _refuse(f"$/verdicts/{i}/witness_id","duplicate witness verdict")
            got[wid]=v
            if v["verdict_ref"] not in evidence_refs: _refuse(f"$/verdicts/{i}/verdict_ref","must be included in evidence_refs")
        if set(got)!=set(expected):
            _refuse("$/verdicts",f"must cover exactly every root/node witness id (expected {sorted(expected)}, got {sorted(got)})")
        for wid,judge in expected.items():
            if canonical_json(got[wid]["judge"])!=canonical_json(judge):
                _refuse(f"$/verdicts/{wid}/judge","does not match the package's independent judge identity")

    def admit(self,prepared:dict[str,Any],attestation:dict[str,Any],verifier_path:Path) -> dict[str,Any]:
        e=copy.deepcopy(self.inspect(prepared))
        if e["admission"]["state"]!="prepared": _refuse("$/admission/state","admit requires a prepared envelope")
        SchemaValidator(_schema())._check(attestation,_schema()["$defs"]["admission_attestation"],"$")
        # Contract ownership is established by possession of the configured key,
        # not by the caller-authored owner string. Authenticate the complete
        # statement before any behavioral state transition.
        _authenticate_attestation(attestation, verifier_path)
        adm=e["admission"]
        for key in ("subject_digest","transitive_digest"):
            if canonical_json(attestation[key])!=canonical_json(adm[key]): _refuse(f"$/{key}","attestation is not bound to the prepared identity")
        self._verify_verdicts(e,attestation["verdicts"],attestation["evidence_refs"])
        # This resolves and hashes the Contract-owned attester, but never invokes it.
        self.material(attestation["admitted_by"]["ref"],attestation["admitted_by"]["digest"],"judge")
        digest={"algorithm":"sha256","value":digest_value(attestation)}
        adm.update({"state":"admitted","admitted_by":copy.deepcopy(attestation["admitted_by"]),
                    "admitted_at":attestation["admitted_at"],"evidence_refs":copy.deepcopy(attestation["evidence_refs"]),
                    "ledger_ref":attestation["ledger_ref"],"verdicts":copy.deepcopy(attestation["verdicts"]),
                    "authentication":copy.deepcopy(attestation["authentication"]),
                    "attestation_digest":digest})
        self.validator.validate(e); self.semantic(e)
        return e

    @staticmethod
    def _independent(j:dict[str,Any], producers:list[dict[str,Any]],path:str) -> None:
        ji=j["implementation"]
        for prod in producers:
            if ji["ref"]==prod["ref"] or ji["digest"]["value"]==prod["digest"]["value"]:
                _refuse(path,"judge is not independent of producer or witness implementation")

    def semantic(self,e:dict[str,Any]) -> None:
        p=e["package"]; meta=p["metadata"]; reg=e["registry"]
        for k in ("name","version","description"):
            if reg[k]!=meta[k]: _refuse(f"$/registry/{k}","does not match package metadata")
        nodes=p["nodes"]; ids=[n["id"] for n in nodes]
        if len(ids)!=len(set(ids)): _refuse("$/package/nodes","duplicate node id")
        by={n["id"]:n for n in nodes}
        for n in nodes:
            for d in n["depends_on"]:
                if d not in by: _refuse(f"$/package/nodes/{n['id']}/depends_on",f"unknown dependency {d!r}")
                if d==n["id"]: _refuse(f"$/package/nodes/{n['id']}","self dependency")
        # Kahn only validates topology; it does not schedule or expose a frontier.
        indeg={i:len(by[i]["depends_on"]) for i in ids}; children={i:[] for i in ids}
        for n in nodes:
            for d in n["depends_on"]: children[d].append(n["id"])
        ready=sorted(i for i,v in indeg.items() if v==0); seen=[]; depth={i:0 for i in ready}
        while ready:
            cur=ready.pop(0); seen.append(cur)
            for child in sorted(children[cur]):
                depth[child]=max(depth.get(child,0),depth[cur]+1); indeg[child]-=1
                if indeg[child]==0: ready.append(child); ready.sort()
        if len(seen)!=len(ids): _refuse("$/package/nodes","dependency cycle")
        edge_keys=[(x["from"]["node"],x["from"]["port"],x["to"]["node"],x["to"]["port"]) for x in p["edges"]]
        if edge_keys!=sorted(edge_keys): _refuse("$/package/edges","edges are not in canonical lexical order")
        input_ports=p["membrane"]["inputs"]; output_ports=p["membrane"]["outputs"]
        dependency_edges=set()
        incoming={i:set() for i in ids}; outgoing={i:set() for i in ids}
        for i,x in enumerate(p["edges"]):
            a,ap,b,bp=edge_keys[i]
            if a=="$output" or b=="$input": _refuse(f"$/package/edges/{i}","edge direction crosses membrane backwards")
            if a=="$input":
                if ap not in input_ports: _refuse(f"$/package/edges/{i}/from",f"unknown input port {ap!r}")
            elif a not in by: _refuse(f"$/package/edges/{i}/from",f"unknown node {a!r}")
            elif ap not in by[a]["produces"]: _refuse(f"$/package/edges/{i}/from",f"port {ap!r} is not produced")
            if b=="$output":
                if bp not in output_ports: _refuse(f"$/package/edges/{i}/to",f"unknown output port {bp!r}")
            elif b not in by: _refuse(f"$/package/edges/{i}/to",f"unknown node {b!r}")
            elif bp not in by[b]["reads"]: _refuse(f"$/package/edges/{i}/to",f"port {bp!r} is not declared in reads")
            if a not in ("$input","$output") and b not in ("$input","$output"):
                dependency_edges.add((a,b)); incoming[b].add(bp); outgoing[a].add(ap)
                if a not in by[b]["depends_on"]: _refuse(f"$/package/edges/{i}","data edge lacks matching depends_on")
            elif b in by: incoming[b].add(bp)
            elif a in by: outgoing[a].add(ap)
        for n in nodes:
            for d in n["depends_on"]:
                if (d,n["id"]) not in dependency_edges: _refuse(f"$/package/nodes/{n['id']}/depends_on",f"dependency {d!r} carries no explicit data edge")
            reads=set(n["reads"]); bound=incoming[n["id"]]
            if not bound.issubset(reads): _refuse(f"$/package/nodes/{n['id']}/reads","missing a port bound by an incoming edge")
            pinned_sources={x["ref"] for x in n["grounding"].get("sources",[])}
            unbound=reads-bound
            if not unbound.issubset(pinned_sources): _refuse(f"$/package/nodes/{n['id']}/reads","unbound read is not a pinned grounding source")
            # Every declared product must be carried to a descendant or membrane output.
            if set(n["produces"])!=outgoing[n["id"]]: _refuse(f"$/package/nodes/{n['id']}/produces","must equal ports bound by outgoing edges")
        rec=p["recursion"]
        if len(nodes)>rec["max_total_nodes"]: _refuse("$/package/recursion/max_total_nodes","smaller than declared graph")
        if max(depth.values(),default=0)>rec["max_depth"]: _refuse("$/package/recursion/max_depth","smaller than graph depth")
        if max((len(v) for v in children.values()),default=0)>rec["max_children_per_node"]: _refuse("$/package/recursion/max_children_per_node","smaller than declared fan-out")
        acceptances=[p["north_star"]]+[n["acceptance"] for n in nodes]
        if len(acceptances)>rec["max_tool_calls"]: _refuse("$/package/recursion/max_tool_calls","cannot cover all mandatory witnesses")
        if sum(a["witness"]["timeout_ms"] for a in acceptances)>rec["max_wall_time_ms"]: _refuse("$/package/recursion/max_wall_time_ms","cannot cover mandatory witness timeouts")
        for n in nodes:
            self._independent(n["acceptance"]["judge"],[n["implementation"], n["acceptance"]["witness"]["implementation"]],f"$/package/nodes/{n['id']}/acceptance/judge")
            self._acceptance(n["acceptance"],f"$/package/nodes/{n['id']}/acceptance")
        self._independent(p["north_star"]["judge"],[n["implementation"] for n in nodes] + [p["north_star"]["witness"]["implementation"]],"$/package/north_star/judge")
        self._acceptance(p["north_star"],"$/package/north_star")
        self._authority(p)
        parent=p["provenance"].get("parent_package_digest")
        if parent and parent["value"]==e["admission"]["subject_digest"]["value"]: _refuse("$/package/provenance/parent_package_digest","package cannot be its own parent")

    @staticmethod
    def _acceptance(a:dict[str,Any],path:str) -> None:
        w=a["witness"]; names={x["name"] for x in w["evidence"]}; refs={x["ref"] for x in w["evidence"]}
        for consumed in a["judge"]["consumes"]:
            if consumed not in names and consumed not in refs: _refuse(path+"/judge/consumes",f"{consumed!r} is not witness evidence")
        artifacts=set(w["expected"].get("artifacts",[]))
        evrefs={x["ref"] for x in w["evidence"] if x["kind"] in ("artifact","durable-state","boundary-readback")}
        if artifacts and not artifacts.issubset(evrefs): _refuse(path+"/witness/expected/artifacts","artifact lacks independent evidence declaration")
        if a["judge"].get("policy")=="quorum" and a["judge"]["quorum"]>len(a["judge"]["consumes"]): _refuse(path+"/judge/quorum","exceeds evidence inputs")

    @staticmethod
    def _scope_allowed(scope:str, allowed:list[str], *, filesystem: bool = False) -> bool:
        # A lexical authority declaration must not change meaning after path
        # normalization on another executor. Runtime confinement is still owed.
        def safe(value: str) -> bool:
            if not filesystem:
                return True
            if "\\" in value or "//" in value:
                return False
            return all(part not in ("", ".", "..") for part in value.rstrip("/").split("/"))
        if not safe(scope):
            return False
        s=scope.rstrip("/")
        def base(a: str) -> str:
            a=a.rstrip("/")
            if a.endswith("/**"): return a[:-3].rstrip("/")
            if a.endswith("/*"): return a[:-2].rstrip("/")
            return a
        return any(safe(a) and (s==base(a) or s.startswith(base(a)+"/")) for a in allowed)

    def _authority(self,p:dict[str,Any]) -> None:
        auth=p["membrane"]["authority"]
        mapping={"filesystem":"filesystem","network":"network","process":"process","secret":"secrets","service":"network"}
        for n in p["nodes"]:
            for write in n["writes"]:
                if not self._scope_allowed(write,auth["filesystem"], filesystem=True): _refuse(f"$/package/nodes/{n['id']}/writes",f"{write!r} outside filesystem authority")
            for r in n["resources"]:
                key=mapping.get(r["kind"])
                if key is None: _refuse(f"$/package/nodes/{n['id']}/resources",f"resource kind {r['kind']!r} has no enforceable membrane authority")
                if not self._scope_allowed(r["scope"],auth[key], filesystem=(key == "filesystem")): _refuse(f"$/package/nodes/{n['id']}/resources",f"scope {r['scope']!r} outside {key} authority")
                if r["kind"]=="filesystem" and r["mode"]=="write" and r["scope"] not in n["writes"]: _refuse(f"$/package/nodes/{n['id']}/resources","filesystem write resource missing from writes")
            for eff in n["effects"]:
                if eff["kind"]=="none":
                    if eff["external_boundary"] or eff["readback"]!="not-applicable" or eff["on_invalidation"]!="recompute": _refuse(f"$/package/nodes/{n['id']}/effects","none effect is inconsistent")
                    continue
                key={"filesystem":"filesystem","message":"network","payment":"network","deployment":"network","remote-mutation":"network"}.get(eff["kind"])
                if key is None: _refuse(f"$/package/nodes/{n['id']}/effects",f"effect kind {eff['kind']!r} has no enforceable membrane authority")
                if not self._scope_allowed(eff["scope"],auth[key]): _refuse(f"$/package/nodes/{n['id']}/effects",f"scope {eff['scope']!r} outside authority")
                if eff["external_boundary"]:
                    readbacks=[x for x in n["acceptance"]["witness"]["evidence"] if x["kind"]=="boundary-readback"]
                    consumes=n["acceptance"]["judge"]["consumes"]
                    if not any(x["name"] in consumes or x["ref"] in consumes for x in readbacks): _refuse(f"$/package/nodes/{n['id']}/effects","external effect lacks independently judged boundary read-back")
                elif eff["readback"]=="required": _refuse(f"$/package/nodes/{n['id']}/effects","non-boundary effect cannot claim boundary read-back")


def _summary(e:dict[str,Any]) -> dict[str,Any]:
    state=e["admission"]["state"]
    return {"api_version":e["api_version"],"name":e["package"]["metadata"]["name"],"version":e["package"]["metadata"]["version"],
            "subject_digest":e["admission"]["subject_digest"]["value"],"transitive_digest":e["admission"]["transitive_digest"]["value"],
            "nodes":len(e["package"]["nodes"]),"dependencies":len(e["admission"]["dependency_closure"]),
            "state":state,"prepared":state=="prepared","admitted":state=="admitted"}

def _write(data:bytes,out:str|None) -> None:
    if not out or out=="-": sys.stdout.buffer.write(data+b"\n"); return
    dest=Path(out); dest.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix="."+dest.name+".",dir=str(dest.parent))
    try:
        with os.fdopen(fd,"wb") as f: f.write(data+b"\n"); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,dest)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass

def _walk(package: dict[str,Any]) -> dict[str,Any]:
    nodes=[]
    for n in sorted(package["nodes"],key=lambda x:x["id"]):
        g=n["grounding"]
        item={"id":n["id"],"status":"pending","plan":n.get("description",n["id"]),
              "depends_on":sorted(n["depends_on"]),"writes":sorted(n["writes"]),
              "witness":n["acceptance"]["witness"]["id"]}
        skill_items=sorted(g.get("skills",[]),key=lambda x:x["name"])
        skills=[x["name"] for x in skill_items]
        sources=sorted(x["ref"] for x in g.get("sources",[]))
        gaps=sorted(g.get("capability_gaps",[]))
        if skills:
            item["invoke_skills"]=skills
            item["pinned_skills"]=[{"name":x["name"],"ref":x["declaration"]["ref"],"digest":x["declaration"]["digest"]} for x in skill_items]
        if sources:item["inspire_from"]=sources
        if gaps:item["capability_gaps"]=gaps
        nodes.append(item)
    return {"nodes":nodes}


def _doctor_plan(walk:dict[str,Any], doctor:str|None) -> dict[str,Any]:
    executable=Path(doctor) if doctor else Path(__file__).resolve().parent.parent/"zig-out/bin/aiko-doctor"
    if not executable.is_file(): raise Refusal(f"doctor: executable not found: {executable}")
    with tempfile.TemporaryDirectory(prefix="graph-harness-doctor.") as td:
        wp=Path(td)/"walk.json"; wp.write_bytes(canonical_json(walk)+b"\n")
        try:
            proc=subprocess.run([str(executable),"graph-plan",str(wp)],capture_output=True,timeout=30,check=False)
        except (OSError,subprocess.TimeoutExpired) as ex: raise Refusal(f"doctor: graph-plan failed: {ex}") from ex
    if proc.returncode != 0:
        detail=proc.stderr.decode("utf-8","replace").strip()
        raise Refusal(f"doctor: graph-plan refused declaration: {detail or 'exit '+str(proc.returncode)}")
    try: result=json.loads(proc.stdout)
    except (UnicodeDecodeError,json.JSONDecodeError) as ex: raise Refusal("doctor: graph-plan returned invalid JSON") from ex
    if not isinstance(result,dict): raise Refusal("doctor: graph-plan verdict is not an object")
    if result.get("unknown_dependencies") or result.get("cycle_list") or result.get("ungrounded") or result.get("ungated"):
        raise Refusal("doctor: topology contains unknown, cyclic, ungrounded, or ungated nodes")
    return result


def _skill_md(e:dict[str,Any]) -> bytes:
    meta=e["package"]["metadata"]
    projection=e["registry"].get("projections",{}).get("aiko_skill_v1",{})
    vals={"name":projection.get("name",meta["name"]),"description":projection.get("description",meta["description"]),
          "probe_input":projection.get("probe_input",f"build {meta['name']}"),
          "expect_contains":projection.get("expect_contains","admitted")}
    # JSON string literals are valid YAML scalars and avoid hand-rolled escaping.
    front="\n".join(f"{k}: {json.dumps(v,ensure_ascii=False)}" for k,v in vals.items())
    state=e["admission"]["state"]
    return (f"---\n{front}\n---\n\n# {meta['name']}\n\n{meta['description']}\n"
            f"\nThis {state} GraphHarness declaration is inert: it does not execute, schedule, or settle work.\n").encode()


def _emit_directory(out:Path, files:dict[str,bytes]) -> None:
    out=out.resolve(); out.parent.mkdir(parents=True,exist_ok=True)
    if out.exists(): raise Refusal(f"output directory already exists: {out}")
    stage=Path(tempfile.mkdtemp(prefix="."+out.name+".",dir=out.parent))
    try:
        for name,data in files.items():
            target=stage/name; target.write_bytes(data+(b"\n" if not data.endswith(b"\n") else b""))
        # The completed directory becomes visible in one rename.
        os.replace(stage,out)
    finally:
        if stage.exists(): shutil.rmtree(stage)


def _declared_collisions(package:dict[str,Any]) -> dict[str,Any]:
    resources=[]; effects=[]; nodes=sorted(package["nodes"],key=lambda n:n["id"])
    def overlap(a:str,b:str)->bool:
        a=a.rstrip("/").removesuffix("/**").removesuffix("/*").rstrip("/")
        b=b.rstrip("/").removesuffix("/**").removesuffix("/*").rstrip("/")
        return a==b or a.startswith(b+"/") or b.startswith(a+"/")
    for i,a in enumerate(nodes):
        for b in nodes[i+1:]:
            for ra in a["resources"]:
                for rb in b["resources"]:
                    if ra["kind"]==rb["kind"] and overlap(ra["scope"],rb["scope"]) and (ra.get("exclusive") or rb.get("exclusive")):
                        resources.append({"a":a["id"],"b":b["id"],"kind":ra["kind"],"scopes":sorted([ra["scope"],rb["scope"]])})
            for ea in a["effects"]:
                for eb in b["effects"]:
                    if ea["kind"]!="none" and eb["kind"]!="none" and ea["kind"]==eb["kind"] and overlap(ea["scope"],eb["scope"]):
                        effects.append({"a":a["id"],"b":b["id"],"kind":ea["kind"],"scopes":sorted([ea["scope"],eb["scope"]])})
    return {"resources":resources,"effects":effects}


def _build_command(args:argparse.Namespace) -> int:
    src=Path(args.input).resolve(); root_path=Path(args.root).resolve() if args.root else src.parent
    comp=Compiler(root_path); result=comp.build(_load_json(src))
    walk=_walk(result["package"]); plan=_doctor_plan(walk,args.doctor)
    if args.out_dir:
        manifest={"api_version":API_VERSION,"kind":"GraphHarnessBuildManifest","summary":_summary(result),
                  "topology_diagnostics":plan,"declared_collisions":_declared_collisions(result["package"]),
                  "artifacts":["envelope.json","walk.json","manifest.json","SKILL.md"]}
        _emit_directory(Path(args.out_dir),{"envelope.json":canonical_json(result),"walk.json":canonical_json(walk),
                    "manifest.json":canonical_json(manifest),"SKILL.md":_skill_md(result)})
    else:
        _write(canonical_json(result),args.output)
    return 0


def _admit_command(args:argparse.Namespace) -> int:
    src=Path(args.input).resolve(); root_path=Path(args.root).resolve() if args.root else src.parent
    # This path is deployment bootstrap, never command or request data.
    verifier_path=_bootstrap_verifier_path()
    result=Compiler(root_path).admit(_load_json(src),_load_json(Path(args.attestation).resolve()),verifier_path)
    _write(canonical_json(result),args.output); return 0

def _inspect_command(args:argparse.Namespace) -> int:
    src=Path(args.input).resolve(); root_path=Path(args.root).resolve() if args.root else src.parent
    envelope=_load_json(src)
    verifier_path=_bootstrap_verifier_path() if envelope.get("admission",{}).get("state")=="admitted" else None
    result=Compiler(root_path,verifier_path).inspect(envelope)
    _write(canonical_json(_summary(result) if args.json else result),None); return 0

def _self_test() -> None:
    """Exercise positive determinism and material/edge/judge/bound refusal cases."""
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        materials={name:(name+"\n").encode() for name in ["schema","cell","witness","judge","verdict","source","generator","admitter"]}
        for name,data in materials.items(): (root/name).write_bytes(data)
        def impl(name,media=None):
            x={"ref":name,"digest":{"algorithm":"sha256","value":hashlib.sha256(materials[name]).hexdigest()}}
            if media:x["media_type"]=media
            return x
        acceptance={"claim":"artifact is durably correct","witness":{"id":"test-witness","implementation":impl("witness"),"argv":["test"],"timeout_ms":10,"expected":{"exit_codes":[0],"artifacts":["result.json"]},"evidence":[{"name":"result","kind":"artifact","ref":"result.json","schema":impl("schema")}]},"judge":{"independent":True,"implementation":impl("judge"),"consumes":["result"],"verdict_schema":impl("verdict"),"policy":"all"}}
        node_acceptance=copy.deepcopy(acceptance); node_acceptance["witness"]["id"]="node-witness"
        node={"id":"make","depends_on":[],"reads":["request"],"produces":["result"],"writes":["work/result.json"],"resources":[{"kind":"filesystem","scope":"work/result.json","mode":"write","exclusive":True}],"effects":[{"kind":"filesystem","scope":"work/result.json","external_boundary":False,"readback":"not-applicable","on_invalidation":"recompute"}],"implementation":impl("cell", "application/vnd.aiko.cell+json;version=0"),"determinism":"required","grounding":{"sources":[impl("source")]},"acceptance":node_acceptance}
        package={"metadata":{"name":"self-test","version":"1.0.0","description":"self test"},"membrane":{"inputs":{"request":{"schema":impl("schema")}},"outputs":{"result":{"schema":impl("schema")}},"authority":{"filesystem":["work"],"network":[],"process":[],"secrets":[]}},"north_star":copy.deepcopy(acceptance),"nodes":[node],"edges":[{"from":{"node":"$input","port":"request"},"to":{"node":"make","port":"request"}},{"from":{"node":"make","port":"result"},"to":{"node":"$output","port":"result"}}],"recursion":{"max_depth":0,"max_children_per_node":0,"max_total_nodes":1,"max_wall_time_ms":20,"max_tool_calls":2,"on_exhaustion":"refuse"},"provenance":{"authored_by":"self-test","source_digests":[impl("source")],"generator":impl("generator")}}
        env={"api_version":API_VERSION,"kind":"GraphHarness","package":package,"registry":{"media_type":MEDIA_TYPE,"name":"self-test","version":"1.0.0","description":"self test","schema":API_VERSION,"projections":{}}}
        c=Compiler(root); one=c.build(env); two=c.build(env)
        def reverse_objects(v):
            if isinstance(v,dict): return {k:reverse_objects(v[k]) for k in reversed(list(v))}
            if isinstance(v,list): return [reverse_objects(x) for x in v]
            return v
        reordered=c.build(reverse_objects(env))
        assert canonical_json(one)==canonical_json(two)==canonical_json(reordered); c.inspect(one)
        assert one["admission"]["state"]=="prepared" and not _summary(one)["admitted"]
        # Declaring a witness that can only exit 99 cannot turn build into a
        # behavioral claim: compilation remains prepared and executes nothing.
        exit99=copy.deepcopy(env); exit99["package"]["north_star"]["witness"]["expected"]["exit_codes"]=[99]
        assert c.build(exit99)["admission"]["state"]=="prepared"
        # Arbitrary pinned bytes cannot masquerade as a skill declaration.
        (root/"fake-skill").write_text("not a skill; no frontmatter or acceptance\n")
        fake=copy.deepcopy(env); fake_digest=hashlib.sha256((root/"fake-skill").read_bytes()).hexdigest()
        fake["package"]["nodes"][0]["grounding"]={"skills":[{"name":"graph-engineering","declaration":{"ref":"fake-skill","digest":{"algorithm":"sha256","value":fake_digest}}}]}
        try: c.build(fake)
        except Refusal: pass
        else: raise AssertionError("arbitrary bytes were accepted as SKILL.md")
        verdicts=[{"witness_id":"node-witness","judge":impl("judge"),"verdict_ref":"contract:verdict/node"},
                  {"witness_id":"test-witness","judge":impl("judge"),"verdict_ref":"contract:verdict/root"}]
        private_key, verifier_key = root / "contract-private.pem", root / "contract-public.pem"
        attacker_private, attacker_public = root / "attacker-private.pem", root / "attacker-public.pem"
        for private, public in ((private_key, verifier_key), (attacker_private, attacker_public)):
            if not _openssl(["genpkey", "-algorithm", "ED25519", "-out", str(private)]):
                raise AssertionError("OpenSSL could not generate self-test Ed25519 key")
            if not _openssl(["pkey", "-in", str(private), "-pubout", "-out", str(public)]):
                raise AssertionError("OpenSSL could not derive self-test Ed25519 public key")
            os.chmod(private, 0o600); os.chmod(public, 0o600)
        try: _verifier_material(private_key)
        except Refusal: pass
        else: raise AssertionError("private Ed25519 PEM was accepted as verifier material")

        def sign(statement:dict[str,Any], private:Path) -> None:
            message, signature = root / "signing-input.json", root / "signature.bin"
            message.unlink(missing_ok=True); signature.unlink(missing_ok=True)
            _write_0600(message, _attestation_statement(statement))
            if not _openssl(["pkeyutl", "-sign", "-rawin", "-inkey", str(private),
                             "-in", str(message), "-out", str(signature)]):
                raise AssertionError("OpenSSL could not sign self-test attestation")
            statement["authentication"]["value"] = signature.read_bytes().hex()

        verifier_key_id=_verifier_material(verifier_key)[1]
        att={"api_version":"graph-harness-attestation/v1","kind":"GraphHarnessAdmissionAttestation","owner":"contract",
             "subject_digest":copy.deepcopy(one["admission"]["subject_digest"]),"transitive_digest":copy.deepcopy(one["admission"]["transitive_digest"]),
             "verdicts":verdicts,"admitted_by":impl("admitter"),"admitted_at":"2026-01-01T00:00:00Z",
             "evidence_refs":["contract:verdict/node","contract:verdict/root"],"ledger_ref":"contract:ledger/admission-1",
             "authentication":{"algorithm":AUTH_ALGORITHM,"key_id":verifier_key_id,"value":"0"*128}}
        sign(att, private_key)
        admitted=c.admit(one,att,verifier_key); assert admitted["admission"]["state"]=="admitted"
        verified=Compiler(root,verifier_key); verified.inspect(admitted)
        tampered=copy.deepcopy(admitted); tampered["admission"]["evidence_refs"].append("attacker:self-assertion")
        try: verified.inspect(tampered)
        except Refusal: pass
        else: raise AssertionError("tampered admitted metadata was accepted")
        forged=copy.deepcopy(att); forged["subject_digest"]["value"]="f"*64
        incomplete=copy.deepcopy(att); incomplete["verdicts"]=incomplete["verdicts"][:1]
        mismatched=copy.deepcopy(att); mismatched["verdicts"][0]["judge"]=impl("generator")
        absent_auth=copy.deepcopy(att); absent_auth.pop("authentication")
        wrong_key_id=copy.deepcopy(att); wrong_key_id["authentication"]["key_id"]="sha256:"+"f"*64
        wrong_signature=copy.deepcopy(att); wrong_signature["authentication"]["value"]="f"*128
        attacker_signed=copy.deepcopy(att); sign(attacker_signed, attacker_private)
        invalid_timestamp=copy.deepcopy(att); invalid_timestamp["admitted_at"]="2026-01-01 00:00:00Z"
        fabricated_refs=copy.deepcopy(att)
        fabricated_refs["ledger_ref"]="contract:ledger/does-not-exist"
        fabricated_refs["evidence_refs"].append("contract:evidence/does-not-exist")
        for label,bad_att,key in [
            ("forged",forged,verifier_key),("incomplete",incomplete,verifier_key),
            ("mismatched",mismatched,verifier_key),("absent authentication",absent_auth,verifier_key),
            ("wrong key id",wrong_key_id,verifier_key),("wrong signature",wrong_signature,verifier_key),
            ("fabricated references",fabricated_refs,verifier_key),("caller-chosen private key",attacker_signed,verifier_key),
            ("caller-chosen public key",att,attacker_public),("invalid RFC3339 separator",invalid_timestamp,verifier_key)]:
            try: c.admit(one,bad_att,key)
            except Refusal: pass
            else: raise AssertionError(f"{label} attestation was accepted")


        # A referenced byte changing after admission is digest drift, even when
        # the envelope itself is untouched.
        original=materials["cell"]; (root/"cell").write_bytes(original+b"drift")
        try: c.inspect(one)
        except Refusal: pass
        else: raise AssertionError("digest drift was admitted")
        (root/"cell").write_bytes(original)
        cases=[]
        bad=copy.deepcopy(one); bad["package"]["edges"][0]["from"]["port"]="missing-port"; cases.append(bad)
        bad=copy.deepcopy(one); bad["package"]["nodes"][0]["depends_on"]=["make"]; cases.append(bad)
        bad=copy.deepcopy(one); bad["package"]["nodes"][0]["grounding"]={}; cases.append(bad)
        bad=copy.deepcopy(one); bad["package"]["nodes"][0]["implementation"]["digest"]["value"]="0"*64; cases.append(bad)
        bad=copy.deepcopy(one); bad["package"]["nodes"][0]["acceptance"]["judge"]["implementation"]=copy.deepcopy(bad["package"]["nodes"][0]["implementation"]); cases.append(bad)
        bad=copy.deepcopy(one); bad["package"]["recursion"]["max_tool_calls"]=1; cases.append(bad)
        bad=copy.deepcopy(one); bad["package"]["nodes"][0]["writes"]=["../escape"]; cases.append(bad)
        bad=copy.deepcopy(one); bad["admission"]["transitive_digest"]["value"]="f"*64; cases.append(bad)
        for i,bad in enumerate(cases):
            try: c.inspect(bad)
            except Refusal: pass
            else: raise AssertionError(f"refusal case {i} was admitted")
    print("graph_harness self-test: PASS")

def main(argv:list[str]|None=None)->int:
    parser=argparse.ArgumentParser(description="Build, externally admit, or inspect a GraphHarness v1 package (never executes witnesses).")
    parser.add_argument("--self-test",action="store_true",help="run substantive deterministic/refusal tests")
    sub=parser.add_subparsers(dest="command")
    b=sub.add_parser("build",help="validate a source and emit an inert prepared package")
    b.add_argument("input"); b.add_argument("--out",dest="out_dir",help="atomically emit envelope.json, walk.json, manifest.json, and SKILL.md")
    b.add_argument("-o","--output",help="legacy single-envelope output path")
    b.add_argument("--root",help="trusted local reference root (default: input directory)")
    b.add_argument("--doctor",help="aiko-doctor executable (default: repository zig-out/bin/aiko-doctor)")
    a=sub.add_parser("admit",help="apply a complete external Contract-owned attestation to a prepared envelope")
    a.add_argument("input"); a.add_argument("--attestation",required=True); a.add_argument("-o","--output",required=True)
    a.add_argument("--root",help="trusted local reference root (default: prepared envelope directory)")
    i=sub.add_parser("inspect",help="verify a prepared or admitted envelope and its material closure")
    i.add_argument("input"); i.add_argument("--root",help="trusted local reference root (default: envelope directory)")
    i.add_argument("--json",action="store_true",help="emit a compact machine-readable summary")
    args=parser.parse_args(argv)
    try:
        if args.self_test:
            if args.command: parser.error("--self-test cannot be combined with a command")
            _self_test(); return 0
        if not args.command: parser.error("a command is required")
        if args.command=="build":
            if args.out_dir and args.output: parser.error("--out and --output are mutually exclusive")
            if not args.out_dir and not args.output: parser.error("build requires --out DIR or --output FILE")
            return _build_command(args)
        if args.command=="admit": return _admit_command(args)
        return _inspect_command(args)
    except Refusal as e:
        print(f"graph_harness: refused: {e}",file=sys.stderr); return 2
    except (AssertionError,KeyError,TypeError) as e:
        print(f"graph_harness: refused: malformed declaration: {e}",file=sys.stderr); return 2

if __name__=="__main__": raise SystemExit(main())
