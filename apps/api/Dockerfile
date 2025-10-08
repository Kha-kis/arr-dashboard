# API Dockerfile
FROM node:20-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

FROM base AS deps
WORKDIR /app

# Copy workspace files
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY package.json ./

# Copy package.json files for all workspaces
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install dependencies
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app

# Copy everything from deps stage (includes workspace structure)
COPY --from=deps /app ./

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
COPY turbo.json ./

# Build shared package first, then API
WORKDIR /app
RUN pnpm --filter @arr/shared run build
RUN pnpm --filter @arr/api run build

# Create a production deployment without symlinks
WORKDIR /app
RUN pnpm --filter @arr/api --prod deploy /app/deploy

FROM base AS runner
WORKDIR /app

# Copy production deployment (without symlinks)
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/deploy/package.json ./package.json
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/prisma ./prisma
COPY --from=builder /app/apps/api/scripts/start.sh ./start.sh

# Generate Prisma client in the final image
RUN npx prisma generate --schema prisma/schema.prisma

# Create data directory and make script executable
RUN mkdir -p /app/data && chmod +x /app/start.sh

# Create non-root user and set ownership
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 apiuser && \
    chown -R apiuser:nodejs /app

USER apiuser

EXPOSE 3001

# Set default DATABASE_URL for Docker
ENV DATABASE_URL="file:/app/data/prod.db"

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["/app/start.sh"]
