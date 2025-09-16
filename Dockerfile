# Multi-stage build for *arr Dashboard
# Stage 1: Build the frontend
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production --ignore-scripts

# Copy source code
COPY . .

# Build frontend
RUN npm run build

# Stage 2: Production runtime
FROM node:18-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init curl

# Create app user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S appuser -u 1001 -G nodejs

# Set working directory
WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts && \
    npm cache clean --force

# Copy built application and server from builder stage
COPY --from=builder --chown=appuser:nodejs /app/dist ./dist
COPY --from=builder --chown=appuser:nodejs /app/server ./server
COPY --from=builder --chown=appuser:nodejs /app/.env.example ./.env.example

# Create logs directory
RUN mkdir -p logs && chown appuser:nodejs logs

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Create startup script
USER root
RUN cat > /app/entrypoint.sh << 'EOF'
#!/bin/sh
set -e

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env file from template..."
    cp .env.example .env
fi

# Start the application
exec "$@"
EOF

RUN chmod +x /app/entrypoint.sh && chown appuser:nodejs /app/entrypoint.sh

USER appuser

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--", "/app/entrypoint.sh"]

# Start the server
CMD ["npm", "run", "server:prod"]