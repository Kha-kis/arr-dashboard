-- CreateTable
CREATE TABLE "trash_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceType" TEXT NOT NULL,
    "configType" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "commitHash" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "trash_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "serviceType" TEXT NOT NULL,
    "configData" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "sourceQualityProfileTrashId" TEXT,
    "sourceQualityProfileName" TEXT,
    "trashGuidesCommitHash" TEXT,
    "trashGuidesVersion" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" DATETIME,
    "hasUserModifications" BOOLEAN NOT NULL DEFAULT false,
    "modifiedFields" TEXT,
    "lastModifiedAt" DATETIME,
    "lastModifiedBy" TEXT,
    "changeLog" TEXT,
    "instanceOverrides" TEXT
);

-- CreateTable
CREATE TABLE "trash_sync_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "templateId" TEXT,
    "userId" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "duration" INTEGER,
    "configsApplied" INTEGER NOT NULL DEFAULT 0,
    "configsFailed" INTEGER NOT NULL DEFAULT 0,
    "configsSkipped" INTEGER NOT NULL DEFAULT 0,
    "appliedConfigs" TEXT NOT NULL,
    "failedConfigs" TEXT,
    "errorLog" TEXT,
    "backupId" TEXT,
    "rolledBack" BOOLEAN NOT NULL DEFAULT false,
    "rolledBackAt" DATETIME,
    CONSTRAINT "trash_sync_history_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "trash_sync_history_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "trash_templates" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "trash_sync_history_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "trash_backups" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "trash_backups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "backupData" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    CONSTRAINT "trash_backups_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "trash_sync_schedules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT,
    "templateId" TEXT,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "frequency" TEXT NOT NULL,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "notifyUser" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "trash_sync_schedules_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "trash_sync_schedules_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "trash_templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "trash_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "checkFrequency" INTEGER NOT NULL DEFAULT 12,
    "autoRefreshCache" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnUpdates" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnSyncFail" BOOLEAN NOT NULL DEFAULT true,
    "backupRetention" INTEGER NOT NULL DEFAULT 10,
    "backupRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "trash_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "template_quality_profile_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "qualityProfileId" INTEGER NOT NULL,
    "qualityProfileName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncStrategy" TEXT NOT NULL DEFAULT 'notify',
    CONSTRAINT "template_quality_profile_mappings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "trash_templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "template_quality_profile_mappings_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "instance_quality_profile_overrides" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "qualityProfileId" INTEGER NOT NULL,
    "customFormatId" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "instance_quality_profile_overrides_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "template_deployment_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deployedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deployedBy" TEXT NOT NULL,
    "duration" INTEGER,
    "status" TEXT NOT NULL,
    "appliedCFs" INTEGER NOT NULL DEFAULT 0,
    "failedCFs" INTEGER NOT NULL DEFAULT 0,
    "totalCFs" INTEGER NOT NULL DEFAULT 0,
    "conflictsCount" INTEGER NOT NULL DEFAULT 0,
    "appliedConfigs" TEXT,
    "failedConfigs" TEXT,
    "conflictResolutions" TEXT,
    "backupId" TEXT,
    "errorLog" TEXT,
    CONSTRAINT "template_deployment_history_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "trash_templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "template_deployment_history_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "template_deployment_history_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "trash_backups" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "trash_cache_serviceType_configType_key" ON "trash_cache"("serviceType", "configType");

-- CreateIndex
CREATE INDEX "trash_cache_serviceType_configType_idx" ON "trash_cache"("serviceType", "configType");

-- CreateIndex
CREATE INDEX "trash_cache_commitHash_idx" ON "trash_cache"("commitHash");

-- CreateIndex
CREATE INDEX "trash_templates_userId_idx" ON "trash_templates"("userId");

-- CreateIndex
CREATE INDEX "trash_templates_serviceType_idx" ON "trash_templates"("serviceType");

-- CreateIndex
CREATE INDEX "trash_templates_trashGuidesCommitHash_idx" ON "trash_templates"("trashGuidesCommitHash");

-- CreateIndex
CREATE INDEX "trash_templates_lastSyncedAt_idx" ON "trash_templates"("lastSyncedAt");

-- CreateIndex
CREATE INDEX "trash_sync_history_instanceId_idx" ON "trash_sync_history"("instanceId");

-- CreateIndex
CREATE INDEX "trash_sync_history_templateId_idx" ON "trash_sync_history"("templateId");

-- CreateIndex
CREATE INDEX "trash_sync_history_userId_idx" ON "trash_sync_history"("userId");

-- CreateIndex
CREATE INDEX "trash_sync_history_startedAt_idx" ON "trash_sync_history"("startedAt");

-- CreateIndex
CREATE INDEX "trash_backups_instanceId_idx" ON "trash_backups"("instanceId");

-- CreateIndex
CREATE INDEX "trash_backups_createdAt_idx" ON "trash_backups"("createdAt");

-- CreateIndex
CREATE INDEX "trash_backups_expiresAt_idx" ON "trash_backups"("expiresAt");

-- CreateIndex
CREATE INDEX "trash_sync_schedules_instanceId_idx" ON "trash_sync_schedules"("instanceId");

-- CreateIndex
CREATE INDEX "trash_sync_schedules_templateId_idx" ON "trash_sync_schedules"("templateId");

-- CreateIndex
CREATE INDEX "trash_sync_schedules_nextRunAt_idx" ON "trash_sync_schedules"("nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "trash_settings_userId_key" ON "trash_settings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "template_quality_profile_mappings_instanceId_qualityProfileId_key" ON "template_quality_profile_mappings"("instanceId", "qualityProfileId");

-- CreateIndex
CREATE INDEX "template_quality_profile_mappings_templateId_idx" ON "template_quality_profile_mappings"("templateId");

-- CreateIndex
CREATE INDEX "template_quality_profile_mappings_instanceId_idx" ON "template_quality_profile_mappings"("instanceId");

-- CreateIndex
CREATE INDEX "template_quality_profile_mappings_templateId_instanceId_idx" ON "template_quality_profile_mappings"("templateId", "instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "instance_quality_profile_overrides_instanceId_qualityProfileId_customFormatId_key" ON "instance_quality_profile_overrides"("instanceId", "qualityProfileId", "customFormatId");

-- CreateIndex
CREATE INDEX "instance_quality_profile_overrides_instanceId_idx" ON "instance_quality_profile_overrides"("instanceId");

-- CreateIndex
CREATE INDEX "instance_quality_profile_overrides_instanceId_qualityProfileId_idx" ON "instance_quality_profile_overrides"("instanceId", "qualityProfileId");

-- CreateIndex
CREATE INDEX "template_deployment_history_templateId_idx" ON "template_deployment_history"("templateId");

-- CreateIndex
CREATE INDEX "template_deployment_history_instanceId_idx" ON "template_deployment_history"("instanceId");

-- CreateIndex
CREATE INDEX "template_deployment_history_deployedAt_idx" ON "template_deployment_history"("deployedAt");

-- CreateIndex
CREATE INDEX "template_deployment_history_status_idx" ON "template_deployment_history"("status");
