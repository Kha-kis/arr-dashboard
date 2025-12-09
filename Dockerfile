# Combined Dockerfile for Arr Dashboard (API + Web)
# Optimized for single-container deployment (Unraid, etc.)
# syntax=docker/dockerfile:1

# ===== BUILD BASE =====
FROM node:20-alpine AS build-base
# Disable Next.js telemetry for faster builds
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ===== DEPENDENCIES STAGE =====
FROM build-base AS deps
WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy all package.json files
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Install dependencies with BuildKit cache mount (persists pnpm store between builds)
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ===== BUILD STAGE =====
FROM build-base AS builder
WORKDIR /app

# Copy dependencies
COPY --from=deps /app ./

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY tsconfig.base.json turbo.json ./

# Build all packages using Turbo (parallel builds with caching)
RUN --mount=type=cache,id=turbo,target=/app/.turbo \
    pnpm turbo run build --filter=@arr/shared --filter=@arr/api --filter=@arr/web

# Deploy API for production (removes dev dependencies)
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @arr/api --prod deploy /app/deploy-api

# ===== RUNTIME STAGE =====
# Use node:20-alpine for consistent Node version between build and runtime
FROM node:20-alpine AS runner

# OCI Image Labels (must be in final stage)
LABEL org.opencontainers.image.title="Arr Dashboard" \
      org.opencontainers.image.description="Unified dashboard for managing multiple Sonarr, Radarr, and Prowlarr instances" \
      org.opencontainers.image.source="https://github.com/Kha-kis/arr-dashboard" \
      org.opencontainers.image.url="https://github.com/Kha-kis/arr-dashboard" \
      org.opencontainers.image.documentation="https://github.com/Kha-kis/arr-dashboard#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="khak1s" \
      maintainer="khak1s"

# Install runtime dependencies and create abc user in single layer
# - tini: proper signal handling
# - su-exec: lightweight sudo for dropping privileges
# - shadow: usermod/groupmod for PUID/PGID support
# - abc user: LinuxServer convention with PUID/PGID support (UID/GID 911)
RUN apk add --no-cache tini su-exec shadow \
    && addgroup -g 911 abc \
    && adduser -D -u 911 -G abc abc \
    && mkdir -p /app/api /app/web /config \
    && chown -R abc:abc /app /config

WORKDIR /app

# Copy API files (with --chown to avoid recursive chown later)
COPY --from=builder --chown=abc:abc /app/deploy-api/node_modules ./api/node_modules
COPY --from=builder --chown=abc:abc /app/deploy-api/package.json ./api/package.json
COPY --from=builder --chown=abc:abc /app/apps/api/dist ./api/dist
COPY --from=builder --chown=abc:abc /app/apps/api/prisma ./api/prisma

# Copy Web files (Next.js standalone output)
COPY --from=builder --chown=abc:abc /app/apps/web/.next/standalone ./web
COPY --from=builder --chown=abc:abc /app/apps/web/.next/static ./web/apps/web/.next/static

# Copy custom server wrapper for runtime API_HOST configuration
COPY --from=builder --chown=abc:abc /app/apps/web/server.js ./web/server.js

# Generate Prisma client for API
WORKDIR /app/api
RUN npx prisma generate --schema prisma/schema.prisma

# Copy startup script and helper scripts
WORKDIR /app
COPY --chown=abc:abc docker/start-combined.sh ./start.sh
COPY --chown=abc:abc docker/read-base-path.js ./read-base-path.js
RUN sed -i 's/\r$//' ./start.sh && chmod +x ./start.sh

# Expose both ports
EXPOSE 3000 3001

# Environment variables
ENV DATABASE_URL="file:/config/prod.db" \
    API_PORT=3001 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    PUID=911 \
    PGID=911

# Health check (checks web UI, respects custom PORT)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const port=process.env.PORT||3000; require('http').get('http://localhost:'+port+'/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use tini to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/start.sh"]
