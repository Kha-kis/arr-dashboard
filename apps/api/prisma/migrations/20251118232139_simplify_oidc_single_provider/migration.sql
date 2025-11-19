/*
  Warnings:

  - You are about to drop the column `type` on the `oidc_providers` table. All the data in the column will be lost.
  - You are about to drop the column `provider` on the `oidc_accounts` table. All the data in the column will be lost.

  IMPORTANT: This migration assumes a single-provider setup. If you have multiple providers
  configured or the same user linked to multiple providers, this migration will:
  1. Keep only the most recently created OIDCAccount per providerUserId
  2. Keep only the most recently created OIDCProvider
  3. Backfill missing redirectUri values with a default
*/

-- Step 1: Handle duplicate providerUserIds in oidc_accounts
-- Delete all but the most recent account for each providerUserId
DELETE FROM "oidc_accounts"
WHERE "id" NOT IN (
  SELECT "id" FROM (
    SELECT "id", "providerUserId", MAX("createdAt") as max_created
    FROM "oidc_accounts"
    GROUP BY "providerUserId"
  )
);

-- Step 2: Handle multiple OIDC providers (keep only most recent)
DELETE FROM "oidc_providers"
WHERE "id" NOT IN (
  SELECT "id" FROM (
    SELECT "id", MAX("createdAt") as max_created
    FROM "oidc_providers"
  )
);

-- DropIndex
DROP INDEX "oidc_providers_type_key";

-- DropIndex
DROP INDEX "oidc_accounts_provider_providerUserId_key";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Redefine oidc_providers table without type column
CREATE TABLE "new_oidc_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedClientSecret" TEXT NOT NULL,
    "clientSecretIv" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'openid,email,profile',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- Insert with redirectUri backfill for NULL values
INSERT INTO "new_oidc_providers" ("id", "displayName", "clientId", "encryptedClientSecret", "clientSecretIv", "issuer", "redirectUri", "scopes", "enabled", "createdAt", "updatedAt")
SELECT "id", "displayName", "clientId", "encryptedClientSecret", "clientSecretIv", "issuer",
       COALESCE("redirectUri", "issuer" || '/auth/oidc/callback') as "redirectUri",
       "scopes", "enabled", "createdAt", "updatedAt"
FROM "oidc_providers";
DROP TABLE "oidc_providers";
ALTER TABLE "new_oidc_providers" RENAME TO "oidc_providers";

-- Redefine oidc_accounts table without provider column
CREATE TABLE "new_oidc_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "providerEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "oidc_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_oidc_accounts" ("id", "userId", "providerUserId", "providerEmail", "createdAt", "updatedAt")
SELECT "id", "userId", "providerUserId", "providerEmail", "createdAt", "updatedAt" FROM "oidc_accounts";
DROP TABLE "oidc_accounts";
ALTER TABLE "new_oidc_accounts" RENAME TO "oidc_accounts";

-- Recreate indexes (now safe because duplicates have been removed)
CREATE INDEX "oidc_accounts_userId_idx" ON "oidc_accounts"("userId");
CREATE UNIQUE INDEX "oidc_accounts_providerUserId_key" ON "oidc_accounts"("providerUserId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
