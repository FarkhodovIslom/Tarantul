# ──────────────────────────────────────────────────────────────
# tarantul-ts — lightweight Bun-based Docker image
# ──────────────────────────────────────────────────────────────
# Stage 1: install dependencies (cached layer)
# Stage 2: copy source + skills → slim runtime image
# ──────────────────────────────────────────────────────────────

FROM oven/bun:1 AS deps

WORKDIR /app

# Install production deps only (cached unless lockfile changes)
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production

# ──────────────────────────────────────────────────────────────
# Runtime
# ──────────────────────────────────────────────────────────────

FROM oven/bun:1-slim

# Install minimal runtime deps (curl for health checks, git for tools)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source, skills, and config files
COPY package.json tsconfig.json biome.json ./
COPY src/ src/
COPY skills/ skills/

# Create config directory
RUN mkdir -p /root/.tarantul

# API server default port
EXPOSE 8080

# Health check against the API server
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

ENTRYPOINT ["bun", "run", "src/cli/main.ts"]
CMD ["serve"]
