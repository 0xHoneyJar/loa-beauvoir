# =============================================================================
# Loa Development Makefile
# =============================================================================
# Developer-friendly commands for local development and deployment.
#
# Quick Start:
#   cp .env.local.example .env.local  # Configure API keys
#   make dev                          # Start hot-reload environment
# =============================================================================

.PHONY: help dev dev-build dev-shell dev-logs dev-down dev-clean dev-chat dev-tui dev-msg deploy-cf

# Default target: show help
help:
	@echo ""
	@echo "Loa Development Commands"
	@echo "========================"
	@echo ""
	@echo "Local Development:"
	@echo "  make dev         Start local dev environment (uses cached image)"
	@echo "  make dev-build   Rebuild dev image and start"
	@echo "  make dev-shell   Shell into running container"
	@echo "  make dev-logs    Follow container logs"
	@echo "  make dev-down    Stop development environment"
	@echo "  make dev-clean   Stop and remove all state (WAL, beads, etc.)"
	@echo ""
	@echo "Testing (no Telegram needed):"
	@echo "  make dev-chat    Open webchat UI in browser"
	@echo "  make dev-tui     Interactive terminal chat (inside container)"
	@echo "  make dev-msg     Send a test message to agent"
	@echo ""
	@echo "Deployment:"
	@echo "  make deploy-cf   Manual Cloudflare deploy (escape hatch)"
	@echo ""
	@echo "Prerequisites:"
	@echo "  - Copy .env.local.example to .env.local"
	@echo "  - Fill in ANTHROPIC_API_KEY (required)"
	@echo "  - Docker Desktop with VirtioFS enabled (macOS)"
	@echo ""

# =============================================================================
# Local Development
# =============================================================================

# Start development environment (uses cached image if available)
dev:
	@if [ ! -f .env.local ]; then \
		echo "ERROR: .env.local not found."; \
		echo "Run: cp .env.local.example .env.local"; \
		echo "Then fill in your ANTHROPIC_API_KEY"; \
		exit 1; \
	fi
	docker compose -f docker-compose.dev.yml up

# Rebuild image before starting (use when Dockerfile.dev changes)
dev-build:
	@if [ ! -f .env.local ]; then \
		echo "ERROR: .env.local not found."; \
		echo "Run: cp .env.local.example .env.local"; \
		echo "Then fill in your ANTHROPIC_API_KEY"; \
		exit 1; \
	fi
	docker compose -f docker-compose.dev.yml up --build

# Shell into running container
dev-shell:
	docker compose -f docker-compose.dev.yml exec loa-dev bash

# Follow container logs
dev-logs:
	docker compose -f docker-compose.dev.yml logs -f

# Stop development environment
dev-down:
	docker compose -f docker-compose.dev.yml down

# Full cleanup: remove containers, volumes, and local state
dev-clean:
	docker compose -f docker-compose.dev.yml down -v --remove-orphans
	@echo ""
	@echo "Cleanup complete. Volume 'loa-dev-data-v1' removed."
	@echo "Note: State files (WAL, beads, ck index) were inside the volume."

# =============================================================================
# Terminal Testing (No Telegram Required)
# =============================================================================

# Open webchat UI in browser (requires dev container running)
dev-chat:
	@echo "Opening webchat UI at http://localhost:18789"
	@echo "Make sure 'make dev' is running in another terminal"
	@command -v xdg-open >/dev/null && xdg-open http://localhost:18789 || \
	 command -v open >/dev/null && open http://localhost:18789 || \
	 echo "Open http://localhost:18789 in your browser"

# Interactive TUI chat inside container
dev-tui:
	@echo "Starting interactive TUI chat..."
	@echo "Type messages to chat with LOA, Ctrl+C to exit"
	docker compose -f docker-compose.dev.yml exec loa-dev clawdbot tui

# Send a test message to the agent
# Usage: make dev-msg MSG="Hello LOA"
dev-msg:
	@if [ -z "$(MSG)" ]; then \
		echo "Usage: make dev-msg MSG=\"Your message here\""; \
		echo "Example: make dev-msg MSG=\"What is your status?\""; \
		exit 1; \
	fi
	@echo "Sending message to agent..."
	docker compose -f docker-compose.dev.yml exec loa-dev \
		clawdbot message send --to "agent:default" --body "$(MSG)"

# =============================================================================
# Deployment
# =============================================================================

# Manual Cloudflare deployment (escape hatch when CI/CD is broken)
deploy-cf:
	@echo "Deploying to Cloudflare Workers..."
	cd deploy/cloudflare && npm run deploy
