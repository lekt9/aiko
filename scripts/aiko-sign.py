#!/usr/bin/env python3
"""aiko-sign.py — self-custody Solana signer for `contract aiko fund --sign`.

Stdio interface (env-driven; no positional args):
  AK_SIGN_FROM_KEYPAIR — path to 64-byte Solana keypair JSON (chmod 600)
  AK_SIGN_FROM_PUBKEY  — expected pubkey (sanity check vs keypair file)
  AK_SIGN_TO_PUBKEY    — recipient pubkey (base58)
  AK_SIGN_AMOUNT       — amount in SOL (e.g. "0.05")
  AK_SIGN_RPC          — Solana RPC endpoint (e.g. https://api.devnet.solana.com)
  AK_SIGN_NOTE         — optional memo (stored in ledger row, not on-chain)
  AK_SIGN_AGENT        — Σ1 agent id (for attribution row)
  AK_SIGN_TARGET_SHORT — short_id of child aiko (for ledger row id)

Exit: 0 on success (with signature printed); 1 on any failure (with stderr).

Why a separate script: solders has binary wheels that don't load on every
python build (notably macOS python3.14 in some homebrew configs). The
main `contract` CLI shells out here via the first python that imports
solders cleanly. This isolates the binary-wheel dependency from the
substrate's core path.

Honest gap: privy + lobster custody paths are NOT handled here — they live
behind DEFERRED contracts e8cedf82 + 08197b29. This script is only for
custody='self'.
"""
from __future__ import annotations
import base64, datetime, json, os, sys, urllib.error, urllib.request
from pathlib import Path

# Ledger _append via the substrate's library (same source of truth)
_CLI_LIB = Path(__file__).parent / "lib"
sys.path.insert(0, str(_CLI_LIB))
try:
    from contract_core import _append
except ImportError as e:
    print(f"  ERROR: contract_core not importable from {_CLI_LIB}: {e}", file=sys.stderr)
    sys.exit(1)

try:
    from solders.keypair import Keypair
    from solders.pubkey import Pubkey
    from solders.system_program import transfer, TransferParams
    from solders.transaction import Transaction
    from solders.hash import Hash
    from solders.message import Message
except ImportError as e:
    print(f"  ERROR: solders import failed under {sys.executable}: {e}", file=sys.stderr)
    sys.exit(1)


def _need_env(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        print(f"  ERROR: env {key} required", file=sys.stderr)
        sys.exit(2)
    return v


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _rpc(rpc: str, method: str, params: list, timeout: int = 15) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(rpc, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    keypair_path = _need_env("AK_SIGN_FROM_KEYPAIR")
    expected_pub = _need_env("AK_SIGN_FROM_PUBKEY")
    to_pub_str = _need_env("AK_SIGN_TO_PUBKEY")
    amount = _need_env("AK_SIGN_AMOUNT")
    rpc = _need_env("AK_SIGN_RPC")
    note = os.environ.get("AK_SIGN_NOTE", "")
    agent = os.environ.get("AK_SIGN_AGENT", "anonymous")
    target_short = os.environ.get("AK_SIGN_TARGET_SHORT", "?")

    # Load + validate keypair
    try:
        with open(keypair_path) as f:
            keypair_bytes = bytes(json.load(f))
        if len(keypair_bytes) != 64:
            print(f"  ERROR: keypair file must be 64 bytes (got {len(keypair_bytes)})", file=sys.stderr)
            return 1
        signer = Keypair.from_bytes(keypair_bytes)
    except Exception as e:
        print(f"  ERROR: could not load keypair from {keypair_path}: {e}", file=sys.stderr)
        return 1
    if str(signer.pubkey()) != expected_pub:
        print(f"  ERROR: keypair pubkey mismatch — file={signer.pubkey()} row={expected_pub}", file=sys.stderr)
        return 1

    to_pub = Pubkey.from_string(to_pub_str)
    lamports = int(float(amount) * 1_000_000_000)

    # Recent blockhash
    try:
        bh = _rpc(rpc, "getLatestBlockhash", [])
        if "error" in bh:
            print(f"  ERROR: RPC error from {rpc}: {bh['error']}", file=sys.stderr); return 1
        blockhash_str = bh["result"]["value"]["blockhash"]
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  ERROR: RPC unreachable at {rpc}: {e}", file=sys.stderr); return 1

    # Build + sign tx
    ix = transfer(TransferParams(from_pubkey=signer.pubkey(), to_pubkey=to_pub, lamports=lamports))
    bh_hash = Hash.from_string(blockhash_str)
    msg = Message.new_with_blockhash([ix], signer.pubkey(), bh_hash)
    tx = Transaction([signer], msg, bh_hash)
    tx_b64 = base64.b64encode(bytes(tx)).decode()

    # Submit
    try:
        sub_data = _rpc(rpc, "sendTransaction", [tx_b64, {"encoding": "base64", "skipPreflight": False}], timeout=30)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  ERROR: RPC submit failed: {e}", file=sys.stderr); return 1

    if "error" in sub_data:
        err = sub_data["error"]
        _append({
            "event": "aiko_fund_failed",
            "id": f"aiko-fund-fail-{target_short}-{int(datetime.datetime.now().timestamp())}",
            "from_pubkey": expected_pub, "to_pubkey": to_pub_str,
            "amount_sol": amount, "rpc": rpc,
            "error": str(err), "ts": _now_iso(),
        })
        print(f"\n  === SIGN FAILED ===", file=sys.stderr)
        print(f"    rpc:        {rpc}", file=sys.stderr)
        print(f"    error:      {err.get('message', err) if isinstance(err, dict) else err}", file=sys.stderr)
        if isinstance(err, dict) and isinstance(err.get("data"), dict) and "logs" in err["data"]:
            for line in err["data"]["logs"][:5]:
                print(f"    log:        {line}", file=sys.stderr)
        print(f"    hint:       most common cause = from-account has 0 SOL. Fund it first via faucet (devnet: `solana airdrop 1 {expected_pub} --url {rpc}`)", file=sys.stderr)
        print(f"    audit row:  aiko_fund_failed appended to ledger", file=sys.stderr)
        return 1

    signature = sub_data["result"]
    _append({
        "event": "aiko_fund_signed",
        "id": f"aiko-fund-signed-{target_short}-{int(datetime.datetime.now().timestamp())}",
        "from_pubkey": expected_pub, "to_pubkey": to_pub_str,
        "amount_sol": amount, "lamports": lamports,
        "signature": signature, "rpc": rpc, "note": note,
        "signed_by_agent": agent, "ts": _now_iso(),
    })
    cluster = "devnet" if "devnet" in rpc else ("testnet" if "testnet" in rpc else "mainnet-beta")
    print()
    print(f"  === SIGNED + SUBMITTED ===")
    print(f"  signature:    {signature}")
    print(f"  amount:       {amount} SOL ({lamports} lamports)")
    print(f"  rpc:          {rpc}")
    print(f"  explorer:     https://explorer.solana.com/tx/{signature}?cluster={cluster}")
    print(f"  audit row:    aiko_fund_signed appended to ledger")
    print(f"  result:       PASS (self-custody signing succeeded)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
