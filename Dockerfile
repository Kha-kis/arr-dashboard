# Combined Dockerfile for Arr Dashboard (API + Web)
# Optimized for single-container deployment (Unraid, etc.)

# ===== BUILD BASE =====
FROM node:20-alpine AS build-base
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

# Install all dependencies
RUN pnpm install --frozen-lockfile

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

# Build shared package first
RUN pnpm --filter @arr/shared run build

# Build API
RUN pnpm --filter @arr/api run build

# Build web app
RUN pnpm --filter @arr/web run build

# Deploy API for production (removes dev dependencies)
RUN pnpm --filter @arr/api --prod deploy /app/deploy-api

# ===== RUNTIME STAGE =====
# Use plain Alpine for clean slate (no pre-existing node user)
FROM alpine:3.21 AS runner
WORKDIR /app

# Install runtime dependencies
# - nodejs: runtime for the application (Alpine 3.21 has Node 22.x)
# - npm: needed for npx/prisma commands
# - tini: proper signal handling
# - su-exec: lightweight sudo for dropping privileges
# - shadow: usermod/groupmod for PUID/PGID support
RUN apk add --no-cache nodejs npm tini su-exec shadow

# Create directory structure
RUN mkdir -p /app/api /app/web /app/data

# Copy API files
COPY --from=builder /app/deploy-api/node_modules ./api/node_modules
COPY --from=builder /app/deploy-api/package.json ./api/package.json
COPY --from=builder /app/apps/api/dist ./api/dist
COPY --from=builder /app/apps/api/prisma ./api/prisma

# Copy Web files (Next.js standalone output)
COPY --from=builder /app/apps/web/.next/standalone ./web
COPY --from=builder /app/apps/web/.next/static ./web/apps/web/.next/static

# Generate Prisma client for API
WORKDIR /app/api
RUN npx prisma generate --schema prisma/schema.prisma

# Copy startup script and fix line endings (in case of CRLF from Windows)
WORKDIR /app
COPY docker/start-combined.sh ./start.sh
RUN sed -i 's/\r$//' ./start.sh && chmod +x ./start.sh

# Create abc user following LinuxServer convention
# Default UID/GID 911 avoids conflicts, modified at runtime via PUID/PGID
RUN addgroup -g 911 abc && \
    adduser -D -u 911 -G abc abc

# Set ownership of app directories to abc user
RUN chown -R abc:abc /app

# Expose both ports
EXPOSE 3000 3001

# Environment variables
ENV DATABASE_URL="file:/app/data/prod.db" \
    API_PORT=3001 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    PUID=911 \
    PGID=911

# Health check (checks web UI)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use tini to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/start.sh"]
