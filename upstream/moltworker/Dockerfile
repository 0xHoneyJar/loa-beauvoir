# =============================================================================
# Loa Cloud Stack - Container Image (via Moltworker)
# =============================================================================
# This Dockerfile combines moltworker infrastructure with Loa identity layer
# and all optional Loa optimizations for maximum capability.
#
# Layers:
#   L0: Cloudflare Sandbox base (SDK communication on port 3000)
#   L1: System dependencies (Node.js, Python, Rust)
#   L2: Loa optimizations (ck-search, beads_rust, memory stack, flatline)
#   L3: OpenClaw Gateway (clawdbot)
#   L4: Loa Identity (fetched from GitHub)
#
# Identity Guarantee: Moltworker's AGENTS.md is NEVER loaded.
# The CLAUDE_CONFIG_DIR points exclusively to Loa's System Zone.
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.7.0

# -----------------------------------------------------------------------------
# Stage 1: System Dependencies
# -----------------------------------------------------------------------------

ENV NODE_VERSION=22.13.1
RUN apt-get update && apt-get install -y --no-install-recommends \
    xz-utils \
    ca-certificates \
    rsync \
    # Tools required by Loa
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
# Stage 2: Loa Optimizations (Rust + Python tools)
# -----------------------------------------------------------------------------

# Install Rust toolchain for ck-search and beads_rust
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && rustc --version \
    && cargo --version

# NOTE: ck-search skipped - ONNX Runtime linking fails in this container environment
# TODO: Revisit when ck-search releases pre-built binaries or fixes ONNX deps
# Benefits when available: 80-90% faster searches, Ghost Feature detection
# RUN cargo install ck-search && ck --version

# Install beads_rust (persistent task graph)
# Benefits: Cross-session task persistence, dependency tracking
RUN cargo install beads_rust \
    && br --version

# Install Python packages for Memory Stack
# WARNING: This adds ~2-3GB for PyTorch + transformers
# Benefits: Semantic memory recall, NOTES.md sync
RUN pip3 install --no-cache-dir --break-system-packages \
    sentence-transformers \
    && python3 -c "from sentence_transformers import SentenceTransformer; print('sentence-transformers OK')"

# Install patchright for Flatline NotebookLM integration
# Benefits: Query NotebookLM notebooks for domain knowledge
RUN pip3 install --no-cache-dir --break-system-packages patchright \
    && python3 -m patchright install chromium

# -----------------------------------------------------------------------------
# Stage 3: OpenClaw Gateway
# -----------------------------------------------------------------------------

# Install clawdbot - same version as moltworker for compatibility
RUN npm install -g clawdbot@2026.1.24-3 \
    && clawdbot --version

# Create directory structure
RUN mkdir -p \
    /workspace \
    /workspace/.claude \
    /workspace/grimoires/loa/memory \
    /workspace/deploy/loa-identity \
    /workspace/.loa \
    /data/moltbot \
    /data/wal \
    /root/.clawdbot \
    /root/.clawdbot-templates \
    /root/clawd/skills

# -----------------------------------------------------------------------------
# Stage 4: Loa Identity Layer
# -----------------------------------------------------------------------------

# Fetch Loa framework and identity files from GitHub
# This ensures we always get the latest from the repo
ARG LOA_REPO=https://github.com/0xHoneyJar/loa-beauvoir.git
ARG LOA_BRANCH=main
RUN git clone --depth 1 --branch ${LOA_BRANCH} ${LOA_REPO} /tmp/loa-repo \
    && cp -r /tmp/loa-repo/.claude/* /workspace/.claude/ \
    && cp -r /tmp/loa-repo/grimoires/* /workspace/grimoires/ \
    && cp /tmp/loa-repo/.loa-version.json /workspace/ 2>/dev/null || echo '{"framework_version":"1.21.0"}' > /workspace/.loa-version.json \
    && cp /tmp/loa-repo/deploy/start-loa.sh /usr/local/bin/start-loa.sh \
    && cp -r /tmp/loa-repo/deploy/loa-identity/* /workspace/deploy/loa-identity/ 2>/dev/null || true \
    && rm -rf /tmp/loa-repo

# Make startup script executable and create symlink for moltworker compatibility
RUN chmod +x /usr/local/bin/start-loa.sh \
    && ln -sf /usr/local/bin/start-loa.sh /usr/local/bin/start-moltbot.sh

# Copy moltworker templates (for gateway config)
COPY moltbot.json.template /root/.clawdbot-templates/moltbot.json.template
COPY skills/ /root/clawd/skills/

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
ARG BUILD_TS=20260203-0200

# NO ENTRYPOINT - The base image handles SDK communication on port 3000
# The Worker will call /usr/local/bin/start-moltbot.sh via startProcess()
# (which is symlinked to start-loa.sh for Loa identity)
