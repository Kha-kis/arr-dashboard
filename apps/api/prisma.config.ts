import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 Configuration
 *
 * This file provides datasource configuration for Prisma CLI operations
 * (db:push, generate, etc.). The actual runtime connection is established
 * in the PrismaClient constructor within src/plugins/prisma.ts.
 *
 * The DATABASE_URL auto-defaults based on environment:
 * - Production/Docker: file:/app/data/prod.db
 * - Development: file:./dev.db
 */
export default defineConfig({
	schema: "prisma/schema.prisma",
});
