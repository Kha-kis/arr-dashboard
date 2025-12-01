-- Add userId ownership to ServiceInstance
-- This migration adds user ownership to service instances for authorization

-- ============================================================================
-- SAFETY GUARD: Prevent data loss when ServiceInstances exist but no Users
-- ============================================================================
-- SQLite doesn't have procedural blocks like PostgreSQL's DO/RAISE EXCEPTION.
-- This guard creates a temporary table that will cause a UNIQUE constraint violation
-- if the dangerous condition is detected (instances exist but no users).
-- The error message will guide operators to create a user first.

-- Create a guard table to detect dangerous condition
CREATE TEMPORARY TABLE IF NOT EXISTS "_migration_guard" (
    "check_name" TEXT PRIMARY KEY,
    "message" TEXT NOT NULL
);

-- This INSERT succeeds only if there are NO ServiceInstances OR there IS at least one User
-- If ServiceInstances exist AND no Users exist, the SELECT returns a row
-- which will be inserted, and then we force an error
INSERT INTO "_migration_guard" ("check_name", "message")
SELECT
    'MIGRATION_BLOCKED',
    'ERROR: Cannot migrate ServiceInstance table - instances exist but no users found. ' ||
    'This migration would silently DROP all existing ServiceInstance data. ' ||
    'Please create at least one user before running this migration. ' ||
    'Run: INSERT INTO User (id, email, name, createdAt, updatedAt) VALUES (...)'
WHERE EXISTS (SELECT 1 FROM "ServiceInstance")
  AND NOT EXISTS (SELECT 1 FROM "User");

-- Force an error if the guard was triggered by selecting from a non-existent table
-- The table name encodes the error message for clarity in logs
SELECT CASE
    WHEN EXISTS (SELECT 1 FROM "_migration_guard" WHERE "check_name" = 'MIGRATION_BLOCKED')
    THEN (
        -- This subquery forces a runtime error by referencing a deliberately non-existent table
        -- The table name contains the error message for visibility in error logs
        SELECT "error" FROM "MIGRATION_ABORTED__ServiceInstances_exist_but_no_Users__Create_a_user_first"
    )
    ELSE 'OK'
END AS "migration_guard_check";

-- Clean up guard table
DROP TABLE IF EXISTS "_migration_guard";

-- ============================================================================
-- END SAFETY GUARD
-- ============================================================================

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Create new table with userId column
CREATE TABLE "new_ServiceInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "encryptionIv" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultQualityProfileId" INTEGER,
    "defaultLanguageProfileId" INTEGER,
    "defaultRootFolderPath" TEXT,
    "defaultSeasonFolder" BOOLEAN,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ServiceInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Migrate existing data: assign instances to first user (or fail if no users exist)
-- This assumes at least one user exists; existing instances will be owned by the first user
INSERT INTO "new_ServiceInstance" (
    "id", "userId", "service", "label", "baseUrl", "encryptedApiKey", "encryptionIv",
    "isDefault", "enabled", "defaultQualityProfileId", "defaultLanguageProfileId",
    "defaultRootFolderPath", "defaultSeasonFolder", "createdAt", "updatedAt"
)
SELECT
    si."id",
    (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1),
    si."service",
    si."label",
    si."baseUrl",
    si."encryptedApiKey",
    si."encryptionIv",
    si."isDefault",
    si."enabled",
    si."defaultQualityProfileId",
    si."defaultLanguageProfileId",
    si."defaultRootFolderPath",
    si."defaultSeasonFolder",
    si."createdAt",
    si."updatedAt"
FROM "ServiceInstance" si
WHERE EXISTS (SELECT 1 FROM "User");

-- Drop old table and rename new one
DROP TABLE "ServiceInstance";
ALTER TABLE "new_ServiceInstance" RENAME TO "ServiceInstance";

-- Recreate indexes
CREATE INDEX "ServiceInstance_service_idx" ON "ServiceInstance"("service");
CREATE INDEX "ServiceInstance_userId_idx" ON "ServiceInstance"("userId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
