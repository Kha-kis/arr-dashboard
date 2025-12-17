#!/bin/sh
set -e

echo "Synchronizing database schema..."
# Use 'db push' for multi-provider support (SQLite/PostgreSQL)
npx prisma db push --schema prisma/schema.prisma --skip-generate

echo "Starting API server..."
exec node dist/index.js
