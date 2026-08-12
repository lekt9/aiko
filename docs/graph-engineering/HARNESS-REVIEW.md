Verdict: PASS

# Fifth cold final review: GraphHarness

> **Historical.** Dated review or transcript. Not current product documentation. What the tree is today: [../SOURCE-OF-TRUTH.md](../SOURCE-OF-TRUTH.md).

## Scope and severity

I reviewed the current compiler, registry, wrapper, schema, fixtures, documents,
and behavioral gates from scratch. Packages, attestations, registry bytes, paths,
and inherited request data were treated as hostile. The attacker may generate an
independent Ed25519 keypair and choose request/package/attestation bytes, but may
not alter the deployment/service-manager bootstrap environment.

Severity is **P0** catastrophic, **P1** merge-blocking trust/correctness
failure, and **P2** important contract hardening. No P0, P1, or P2 finding
remains.

## Verdict

PASS. The previous PKCS#8 verifier-custody finding is repaired, the complete
adversarial matrix is green, and the final isolated serial runs of both native
acceptance witnesses exited zero.

Earlier attempts made while other native builds and graph gates were active
failed or stalled. They were concurrency transients, not reproducible defects:
a final no-overlap run of `TMPDIR=/tmp bash tests/graph-engineering-gate.sh`
reported `graph-engineering gate: PASS`, followed serially by a zero exit from
`TMPDIR=/tmp zig build gate`. The final serial witnesses are the acceptance
result recorded here.

## Private-key-envelope and bootstrap review

The previous private-key custody defect is repaired in both loaders. Before any
OpenSSL parse, each loader requires exactly one `BEGIN PUBLIC KEY` /
`END PUBLIC KEY` SPKI envelope, anchored at both ends. OpenSSL is then invoked
as the fixed `/usr/bin/openssl`, with a minimal `LANG`/`LC_ALL` environment and
a ten-second timeout; the resulting DER must be the exact 44-byte Ed25519 SPKI
shape. Compiler temporary verifier material is mode 0600.

The exact four-operation matrix was rerun. Public Ed25519 SPKI succeeded for
`admit`, admitted `inspect`, `register`, and `find`. Each of these operations
refused all tested non-public or ambiguous inputs:

- ordinary unencrypted PKCS#8 `PRIVATE KEY` PEM;
- encrypted PKCS#8 `ENCRYPTED PRIVATE KEY` PEM;
- traditional/private-label variants (`ED25519 PRIVATE KEY`, `EC PRIVATE KEY`);
- public PEM followed by private PEM;
- private PEM followed by public PEM;
- two concatenated public PEM objects;
- a valid public PEM followed by non-PEM garbage.

The anchored envelope plus DER check also closes leading/trailing material,
label substitution, malformed base64, wrong algorithms, and a public label
containing private DER. No alternate OpenSSL or key-selector path was found.

`AIKO_CONTRACT_VERIFY_KEY` remains process bootstrap, not request isolation.
There is no public `--trust-root`, `--verifier-key`, or equivalent selector for
the admitted operations, and unknown selectors refuse. Missing, wrong,
relative, empty, oversized, malformed, and symlink bootstrap paths fail closed.
A caller able to choose the entire process environment can choose a verifier;
that caller is the deployment operator in this threat model. The MCP/service
boundary must continue to sanitize and pin that environment before serving
untrusted requests.

## Original adversarial matrix

| Probe | Fifth cold result |
|---|---|
| Public-only verifier, all four operations | PASS: public SPKI works; PKCS#8/private/encrypted/traditional/concatenated/malformed envelopes refuse. |
| No verifier override | PASS: no request-visible key selector; unknown selector flags refuse. |
| Attacker Ed25519 key and complete fabricated Contract refs | PASS: a complete statement with nonexistent ledger/verdict/evidence refs, signed only by the attacker, refuses under the pinned Contract public key. |
| Complete signed-field coverage | PASS: all 13 mutations refuse (API version, kind, owner, subject digest, transitive digest, verdicts, admitted-by, time, evidence, ledger ref, algorithm, key ID, signature). |
| RFC 3339 | PASS: a correctly re-signed timestamp using a space instead of uppercase `T` refuses in admit and register; parsing also validates the date and timezone. |
| Prepared/admitted separation | PASS: build emits only prepared state; direct publication of prepared/exit-99 material refuses; build invents no verdict or ledger state. |
| Admission and internal digests | PASS: hand-authored admitted envelopes, stale identities, forged evidence/verdict bindings, and invalid signatures refuse. |
| Admitted inspect authentication | PASS: genuine state authenticates; missing/wrong bootstrap, signed drift, material drift, and private-key bootstrap refuse. |
| Durable lookup authentication | PASS: missing/wrong/private bootstrap refuses; a coherent CAS-object plus ref rewrite carrying an invalid signature refuses on lookup authentication. |
| Projection closure | PASS: a `cell_v0` identity absent from the authenticated closure refuses registration and publishes no ref. |
| Skill and grounding | PASS: arbitrary prose, malformed/missing/duplicate frontmatter, identity drift, empty grounding, and unknown grounding refuse. |
| Paths and symlinks | PASS: missing material, root/resolved escape, unsupported URI, digest drift, registry redirection, versionless-ref symlink, and bootstrap symlink cases refuse. |
| JSON/JCS | PASS: duplicates, floats/non-finite values, unsafe integers, unpaired surrogates, normalization tricks, hash-seed changes, and source ordering refuse or canonicalize deterministically. |
| DAG/data/effects/bounds | PASS: invalid edges/cycles/bindings/scopes/topology, unsafe replay/read-back, recursion ceilings, budgets, and invalidation attacks refuse or surface as specified. |
| Judges/evidence | PASS: producer/self-judge reuse, incomplete/duplicate verdicts, judge drift, missing evidence, and forged attester material refuse. |
| Nonexecution | PASS: build, inspect, admit, register, and find do not execute exit-99 witness bytes. |
| Atomic directory/CAS | PASS: invalid and late-doctor failures leave no output/staging debris; CAS/ref publication is no-clobber, read back, and repeat-deduplicated. |

## Witnesses run

```text
PASS  python3 scripts/graph_harness.py --self-test
PASS  python3 scripts/graph_harness_registry.py --self-test
PASS  TMPDIR=/tmp bash tests/graph-harness-builder-gate.sh
PASS  public SPKI across admit / admitted inspect / register / find
PASS  8 hostile envelope classes refused across all four operations (32/32)
PASS  original 13/13 signed-field mutation matrix (inside builder gate)
PASS  attacker-key / coherent-CAS-invalid-signature / projection-closure / RFC3339 probes (inside builder gate)
PASS  git diff --check
PASS  TMPDIR=/tmp bash tests/graph-engineering-gate.sh (final isolated serial run)
PASS  TMPDIR=/tmp zig build gate (final isolated serial run)
```

There are zero actionable GraphHarness security, correctness, documentation, or
acceptance findings on the reviewed current tree.
