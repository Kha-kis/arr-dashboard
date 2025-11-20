/*
  Warnings:

  - The primary key for the `oidc_providers` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to alter the column `id` on the `oidc_providers` table. The data in that column could be lost. The data in that column will be cast from `String` to `Int`.

  IMPORTANT: This migration enforces the single-provider constraint at the database level.
  The id column is changed from TEXT to INTEGER with a default value of 1, ensuring only
  one OIDC provider can exist in the database (enforced by primary key constraint).
*/

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Recreate oidc_providers table with INTEGER id (singleton pattern)
CREATE TABLE "new_oidc_providers" (
    "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
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

-- Migrate existing data (force id to 1, only take first provider if multiple exist)
INSERT INTO "new_oidc_providers" ("displayName", "clientId", "encryptedClientSecret", "clientSecretIv", "issuer", "redirectUri", "scopes", "enabled", "createdAt", "updatedAt")
SELECT "displayName", "clientId", "encryptedClientSecret", "clientSecretIv", "issuer", "redirectUri", "scopes", "enabled", "createdAt", "updatedAt"
FROM "oidc_providers"
ORDER BY "createdAt" DESC
LIMIT 1;

-- Drop old table and rename new table
DROP TABLE "oidc_providers";
ALTER TABLE "new_oidc_providers" RENAME TO "oidc_providers";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
