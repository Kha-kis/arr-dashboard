# Combined Dockerfile for Arr Dashboard (API + Web)
# Optimized for single-container deployment (Unraid, etc.)
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ===== DEPENDENCIES STAGE =====
FROM base AS deps
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
FROM base AS builder
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
FROM base AS runner
WORKDIR /app

# Install runtime dependencies
# - tini: proper signal handling
# - su-exec: lightweight sudo for dropping privileges
RUN apk add --no-cache tini su-exec

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

# Create default non-root user (will be updated by start.sh if PUID/PGID are set)
RUN addgroup -g 1000 nodejs && \
    adduser -D -u 1000 -G nodejs arruser

# Note: We start as root to allow PUID/PGID changes, then drop privileges in start.sh

# Expose both ports
EXPOSE 3000 3001

# Environment variables
ENV DATABASE_URL="file:/app/data/prod.db" \
    API_PORT=3001 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    PUID=1000 \
    PGID=1000

# Health check (checks web UI)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use tini to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/start.sh"]
