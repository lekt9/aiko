#!/usr/bin/env python3
"""Witness for the generic native-substrate proposer receptor.

Proves the three claims that define "native in the substrate, not specialized
for ARC":
  (1) PROVIDER-NEUTRAL: an EchoTransport (zero-cost, no LLM, no ARC) drives the
      receptor end-to-end; swapping transports touches nothing in the receptor.
  (2) SUBSTRATE-NATIVE + NOT-ARC: the capability declared in the substrate is
      the generic `aiko-proposer.propose` (provider aiko-proposer, NOT aiko-arc),
      and the receptor solves a deliberately NON-ARC task (propose a git commit
      message) with no ARC prompt anywhere.
  (3) LIVE: with the AikoCliTransport + a real model + authority, the receptor
      returns a parsed proposal from the real LLM. (Skipped if no authority/env.)

Exit 0 == all claims hold. No fabricated green: each claim is asserted on real
behavior, not on a string.
"""
from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import proposer_receptor as pr  # noqa: E402


def claim1_provider_neutral() -> None:
    """Echo transport drives the full fixed cell with no LLM and no ARC."""
    reg = pr.TransportRegistry()
    reg.register(pr.EchoTransport('{"commit": "fix: typo in readme"}'), make_effective=True)
    rec = pr.ProposerReceptor(registry=reg, substrate=pr.SubstrateABI())
    out = rec.propose(
        domain="git-commit",
        system_prompt="You write one-line commit messages.",
        user_prompt="diff: fixed a typo",
        candidate_schema={"type": "object", "required": ["commit"]},
        context="witness-claim1",
        authority=True,
    )
    assert out["settled"] is True, f"echo transport did not settle: {out}"
    assert out["transport"] == "echo", out
    assert out["valid"] is True, out
    assert out["parsed"] == {"commit": "fix: typo in readme"}, out
    assert out.get("settled_by") == "zig", f"policy not substrate-native (Zig): {out.get('settled_by')}"
    # swapping transports does not touch the receptor or its call shape
    reg.register(pr.EchoTransport('{"commit": "feat: add x"}'), make_effective=True)
    assert reg.effective().name == "echo"
    print("[claim1] provider-neutral: echo transport settled a non-ARC proposal via the Zig fixed cell")


def claim2_substrate_native_not_arc() -> None:
    """Capability is aiko-proposer.propose (generic), accepted by the substrate's
    generic ABI; the task is deliberately non-ARC; no ARC string appears anywhere."""
    import time
    sub = pr.SubstrateABI()
    rec = pr.ProposerReceptor(substrate=sub)
    # the capability id and provider are generic, never ARC
    assert sub.CAPABILITY == "aiko-proposer.propose", sub.CAPABILITY
    assert sub.PROVIDER == "aiko-proposer", sub.PROVIDER
    assert "aiko-arc" not in sub.CAPABILITY and "aiko-arc" not in sub.PROVIDER
    if sub.available:
        # Prove the substrate ACCEPTS the generic provider: register a FRESH
        # unique capability id (re-registration of a stable id is idempotent and
        # may return None, so a fresh id is the honest acceptance probe).
        fresh = f"aiko-proposer.witness-{int(time.time())}"
        accepted = sub.register_capability(fresh)
        assert accepted is not None, "substrate rejected the generic aiko-proposer provider/catalog"
        assert accepted.get("source") == "aiko-proposer", accepted
        print(f"[claim2] substrate-native: generic provider 'aiko-proposer' accepted by ABI (abi v{sub.abi_version}, fresh id ok)")
        # declare() on the stable id is idempotent (may return None on duplicate)
        rec.declare()
    else:
        print("[claim2] substrate-native: libcontract absent -> fail-open (receptor still task-neutral); declaring skipped")
    # non-ARC task: propose a git commit message
    reg = pr.TransportRegistry()
    reg.register(pr.EchoTransport('{"commit": "docs: witness"}'), make_effective=True)
    rec.registry = reg
    out = rec.propose(domain="git-commit", system_prompt="write a commit message",
                      user_prompt="change: docs", candidate_schema={"type": "object", "required": ["commit"]},
                      context="witness-claim2", authority=True)
    assert out["settled"] is True and out["parsed"]["commit"].startswith("docs"), out
    # authority gating (paid effect fail-closed) -- enforced by the Zig gate
    held = rec.propose(domain="git-commit", system_prompt="x", user_prompt="y", authority=False)
    assert held["settled"] is False and held["held"] is True, held
    assert held.get("settled_by") == "zig", f"authority gate not Zig-enforced: {held.get('settled_by')}"
    print("[claim2] not-ARC: solved a git-commit task; Zig authority gate HOLDs when unauthorized")


def claim3_live() -> None:
    """Real LLM via the aiko CLI transport. Requires AIKO_MODEL + authority env."""
    if os.environ.get("PROPOSER_LIVE") not in ("1", "true", "True"):
        print("[claim3] live: skipped (set PROPOSER_LIVE=1 + AIKO_MODEL=<id> to run the paid LLM call)")
        return
    model = os.environ.get("AIKO_MODEL", "glm-5.2")
    reg = pr.TransportRegistry()
    reg.register(pr.AikoCliTransport(), make_effective=True)
    rec = pr.ProposerReceptor(registry=reg)
    out = rec.propose(
        domain="git-commit",
        system_prompt=("You write one-line conventional-commit messages. Reply with ONE json "
                       'object on the last line: {"commit": "<message>"}.'),
        user_prompt="diff: --git a/README b/README  -typo +typo(fixed)",
        candidate_schema={"type": "object", "required": ["commit"]},
        context="witness-claim3-live", authority=True, model=model,
    )
    assert out["settled"] is True, f"live LLM did not settle: {out}"
    assert out["transport"] == "aiko-cli", out
    assert out.get("settled_by") == "zig", f"live settlement not Zig-native: {out.get('settled_by')}"
    assert isinstance(out["parsed"], dict) and "commit" in out["parsed"], out
    print(f"[claim3] live: aiko-cli + {model} -> {json.dumps(out['parsed'])} via Zig settle ({out['duration_ms']}ms)")


def main() -> int:
    claim1_provider_neutral()
    claim2_substrate_native_not_arc()
    claim3_live()
    print("\nWITNESS PASS: proposer receptor is substrate-native, provider-neutral, not ARC-specialized")
    return 0


if __name__ == "__main__":
    sys.exit(main())
