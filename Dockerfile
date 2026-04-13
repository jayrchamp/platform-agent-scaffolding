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
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --immutable

# Copy source and compile
COPY tsconfig.json ./
COPY src/ src/
RUN yarn build

# ── Stage 2: Production ────────────────────────────────────────────────────

FROM node:22-alpine

WORKDIR /app

# Install production deps only
COPY package.json yarn.lock ./
RUN corepack enable && yarn workspaces focus --production 2>/dev/null || yarn install --immutable

# Copy compiled JS from builder
COPY --from=builder /build/dist/ dist/
COPY package.json ./

# Non-root user for security
RUN addgroup -S agent && adduser -S agent -G agent
USER agent

# Health check (matches what platform-verification.ts expects)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/health || exit 1

EXPOSE 3100

CMD ["node", "dist/server.js"]
