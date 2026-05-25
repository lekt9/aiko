### Aiko serverless image — R2 prebuilt binary variant.
###
### Instead of building zig in the container (~150s + 700MB ziglang image),
### this variant pulls the prebuilt signed aiko binary from Cloudflare R2.
### Smaller, faster, but requires you to upload the binary first via:
###   wrangler r2 object put aiko-bin/aiko-linux-x86_64 \
###       --file ./zig-out/bin/aiko --remote
###   wrangler r2 object put aiko-bin/aiko-linux-x86_64.sig \
###       --file ./zig-out/bin/aiko.sig --remote
###
### Build args:
###   AIKO_R2_URL     R2 public URL prefix (e.g. https://aiko-bin.r2.example.dev)
###   AIKO_BIN_SHA    expected sha256 of the binary; refuse on mismatch
###   AIKO_VERSION    binary version tag in the R2 bucket (default: latest)
###
### Doctrine: this IS the Pentecost-fallback path — a cold-start host that
### doesn't have aiko preinstalled pulls it from R2 on first contact.

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl python3 python3-pip git unzip bash && \
    rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash && \
    install -m 755 /root/.bun/bin/bun /usr/local/bin/bun
RUN curl -fsSL https://raw.githubusercontent.com/justrach/nanobrew/main/install.sh | bash -s -- /usr/local || true

ARG AIKO_R2_URL
ARG AIKO_BIN_SHA
ARG AIKO_VERSION=latest

RUN test -n "$AIKO_R2_URL" || (echo "AIKO_R2_URL build arg required" && exit 1)

RUN curl -fsSL "${AIKO_R2_URL}/aiko-linux-x86_64-${AIKO_VERSION}" -o /usr/local/bin/aiko && \
    curl -fsSL "${AIKO_R2_URL}/aiko-linux-x86_64-${AIKO_VERSION}.sig" -o /usr/local/bin/aiko.sig && \
    chmod 755 /usr/local/bin/aiko && \
    if [ -n "$AIKO_BIN_SHA" ]; then \
        echo "$AIKO_BIN_SHA  /usr/local/bin/aiko" | sha256sum -c -; \
    fi

RUN useradd -m -u 10001 -s /bin/bash aiko
WORKDIR /opt/aiko
COPY deploy/runpod/entrypoint.sh /opt/aiko/entrypoint.sh
COPY deploy/runpod/http_shim.py /opt/aiko/http_shim.py
RUN chmod 755 /opt/aiko/entrypoint.sh /opt/aiko/http_shim.py
USER aiko
EXPOSE 8080
ENV HOME=/home/aiko \
    PORT=8080 \
    UNBROWSE_BASE=https://beta-api.unbrowse.ai \
    CONTRACT_BACKFILL_BUDGET=64 \
    AIKO_BIN=/usr/local/bin/aiko
ENTRYPOINT ["/opt/aiko/entrypoint.sh"]
