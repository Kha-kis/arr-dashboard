-- CreateTable
CREATE TABLE "hunt_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "huntMissingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "huntUpgradesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "missingBatchSize" INTEGER NOT NULL DEFAULT 5,
    "missingIntervalMins" INTEGER NOT NULL DEFAULT 60,
    "upgradeBatchSize" INTEGER NOT NULL DEFAULT 3,
    "upgradeIntervalMins" INTEGER NOT NULL DEFAULT 120,
    "hourlyApiCap" INTEGER NOT NULL DEFAULT 100,
    "queueThreshold" INTEGER NOT NULL DEFAULT 25,
    "filterLogic" TEXT NOT NULL DEFAULT 'AND',
    "monitoredOnly" BOOLEAN NOT NULL DEFAULT true,
    "includeTags" TEXT,
    "excludeTags" TEXT,
    "includeQualityProfiles" TEXT,
    "excludeQualityProfiles" TEXT,
    "includeStatuses" TEXT,
    "yearMin" INTEGER,
    "yearMax" INTEGER,
    "ageThresholdDays" INTEGER,
    "researchAfterDays" INTEGER NOT NULL DEFAULT 7,
    "lastMissingHunt" DATETIME,
    "lastUpgradeHunt" DATETIME,
    "apiCallsThisHour" INTEGER NOT NULL DEFAULT 0,
    "apiCallsResetAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "hunt_configs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "hunt_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "huntType" TEXT NOT NULL,
    "itemsSearched" INTEGER NOT NULL DEFAULT 0,
    "itemsFound" INTEGER NOT NULL DEFAULT 0,
    "searchedItems" TEXT,
    "foundItems" TEXT,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "durationMs" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "hunt_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "hunt_search_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "mediaId" INTEGER NOT NULL,
    "seasonNumber" INTEGER,
    "title" TEXT NOT NULL,
    "huntType" TEXT NOT NULL,
    "searchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "searchCount" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "hunt_search_history_configId_fkey" FOREIGN KEY ("configId") REFERENCES "hunt_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "hunt_configs_instanceId_key" ON "hunt_configs"("instanceId");

-- CreateIndex
CREATE INDEX "hunt_logs_instanceId_huntType_startedAt_idx" ON "hunt_logs"("instanceId", "huntType", "startedAt");

-- CreateIndex
CREATE INDEX "hunt_logs_startedAt_idx" ON "hunt_logs"("startedAt");

-- CreateIndex
CREATE INDEX "hunt_search_history_configId_huntType_searchedAt_idx" ON "hunt_search_history"("configId", "huntType", "searchedAt");

-- CreateIndex
CREATE INDEX "hunt_search_history_searchedAt_idx" ON "hunt_search_history"("searchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "hunt_search_history_configId_huntType_mediaType_mediaId_seasonNumber_key" ON "hunt_search_history"("configId", "huntType", "mediaType", "mediaId", "seasonNumber");
