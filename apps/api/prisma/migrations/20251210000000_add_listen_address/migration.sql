-- Add listenAddress column to system_settings
ALTER TABLE "system_settings" ADD COLUMN "listenAddress" TEXT NOT NULL DEFAULT '0.0.0.0';
