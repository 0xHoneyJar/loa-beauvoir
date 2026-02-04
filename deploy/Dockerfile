# =============================================================================
# Loa Cloud Stack - Container Image
# Build: 2026-02-04-v2 - Force fresh rollout to fix ImagePullError
# =============================================================================
# Layers:
#   L0: Loa System Zone (fetched from GitHub at build time)
#   L1: Devcontainer runtime patterns (tools, sandboxing - NOT the image)
#   L2: Moltworker infrastructure (R2, channels, Workers proxy)
#   L3: Loa identity layer (this Dockerfile + start-loa.sh)
#   L4: Loa optimizations (ck, beads_rust, memory stack, flatline)
#
# Identity Guarantee: Moltworker's AGENTS.md is NEVER loaded.
# The CLAUDE_CONFIG_DIR points exclusively to Loa's System Zone.
#
# Build Context: This Dockerfile is built with deploy/ as the context.
# Files from the repo root are fetched via git clone during build.
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.7.0

# Cache bust to force fresh rollout (change this value to trigger rebuild)
ARG CACHE_BUST=2026-02-04-v4-no-r2
RUN echo "Build timestamp: $CACHE_BUST"

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
    # Python for Memory Stack and Flatline Protocol
    python3 \
    python3-pip \
    python3-venv \
    # Build tools for Rust compilation
    build-essential \
    pkg-config \
    libssl-dev \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version \
    && python3 --version

# Install yq (YAML processor - required by Loa)
RUN curl -fsSL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && yq --version

# Install pnpm globally
RUN npm install -g pnpm@10

# -----------------------------------------------------------------------------
# Stage 1.5: Loa Optimizations (Rust + Python tools)
# DISABLED: These add ~10GB to the image and cause push timeouts.
# Re-enable when Cloudflare supports larger container images.
# -----------------------------------------------------------------------------

# NOTE: The following are disabled to keep image size under 6GB:
# - Rust toolchain + ck-search (~500MB compiled)
# - sentence-transformers + PyTorch + CUDA (~8GB)
# - patchright + Chromium (~170MB)
#
# To re-enable, uncomment the lines below:
#
# ENV RUSTUP_HOME=/usr/local/rustup \
#     CARGO_HOME=/usr/local/cargo \
#     PATH=/usr/local/cargo/bin:$PATH
# RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
#     && rustc --version \
#     && cargo --version
# RUN cargo install ck-search && ck --version || echo "ck-search installation skipped (optional)"
# RUN cargo install beads_rust && br --version || echo "beads_rust installation skipped (optional)"
# RUN pip3 install --no-cache-dir sentence-transformers \
#     && python3 -c "from sentence_transformers import SentenceTransformer; print('sentence-transformers OK')" \
#     || echo "sentence-transformers installation skipped (optional)"
# RUN pip3 install --no-cache-dir patchright \
#     && python3 -m patchright install chromium \
#     || echo "patchright installation skipped (optional)"

# -----------------------------------------------------------------------------
# Stage 2: OpenClaw Gateway
# -----------------------------------------------------------------------------

# Install clawdbot - same version as moltworker for compatibility
RUN npm install -g clawdbot@2026.1.24-3 \
    && clawdbot --version

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

# Make executable and create symlink for moltworker compatibility
RUN chmod +x /usr/local/bin/start-loa.sh \
    && ln -sf /usr/local/bin/start-loa.sh /usr/local/bin/start-moltbot.sh

# -----------------------------------------------------------------------------
# Runtime Configuration
# -----------------------------------------------------------------------------

WORKDIR /workspace

# Expose ports: 3000 for SDK health checks, 18789 for gateway
EXPOSE 3000 18789

# Environment - critical for Loa identity isolation
ENV CLAUDE_CONFIG_DIR=/workspace/.claude
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Build timestamp to force fresh builds when needed
ARG BUILD_TS=20260203-0920

# NO ENTRYPOINT - The base image handles SDK communication
# The Worker will call /usr/local/bin/start-moltbot.sh via startProcess()
# (which is symlinked to start-loa.sh)
