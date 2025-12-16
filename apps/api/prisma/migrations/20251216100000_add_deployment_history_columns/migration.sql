-- Add missing columns to template_deployment_history table
-- These columns exist in schema but were missing from 20251204000000_add_trash_guides_tables migration
-- Note: appliedCFs, failedCFs, totalCFs, conflictsCount already exist in original migration

-- Add detail columns (errors replaces errorLog naming from original migration)
ALTER TABLE "template_deployment_history" ADD COLUMN "errors" TEXT;
ALTER TABLE "template_deployment_history" ADD COLUMN "warnings" TEXT;

-- Add rollback capability columns
ALTER TABLE "template_deployment_history" ADD COLUMN "canRollback" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "template_deployment_history" ADD COLUMN "rolledBack" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "template_deployment_history" ADD COLUMN "rolledBackAt" DATETIME;
ALTER TABLE "template_deployment_history" ADD COLUMN "rolledBackBy" TEXT;

-- Add additional metadata columns
ALTER TABLE "template_deployment_history" ADD COLUMN "deploymentNotes" TEXT;
ALTER TABLE "template_deployment_history" ADD COLUMN "templateSnapshot" TEXT;

-- Add missing index for userId
CREATE INDEX "template_deployment_history_userId_idx" ON "template_deployment_history"("userId");
