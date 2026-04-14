# ── Platform Agent — Multi-stage Docker build ───────────────────────────────
#
# Stage 1: Build TypeScript → JavaScript
# Stage 2: Production image (Node 22 Alpine, minimal footprint)
#
# Build:  docker build -t ghcr.io/jayrchamp/platform-agent:1.0.0 .
# Run:    docker run -p 127.0.0.1:3100:3100 -v /opt/platform/agent/config:/config:ro ghcr.io/jayrchamp/platform-agent:1.0.0

# ── Stage 1: Build ──────────────────────────────────────────────────────────

FROM node:22-alpine AS builder

WORKDIR /build

# Install deps first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Stage 2: Production ────────────────────────────────────────────────────

FROM node:22-alpine

# Non-root runtime user (UID 10001 to avoid host UID conflicts)
RUN addgroup -g 10001 agent && adduser -u 10001 -G agent -s /bin/sh -D agent

# su-exec for privilege drop in entrypoint (Alpine equivalent of gosu)
RUN apk add --no-cache su-exec

WORKDIR /app

# Install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JS from builder
COPY --from=builder /build/dist/ dist/
COPY package.json ./

# Entrypoint: fixes volume permissions, then drops to 'agent' user
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Health check (matches what platform-verification.ts expects)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/health || exit 1

EXPOSE 3100

# Starts as root to fix volume ownership, then entrypoint drops to 'agent' via su-exec.
# Do NOT add USER here — the entrypoint needs root briefly for chown + docker.sock group.
ENTRYPOINT ["/entrypoint.sh"]
