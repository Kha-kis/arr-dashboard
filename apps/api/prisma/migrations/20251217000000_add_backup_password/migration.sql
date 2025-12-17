-- Add encrypted backup password fields to backup_settings
-- This allows users to configure backup password via UI instead of environment variable

ALTER TABLE "backup_settings" ADD COLUMN "encryptedPassword" TEXT;
ALTER TABLE "backup_settings" ADD COLUMN "passwordIv" TEXT;
