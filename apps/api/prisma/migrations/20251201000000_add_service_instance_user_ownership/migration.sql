-- Add userId ownership to ServiceInstance
-- This migration adds user ownership to service instances for authorization

-- ============================================================================
-- SAFETY GUARD: Prevent data loss when ServiceInstances exist but no Users
-- ============================================================================
-- SQLite doesn't have procedural blocks like PostgreSQL's DO/RAISE EXCEPTION.
-- This guard uses a CHECK constraint violation to abort the migration if
-- ServiceInstances exist but no Users are found.

-- Create a guard table that will fail with a constraint violation if the
-- dangerous condition is detected (instances exist but no users).
CREATE TABLE "_migration_safety_check" (
    "id" INTEGER PRIMARY KEY,
    "status" TEXT NOT NULL CHECK("status" != 'BLOCKED')
);

-- Insert 'OK' if safe, 'BLOCKED' if dangerous - the CHECK constraint will reject 'BLOCKED'
-- This safely handles all cases:
-- 1. No ServiceInstances exist -> inserts 'OK' (safe)
-- 2. ServiceInstances exist AND Users exist -> inserts 'OK' (safe)
-- 3. ServiceInstances exist AND no Users -> inserts 'BLOCKED' (fails with constraint violation)
INSERT INTO "_migration_safety_check" ("id", "status")
SELECT 1,
    CASE
        WHEN EXISTS (SELECT 1 FROM "ServiceInstance") AND NOT EXISTS (SELECT 1 FROM "User")
        THEN 'BLOCKED'
        ELSE 'OK'
    END;

-- If we reach here, the check passed - clean up
DROP TABLE "_migration_safety_check";

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
