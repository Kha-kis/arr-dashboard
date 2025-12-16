-- Add missing columns to template_deployment_history table (idempotent)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- This migration may fail on databases where columns already exist
-- In that case, mark the migration as applied using: prisma migrate resolve --applied

-- Add new statistics columns
ALTER TABLE "template_deployment_history" ADD COLUMN "appliedCFs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "template_deployment_history" ADD COLUMN "failedCFs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "template_deployment_history" ADD COLUMN "totalCFs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "template_deployment_history" ADD COLUMN "conflictsCount" INTEGER NOT NULL DEFAULT 0;

-- Add new detail columns
ALTER TABLE "template_deployment_history" ADD COLUMN "errors" TEXT;
ALTER TABLE "template_deployment_history" ADD COLUMN "warnings" TEXT;

-- Add rollback capability columns
ALTER TABLE "template_deployment_history" ADD COLUMN "canRollback" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "template_deployment_history" ADD COLUMN "rolledBack" BOOLEAN NOT NULL DEFAULT 0;
