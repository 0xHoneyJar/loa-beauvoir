# =============================================================================
# Loa Cloud Stack - Container Image
# =============================================================================
# Layers:
#   L0: Loa System Zone (fetched from GitHub at build time)
#   L1: Devcontainer runtime patterns (tools, sandboxing - NOT the image)
#   L2: Moltworker infrastructure (R2, channels, Workers proxy)
#   L3: Loa identity layer (this Dockerfile + start-loa.sh)
#
# Identity Guarantee: Moltworker's AGENTS.md is NEVER loaded.
# The CLAUDE_CONFIG_DIR points exclusively to Loa's System Zone.
#
# Build Context: This Dockerfile is built with deploy/ as the context.
# Files from the repo root are fetched via git clone during build.
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.7.0

# -----------------------------------------------------------------------------
# Stage 1: System Dependencies
# -----------------------------------------------------------------------------

# Install Node.js 22 (required by OpenClaw/Clawdbot)
# The base image has Node 20, we need Node 22 for compatibility
ENV NODE_VERSION=22.13.1
RUN apt-get update && apt-get install -y --no-install-recommends \
    xz-utils \
    ca-certificates \
    rsync \
    # Additional tools from devcontainer pattern
    bubblewrap \
    socat \
    ripgrep \
    jq \
    git \
    tmux \
    zsh \
    curl \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

# Install pnpm globally
RUN npm install -g pnpm@10

# -----------------------------------------------------------------------------
# Stage 2: OpenClaw Gateway
# -----------------------------------------------------------------------------

# Install OpenClaw (formerly clawdbot) - pinned version for reproducibility
ARG OPENCLAW_VERSION=2026.2.1
RUN npm install -g openclaw@${OPENCLAW_VERSION} \
    && openclaw --version

# Create directory structure
# Note: We use /workspace for Loa (not /root/clawd like moltbot)
RUN mkdir -p \
    /workspace \
    /workspace/.claude \
    /workspace/grimoires/loa \
    /workspace/deploy/loa-identity \
    /data/moltbot \
    /data/wal \
    /root/.openclaw

# -----------------------------------------------------------------------------
# Stage 3: Loa Identity Layer
# -----------------------------------------------------------------------------

# Fetch Loa framework and identity files from GitHub
# This ensures we always get the latest from the repo
ARG LOA_REPO=https://github.com/0xHoneyJar/loa-beauvoir.git
ARG LOA_BRANCH=main
RUN git clone --depth 1 --branch ${LOA_BRANCH} ${LOA_REPO} /tmp/loa-repo \
    && cp -r /tmp/loa-repo/.claude/* /workspace/.claude/ \
    && cp -r /tmp/loa-repo/grimoires/* /workspace/grimoires/ \
    && cp /tmp/loa-repo/.loa-version.json /workspace/ 2>/dev/null || echo '{"framework_version":"1.16.0"}' > /workspace/.loa-version.json \
    && rm -rf /tmp/loa-repo

# Copy deployment configuration from build context (deploy/ directory)
COPY start-loa.sh /usr/local/bin/start-loa.sh
COPY loa-identity/ /workspace/deploy/loa-identity/

RUN chmod +x /usr/local/bin/start-loa.sh

# -----------------------------------------------------------------------------
# Runtime Configuration
# -----------------------------------------------------------------------------

WORKDIR /workspace

# Expose the gateway port
EXPOSE 18789

# Environment - critical for Loa identity isolation
ENV CLAUDE_CONFIG_DIR=/workspace/.claude
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Entrypoint - Loa startup, NOT moltbot's start-moltbot.sh
ENTRYPOINT ["/usr/local/bin/start-loa.sh"]
