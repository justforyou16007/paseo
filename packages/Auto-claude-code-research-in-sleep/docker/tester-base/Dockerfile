# syntax=docker/dockerfile:1

# The ARIS tester base image: Ubuntu 22.04 with the Paseo daemon built from this
# checkout, the claude CLI, a docker client for the host socket, and this
# commit's tester manual. Build from the repository root:
#
#   docker build --platform linux/amd64 \
#     -f packages/Auto-claude-code-research-in-sleep/docker/tester-base/Dockerfile \
#     -t aris-tester-base:latest .

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS node

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

# Packing the server bundles the web UI, which exceeds node's default heap.
ENV ONNXRUNTIME_NODE_INSTALL=skip \
    NODE_OPTIONS=--max-old-space-size=6144

WORKDIR /tmp/paseo-src
COPY . .

RUN set -eux; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/highlight --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/relay --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/protocol --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/client --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/plugin --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/server --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/cli --pack-destination /tmp/paseo-packs

FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

ENV HOME=/home/paseo \
    PASEO_HOME=/home/paseo/.paseo \
    PASEO_LISTEN=0.0.0.0:6767 \
    PASEO_WEB_UI_ENABLED=true \
    PASEO_LOG_FORMAT=json \
    PASEO_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/paseo/.claude \
    CODEX_HOME=/home/paseo/.codex \
    XDG_CONFIG_HOME=/home/paseo/.config \
    XDG_DATA_HOME=/home/paseo/.local/share \
    XDG_STATE_HOME=/home/paseo/.local/state \
    XDG_CACHE_HOME=/home/paseo/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

# Ubuntu 22.04 ships Node 12, so node and npm come from the official image.
COPY --from=node /usr/local/ /usr/local/

# Only the docker client: the tester drives the host's daemon through the
# mounted socket. buildx is there because the tester builds its own images.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      openssl \
      procps \
      tini \
      xz-utils; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu jammy stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin; \
    rm -rf /var/lib/apt/lists/*

COPY --from=source-pack /tmp/paseo-packs /tmp/paseo-packs
RUN set -eux; \
    npm install -g @anthropic-ai/claude-code /tmp/paseo-packs/*.tgz; \
    rm -rf /tmp/paseo-packs; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@getpaseo/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/paseo-server-entry; \
    node --check "$server_entry"

RUN set -eux; \
    groupadd --gid 1000 paseo; \
    useradd --uid 1000 --gid paseo --create-home --home-dir /home/paseo --shell /bin/bash paseo; \
    mkdir -p \
      /workspace \
      "$PASEO_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R paseo:paseo /home/paseo /workspace

COPY docker/base/rootfs/ /
RUN chmod +x /usr/local/bin/paseo-docker-entrypoint

# deploy compares this file's sha256 with the ARIS version's template. The
# directory is made first: COPY --chmod would give a directory it creates mode
# 644, which paseo could not enter.
RUN install -d -m 755 /opt/aris
COPY --chmod=644 packages/Auto-claude-code-research-in-sleep/templates/tester-agent-bundle/TESTER_AGENT.md /opt/aris/TESTER_AGENT.md

LABEL org.opencontainers.image.description="ARIS tester base image (Ubuntu 22.04, Paseo daemon, claude CLI, docker client)"

# The container runs as paseo from its first process; the entrypoint then never
# switches users, so groups added with --group-add survive.
USER paseo
WORKDIR /workspace

EXPOSE 6767
VOLUME ["/home/paseo"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const listen=process.env.PASEO_LISTEN||'0.0.0.0:6767'; const m=listen.match(/:(\\d+)$/); const port=m?Number(m[1]):6767; require('http').get({hostname:'127.0.0.1',port,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/paseo-docker-entrypoint"]
