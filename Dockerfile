# Combined Dockerfile for Arr Dashboard (API + Web)
# Optimized for single-container deployment (Unraid, etc.)
# syntax=docker/dockerfile:1

# ===== BUILD BASE =====
FROM node:20-alpine AS build-base
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ===== DEPENDENCIES STAGE =====
FROM build-base AS deps
WORKDIR /app

# Copy workspace configuration and package.json files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Install dependencies with BuildKit cache mount
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ===== BUILD STAGE =====
FROM build-base AS builder
WORKDIR /app

# Copy dependencies and source code
COPY --from=deps /app ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY tsconfig.base.json turbo.json ./

# Build all packages using Turbo (parallel builds with caching)
RUN --mount=type=cache,id=turbo,target=/app/.turbo \
    pnpm turbo run build --filter=@arr/shared --filter=@arr/api --filter=@arr/web

# Deploy API for production and generate Prisma client
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @arr/api --prod deploy /app/deploy-api && \
    cd /app/deploy-api && \
    cp -r /app/apps/api/dist ./dist && \
    cp -r /app/apps/api/prisma ./prisma && \
    npx prisma generate --schema prisma/schema.prisma

# Prepare web output (consolidate standalone + static + custom server)
RUN cp /app/apps/web/server.js /app/apps/web/.next/standalone/server.js && \
    chmod 644 /app/apps/web/.next/standalone/server.js

# Fix pnpm's node_modules structure for standalone - create symlinks for top-level modules
RUN cd /app/apps/web/.next/standalone/node_modules && \
    for pkg in .pnpm/*/node_modules/*; do \
        name=$(basename "$pkg"); \
        if [ ! -e "$name" ] && [ -d "$pkg" ]; then \
            ln -sf "$pkg" "$name"; \
        fi; \
    done

# ===== RUNTIME STAGE =====
FROM node:20-alpine AS runner

# OCI Image Labels
LABEL org.opencontainers.image.title="Arr Dashboard" \
      org.opencontainers.image.description="Unified dashboard for managing multiple Sonarr, Radarr, and Prowlarr instances" \
      org.opencontainers.image.source="https://github.com/Kha-kis/arr-dashboard" \
      org.opencontainers.image.url="https://github.com/Kha-kis/arr-dashboard" \
      org.opencontainers.image.documentation="https://github.com/Kha-kis/arr-dashboard#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="khak1s" \
      maintainer="khak1s"

# Install runtime dependencies and create user (single layer)
RUN apk add --no-cache tini su-exec shadow \
    && addgroup -g 911 abc \
    && adduser -D -u 911 -G abc abc \
    && mkdir -p /app/api /app/web /config \
    && chown -R abc:abc /app /config

WORKDIR /app

# Copy API (single layer: node_modules + dist + prisma with generated client)
COPY --from=builder --chown=abc:abc /app/deploy-api ./api

# Copy Web (single layer: standalone + static + public + custom server)
COPY --from=builder --chown=abc:abc /app/apps/web/.next/standalone ./web
COPY --from=builder --chown=abc:abc /app/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=builder --chown=abc:abc /app/apps/web/public ./web/apps/web/public

# Copy startup scripts and fix line endings (single layer)
COPY --chown=abc:abc docker/start-combined.sh ./
COPY --chown=abc:abc docker/read-base-path.cjs ./api/
RUN sed -i 's/\r$//' ./start-combined.sh && chmod +x ./start-combined.sh \
    && mv start-combined.sh start.sh

# Configuration
EXPOSE 3000 3001
ENV DATABASE_URL="file:/config/prod.db" \
    API_PORT=3001 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    PUID=911 \
    PGID=911

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:'+(process.env.API_PORT||3001)+'/auth/setup-required',(r)=>{process.exit(r.statusCode>=200&&r.statusCode<300?0:1)}).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/start.sh"]
