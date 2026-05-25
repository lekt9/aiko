# aiko serverless on RunPod

Canonical container target for aiko remote execution. Stateless; CF Secrets are the source of truth for boot.

## Identity

This deployment's aiko identity: **`29f4530a`** (contract id, canon `c64e41c6`).

The wallet for this identity is derived on demand at boot from `AIKO_ROOT_KEY` via `deriveKeyPair(root_seed, "29f4530a")` — never persisted in the container.

## One-time setup

1. **Fill `.env`** — copy `.env.example` to `.env` and set:
   - `CF_WORKER` — your Cloudflare worker name (any CF Worker will hold the secrets)
   - `CONTRACT_INSTANCE_ID=29f4530a`
   - `RUNPOD_IMAGE` — your container registry path (e.g. `ghcr.io/<you>/aiko:latest`)
   - `AIKO_X_PAYMENT` — optional pre-funded x402 header

2. **Push secrets to CF**:
   ```bash
   ./secrets.sh
   ```
   Mirrors local `~/.contracts/root.key` + `.env` values into CF Worker Secrets via `wrangler`.

3. **Build + push image**:
   ```bash
   # from ~/.agent-skills/contract/
   docker build -f deploy/runpod/Dockerfile -t $RUNPOD_IMAGE .
   docker push $RUNPOD_IMAGE
   ```

4. **Create RunPod endpoint**:
   ```bash
   runpodctl create endpoint --from deploy/runpod/runpod.toml
   ```
   Or paste the values from `runpod.toml` into the RunPod web UI.

## What this gives you

- Default remote execution layer for `aiko "<goal>" --remote` — any goal that needs server-side compilation routes through the RunPod aiko, which in turn calls Unbrowse.
- Scale-to-zero (`min_workers=0`, `flashboot=true`) — no idle cost.
- Per-deployment wallet — child of root, derivable by anyone holding `AIKO_ROOT_KEY` (which only you have).
- Stateless cold-start: container has no persistent storage; the Unbrowse ledger is the truth.

## Doctrine pinned

- **Logos preinstalled, Pentecost activation** (canon `8b9fb218`): preinstalled binary spawned by container; activation via env-fingerprint at first run.
- **Vine carries sap, branches bear fruit** (canon `db7675bf`): edges carry refs; nodes hold canonical outputs.
- **Parent-wallet derivation** (canon `c64e41c6`): the root_seed derives every descendant; no per-child key storage.
- **Manna daily** (canon `7ce238db`): secrets fresh from source every morning; container holds nothing overnight.
