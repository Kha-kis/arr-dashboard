# Combined Dockerfile for Arr Dashboard (API + Web)
# Optimized for single-container deployment (Unraid, etc.)
# syntax=docker/dockerfile:1

# ===== BUILD BASE =====
FROM node:25-alpine3.21 AS build-base
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

# ===== DEPENDENCIES STAGE =====
FROM build-base AS deps
WORKDIR /app

# Copy workspace configuration and package.json files
COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json ./
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
# Also create version.json from root package.json for runtime version detection
# Note: Prisma 7 uses prisma.config.ts for CLI configuration
# Note: prisma.config.ts needs tsconfig files for TypeScript compilation
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @arr/api --prod deploy /app/deploy-api && \
    cd /app/deploy-api && \
    cp -r /app/apps/api/dist ./dist && \
    cp -r /app/apps/api/prisma ./prisma && \
    cp /app/apps/api/prisma.config.ts ./prisma.config.ts && \
    cp /app/apps/api/tsconfig.json ./tsconfig.json && \
    mkdir -p ../../ && cp /app/tsconfig.base.json ../../tsconfig.base.json && \
    npx prisma generate --schema prisma/schema.prisma && \
    rm -rf ../../tsconfig.base.json tsconfig.json && \
    node -e "const p=require('/app/package.json'); console.log(JSON.stringify({version:p.version,name:p.name}))" > ./version.json && \
    # Remove non-Linux native module prebuilds to reduce image size (~1MB)
    find node_modules -type d -name "prebuilds" -exec sh -c 'cd "{}" && rm -rf darwin-* win32-* freebsd-*' \; 2>/dev/null || true

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
FROM node:25-alpine3.21 AS runner

# Build arguments for version injection (set by CI)
ARG VERSION=dev
ARG COMMIT_SHA=unknown
ARG BUILD_DATE=unknown

# OCI Image Labels (including build-time metadata)
LABEL org.opencontainers.image.title="Arr Dashboard" \
      org.opencontainers.image.description="Unified dashboard for managing multiple Sonarr, Radarr, and Prowlarr instances" \
      org.opencontainers.image.source="https://github.com/Kha-kis/arr-dashboard" \
      org.opencontainers.image.url="https://github.com/Kha-kis/arr-dashboard" \
      org.opencontainers.image.documentation="https://github.com/Kha-kis/arr-dashboard#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="khak1s" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      maintainer="khak1s"

# Upgrade base packages (security patches for libcrypto3, libssl3, busybox, etc.)
# then install runtime dependencies, create user, and clean up unused package managers (single layer)
# Removes ~25MB of unused npm, yarn, and corepack from the Node.js base image
RUN apk upgrade --no-cache \
    && apk add --no-cache tini su-exec shadow \
    && addgroup -g 911 abc \
    && adduser -D -u 911 -G abc abc \
    && mkdir -p /app/api /app/web /config \
    && chown -R abc:abc /app /config \
    && rm -rf /opt/yarn-v* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack

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
    PGID=911 \
    # Node.js memory optimization for containers (can be overridden)
    NODE_OPTIONS="--max-old-space-size=512 --dns-result-order=ipv4first"

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:'+(process.env.API_PORT||3001)+'/auth/setup-required',(r)=>{process.exit(r.statusCode>=200&&r.statusCode<300?0:1)}).on('error',()=>process.exit(1))"

# Signal for graceful shutdown (tini forwards to child processes)
STOPSIGNAL SIGTERM

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/start.sh"]
