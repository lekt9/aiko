### Aiko serverless image — RunPod default remote execution layer.
###
### Multi-stage:
###  1. builder uses ziglang/zig to compile aiko natively for Linux (no
###     cross-compile from host needed — the container IS the Linux env)
###  2. final stage is a thin debian:slim with the signed aiko binary +
###     entrypoint that boots from CF Secrets / RunPod env vars
###
### Required runtime env (sourced from RunPod template -> CF Secrets):
###   AIKO_ROOT_KEY        64-hex; the substrate's root signing seed
###                        (lineage_lib.loadOrInitRootKey reads this first)
###   UNBROWSE_BASE        defaults to https://beta-api.unbrowse.ai
###   CONTRACT_INSTANCE_ID 8-hex contract id used as this aiko's identity
###   AIKO_X_PAYMENT       optional x402 payment header for outgoing calls
###
### Pointer-not-payload: state lives in the canonical Unbrowse ledger,
### NOT inside the container. The container starts cold every invocation
### and reconstructs identity from AIKO_ROOT_KEY at boot.

FROM ziglang/zig:0.16.0 AS builder
WORKDIR /src
COPY libcontract /src/libcontract
COPY zig /src/zig
WORKDIR /src/zig
RUN zig build -Doptimize=ReleaseSafe \
    --cache-dir /tmp/zig-cache \
    --global-cache-dir /tmp/zig-gcache
RUN ls -la zig-out/bin && file zig-out/bin/aiko

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl python3 && \
    rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 -s /bin/bash aiko
WORKDIR /opt/aiko
COPY --from=builder /src/zig/zig-out/bin/aiko /usr/local/bin/aiko
COPY --from=builder /src/zig/zig-out/bin/contract-zig /usr/local/bin/contract
COPY deploy/runpod/entrypoint.sh /opt/aiko/entrypoint.sh
COPY deploy/runpod/http_shim.py /opt/aiko/http_shim.py
RUN chmod 755 /usr/local/bin/aiko /usr/local/bin/contract \
              /opt/aiko/entrypoint.sh /opt/aiko/http_shim.py
USER aiko
EXPOSE 8080
ENV HOME=/home/aiko \
    PORT=8080 \
    UNBROWSE_BASE=https://beta-api.unbrowse.ai \
    CONTRACT_BACKFILL_BUDGET=64 \
    AIKO_BIN=/usr/local/bin/aiko
# Two run modes:
#   SERVER (default): http_shim.py exposes OpenAI-compatible /v1/chat/completions
#   ONESHOT: entrypoint.sh handles a single RunPod serverless job from env+stdin
# Switch via AIKO_RUN_MODE=server|oneshot. Default = server.
ENTRYPOINT ["/opt/aiko/entrypoint.sh"]
