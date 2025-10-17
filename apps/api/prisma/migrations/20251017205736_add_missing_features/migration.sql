/*
  Warnings:

  - You are about to drop the column `userId` on the `ServiceInstance` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `ServiceTag` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "oidc_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "oidc_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "providerEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "oidc_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webauthn_credentials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "friendlyName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webauthn_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "backup_settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalType" TEXT NOT NULL DEFAULT 'DISABLED',
    "intervalValue" INTEGER NOT NULL DEFAULT 24,
    "retentionCount" INTEGER NOT NULL DEFAULT 7,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ServiceInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ServiceInstance" ("baseUrl", "createdAt", "defaultLanguageProfileId", "defaultQualityProfileId", "defaultRootFolderPath", "defaultSeasonFolder", "enabled", "encryptedApiKey", "encryptionIv", "id", "isDefault", "label", "service", "updatedAt") SELECT "baseUrl", "createdAt", "defaultLanguageProfileId", "defaultQualityProfileId", "defaultRootFolderPath", "defaultSeasonFolder", "enabled", "encryptedApiKey", "encryptionIv", "id", "isDefault", "label", "service", "updatedAt" FROM "ServiceInstance";
DROP TABLE "ServiceInstance";
ALTER TABLE "new_ServiceInstance" RENAME TO "ServiceInstance";
CREATE INDEX "ServiceInstance_service_idx" ON "ServiceInstance"("service");
CREATE TABLE "new_ServiceTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ServiceTag" ("createdAt", "id", "name", "updatedAt") SELECT "createdAt", "id", "name", "updatedAt" FROM "ServiceTag";
DROP TABLE "ServiceTag";
ALTER TABLE "new_ServiceTag" RENAME TO "ServiceTag";
CREATE UNIQUE INDEX "ServiceTag_name_key" ON "ServiceTag"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "oidc_providers_type_key" ON "oidc_providers"("type");

-- CreateIndex
CREATE INDEX "oidc_accounts_userId_idx" ON "oidc_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_accounts_provider_providerUserId_key" ON "oidc_accounts"("provider", "providerUserId");

-- CreateIndex
CREATE INDEX "webauthn_credentials_userId_idx" ON "webauthn_credentials"("userId");
