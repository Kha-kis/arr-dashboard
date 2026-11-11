-- arr-schema-atom table:f74c690e809a3a7f3fb03752ccf55181dcc7ba126005b52296ea14f77b9fa4d5
CREATE TABLE "ArrRuntimeDataFormatReceipt" (
	"id" INTEGER NOT NULL PRIMARY KEY,
	"formatVersion" INTEGER NOT NULL,
	"dateColumnsDigest" TEXT NOT NULL,
	"completedAt" TEXT NOT NULL,
	"normalizedValues" INTEGER NOT NULL
);

-- arr-schema-atom table:e28d5706bfe0e8a5520250b3b8d0702b7828edde420e139e7c6d486ee6d611ce
CREATE TABLE "ArrSchemaMigrationReceipt"("id" TEXT NOT NULL PRIMARY KEY,"protocolVersion" INTEGER NOT NULL DEFAULT 1,"registryVersion" INTEGER NOT NULL,"provider" TEXT NOT NULL,"targetDigest" TEXT NOT NULL,"planDigest" TEXT NOT NULL,"completedAt" DATETIME NOT NULL);

-- arr-schema-atom table:f3a101e1e0d1cb7cefd2611ab0399bebf446b6fc9bc56a0b0eee2c4f0d7fd670
CREATE TABLE "NotificationOutboxDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "subscriptionEventType" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attemptOrdinal" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL,
    "attemptToken" TEXT,
    "workerEpoch" TEXT,
    "attemptConfigFingerprint" TEXT,
    "dispatchedAt" DATETIME,
    "outcomeCategory" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotificationOutboxDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationOutboxDelivery_eventId_userId_fkey" FOREIGN KEY ("eventId", "userId") REFERENCES "NotificationOutboxEvent" ("id", "userId") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- arr-schema-atom table:876fb817c572bd71b39f8a74affbcb0e3177ad02ae7cce7e243e008f1385d618
CREATE TABLE "NotificationOutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "payloadIv" TEXT NOT NULL,
    "dedupFingerprint" TEXT NOT NULL,
    "scopeFingerprint" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "aggregationWindowSeconds" INTEGER,
    "maxBatchSize" INTEGER,
    "aggregateParentId" TEXT,
    "destinationInstallationId" TEXT NOT NULL,
    "restoreCommitId" TEXT,
    "acceptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotificationOutboxEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationOutboxEvent_aggregateParentId_userId_fkey" FOREIGN KEY ("aggregateParentId", "userId") REFERENCES "NotificationOutboxEvent" ("id", "userId") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- arr-schema-atom table:464c19fd7bd64143665eab95a9f4a3d4dd9fb2ab2a97c77dce22c0fcfe8bece9
CREATE TABLE "RestoreRuntimeControl" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "protocolVersion" INTEGER NOT NULL DEFAULT 1,
    "phase" TEXT NOT NULL,
    "runtimeEpoch" TEXT,
    "ownerBackendPid" INTEGER,
    "activeRestoreId" TEXT,
    "lastCommittedRestoreId" TEXT,
    "lastCommittedAt" DATETIME,
    "destinationInstallationId" TEXT
);

-- arr-schema-atom table:cdf087e4f6df1eab1e85766270a81aaba81c71e7d90d15be2c24950e4a9c8b4c
CREATE TABLE "SearchGrabAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "serviceInstanceId" TEXT NOT NULL,
    "connectionFingerprint" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "encryptedTarget" TEXT NOT NULL,
    "targetIv" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'prepared',
    "outcomeCategory" TEXT,
    "workerEpoch" TEXT,
    "predecessorId" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "dispatchedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "SearchGrabAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SearchGrabAttempt_predecessorId_userId_fkey" FOREIGN KEY ("predecessorId", "userId") REFERENCES "SearchGrabAttempt" ("id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- arr-schema-atom table:99e26350e997bdcb70b75aedc5e2b9f816c44e0def71fab3551cec7963ca07cd
CREATE TABLE "SearchGrabClaim" (
    "userId" TEXT NOT NULL,
    "serviceInstanceId" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "serviceInstanceId", "targetHash"),
    CONSTRAINT "SearchGrabClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SearchGrabClaim_serviceInstanceId_userId_fkey" FOREIGN KEY ("serviceInstanceId", "userId") REFERENCES "ServiceInstance" ("id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "SearchGrabClaim_attemptId_userId_fkey" FOREIGN KEY ("attemptId", "userId") REFERENCES "SearchGrabAttempt" ("id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- arr-schema-atom table:655838d81cb3106b0c905ec1aafb9defa937471e5dbd11363b25aae57ed30782
CREATE TABLE "ServiceInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "externalUrl" TEXT,
    "encryptedApiKey" TEXT NOT NULL,
    "encryptionIv" TEXT NOT NULL,
    "encryptedHttpAuthCredentials" TEXT,
    "httpAuthEncryptionIv" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "storageGroupId" TEXT,
    "hasLocalFilesystemAccess" BOOLEAN NOT NULL DEFAULT false,
    "pathPrefix" TEXT,
    "connectionGeneration" INTEGER NOT NULL DEFAULT 0,
    "expectedIdentity" TEXT,
    "identityKind" TEXT,
    "identityStatus" TEXT NOT NULL DEFAULT 'unverified',
    "identityGeneration" INTEGER NOT NULL DEFAULT 0,
    "identityVerifiedAt" DATETIME,
    "identityLastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ServiceInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:e05cf5913aa2f9439d8df0202a5035a0a686ce95761801571fe5b7c57d868239
CREATE TABLE "ServiceInstanceTag" (
    "instanceId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("instanceId", "tagId"),
    CONSTRAINT "ServiceInstanceTag_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceInstanceTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "ServiceTag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:48af2c1f39a597817cd60780e52c41ee1db7ad671ae2ac7f2c58e1b5bbe130e6
CREATE TABLE "ServiceTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- arr-schema-atom table:3e36e0ad3a71e1ccf159e1777e3583c2fd9f5d4b0139851b8213fcad6abc26e0
CREATE TABLE "SqliteRestoreStorageBinding" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "protocolVersion" INTEGER NOT NULL DEFAULT 1,
    "databaseDevice" TEXT NOT NULL,
    "databaseInode" TEXT NOT NULL,
    "directoryDevice" TEXT NOT NULL,
    "directoryInode" TEXT NOT NULL,
    "coordinationDevice" TEXT NOT NULL,
    "coordinationInode" TEXT NOT NULL,
    "ownerDevice" TEXT NOT NULL,
    "ownerInode" TEXT NOT NULL,
    "operationsDevice" TEXT NOT NULL,
    "operationsInode" TEXT NOT NULL
);

-- arr-schema-atom table:8f16f9135b06d3f9ab27aef1d73e431dca6b0f41ad227ae151e86148a7597f5c
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "hashedPassword" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "encryptedTmdbApiKey" TEXT,
    "tmdbEncryptionIv" TEXT,
    "hashedWebhookSecret" TEXT,
    "hashedQuiWebhookSecret" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "encryptedTraktAccessToken" TEXT,
    "traktTokenIv" TEXT
);

-- arr-schema-atom table:74ef28c8a6d4faec12d91b4e7fbf2870e0867034376a96850ba8cc16110e0bef
CREATE TABLE "arr_import_file_proofs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operationId" TEXT NOT NULL,
    "fileFingerprint" TEXT NOT NULL,
    "downloadKey" TEXT NOT NULL,
    "identityJson" JSONB NOT NULL,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "arr_import_file_proofs_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "arr_import_operations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:725fec7a306631c2a8bf406fcf6d00efd7ea9c0b15cf6229acf8fc5ce9586cca
CREATE TABLE "arr_import_operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "instanceId" TEXT,
    "originalInstanceId" TEXT NOT NULL,
    "connectionFingerprint" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "commandFingerprint" TEXT NOT NULL,
    "encryptedSources" TEXT NOT NULL,
    "sourcesEncryptionIv" TEXT NOT NULL,
    "legacyReceiptId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'preparing',
    "reason" TEXT,
    "commandId" INTEGER,
    "commandState" TEXT,
    "commandTerminal" BOOLEAN NOT NULL DEFAULT false,
    "selectedFileCount" INTEGER NOT NULL,
    "verifiedFileCount" INTEGER NOT NULL DEFAULT 0,
    "preparationExpiresAt" DATETIME NOT NULL,
    "submissionStartedAt" DATETIME,
    "lastCheckedAt" DATETIME,
    "nextCheckAt" DATETIME,
    "reconcileToken" TEXT,
    "reconcileExpiresAt" DATETIME,
    "reconcileCursor" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "arr_import_operations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "arr_import_operations_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- arr-schema-atom table:638fe647e6df83071ac5c45cd06385a2b0f745f10bbb108ce4203053bef9b35c
CREATE TABLE "arr_import_source_claims" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "downloadKey" TEXT NOT NULL,
    "activeOperationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "arr_import_source_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:8214fbf5d3578f2b21da9751051ad8ff06055949bd7e1f102a39a27e7e4487ec
CREATE TABLE "auto_tag_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ruleType" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "operator" TEXT,
    "conditions" TEXT,
    "serviceFilter" TEXT,
    "instanceFilter" TEXT,
    "excludeTags" TEXT,
    "excludeTitles" TEXT,
    "plexLibraryFilter" TEXT,
    "tagName" TEXT NOT NULL,
    "lastRunAt" DATETIME,
    "lastRunStatus" TEXT,
    "lastRunMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "auto_tag_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:095aa8e4a4892484a5ed1ffd9ce9708ca87a233d1f7189a3dd7ec9a8a8a95096
CREATE TABLE "backup_settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalType" TEXT NOT NULL DEFAULT 'DISABLED',
    "intervalValue" INTEGER NOT NULL DEFAULT 24,
    "retentionCount" INTEGER NOT NULL DEFAULT 7,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "encryptedPassword" TEXT,
    "passwordIv" TEXT,
    "includeTrashBackups" BOOLEAN NOT NULL DEFAULT false
);

-- arr-schema-atom table:20762bbeedeafee6cf7fe0d2d43acacd5f0272aee67335f4c3b7627a48e5b681
CREATE TABLE "cache_refresh_status" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "cacheType" TEXT NOT NULL,
    "lastRefreshedAt" DATETIME NOT NULL,
    "lastResult" TEXT NOT NULL,
    "lastErrorMessage" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "generationId" TEXT,
    "generationMetadata" TEXT,
    "lastAttemptAt" DATETIME,
    "lastAttemptResult" TEXT,
    "lastAttemptErrorMessage" TEXT,
    "connectionGeneration" INTEGER,
    "identityGeneration" INTEGER,
    CONSTRAINT "cache_refresh_status_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:57b3570e958517f1d6fc9b89de55d950f902cfeca9ada01dcbabd0e4b9cfb334
CREATE TABLE "dashboard_statistics_snapshots" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "sourceFingerprint" TEXT,
    "payload" TEXT,
    "result" TEXT,
    "observedAt" DATETIME,
    "claimFingerprint" TEXT,
    "claimToken" TEXT,
    "leaseUntil" DATETIME,
    "retryAt" DATETIME,
    "retryFingerprint" TEXT,
    "lastFailureCategory" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "dashboard_statistics_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:cbb60ffe7472b411a1578d118ffe02db911d552445e5139ab7fa0749309ee341
CREATE TABLE "episode_file_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "arrEpisodeFileId" INTEGER NOT NULL,
    "arrSeriesId" INTEGER NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "relativePath" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "qualityName" TEXT,
    "releaseGroup" TEXT,
    "infoHash" TEXT,
    "infoHashSource" TEXT,
    "inodeBackfillRetryAfter" DATETIME,
    "torrentState" TEXT,
    "torrentRatio" REAL,
    "torrentSyncedAt" DATETIME,
    "cachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "episode_file_cache_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:3790baee53d7c8d01cc6be39482304e0935d84e5b1f50e7b857615e424def3d6
CREATE TABLE "history_collection_leases" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "claimToken" TEXT,
    "claimedAt" DATETIME,
    "heartbeatAt" DATETIME,
    "expiresAt" DATETIME,
    "lastAttemptAt" DATETIME,
    "lastAttemptResult" TEXT,
    "lastAttemptReason" TEXT,
    "nextSourceCursor" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "history_collection_leases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:7b843401ab5cada00662958fcf7b1c751b2f029d601859622e9a93afc1c89cda
CREATE TABLE "history_observations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "providerEventId" INTEGER NOT NULL,
    "eventAt" DATETIME NOT NULL,
    "eventTypeKey" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "normalizedPayload" TEXT NOT NULL,
    "firstObservedAt" DATETIME NOT NULL,
    "lastObservedAt" DATETIME NOT NULL,
    CONSTRAINT "history_observations_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- arr-schema-atom table:7039ef57bab6dc3440e3152ebc507dccef4cdeab3ecbfb9d9af1cba3f04c359c
CREATE TABLE "history_source_statuses" (
    "instanceId" TEXT NOT NULL PRIMARY KEY,
    "connectionGeneration" INTEGER NOT NULL,
    "publishedAt" DATETIME,
    "publicationMetadata" TEXT,
    "retainedObservationCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" DATETIME,
    "lastAttemptResult" TEXT,
    "lastAttemptReason" TEXT,
    "publicationRevision" INTEGER NOT NULL DEFAULT 0,
    "retentionEpoch" INTEGER NOT NULL DEFAULT 0,
    "collectHeadNext" BOOLEAN NOT NULL DEFAULT true,
    "nextBackfillPage" INTEGER NOT NULL DEFAULT 2,
    "activeCollectionPage" INTEGER,
    CONSTRAINT "history_source_statuses_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- arr-schema-atom table:948153c59d7f599bfddaef5c27dc558b39df2e96a7e3a32b308fcdb9e0a90c24
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
    "preferSeasonPacks" BOOLEAN NOT NULL DEFAULT false,
    "upgradeSearchAll" BOOLEAN NOT NULL DEFAULT false,
    "researchAfterDays" INTEGER NOT NULL DEFAULT 7,
    "lastMissingHunt" DATETIME,
    "lastUpgradeHunt" DATETIME,
    "apiCallsThisHour" INTEGER NOT NULL DEFAULT 0,
    "apiCallsResetAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "hunt_configs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:fe4d1352f218292c8456f8d6122c06106bb71b44469850df8a045626fae4d1c4
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

-- arr-schema-atom table:01b012e1a928ded7b436b6904d6f0ab5a1b8eab146b8e7e323a16510823627bb
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

-- arr-schema-atom table:05f6c289e5de12767601861b42821c86e95d0a86528f5d4347d0590469e64d26
CREATE TABLE "inode_index_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "builtAt" DATETIME NOT NULL,
    "filesIndexed" INTEGER NOT NULL,
    "serializedData" BLOB NOT NULL,
    CONSTRAINT "inode_index_cache_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:0b70a22b7fff22fdaf69236fb201fd5b0c58164a1b297caef8dde9eb71c865c6
CREATE TABLE "instance_quality_profile_overrides" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "qualityProfileId" INTEGER NOT NULL,
    "customFormatId" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "intentOperation" TEXT,
    "intendedScore" INTEGER,
    "userId" TEXT NOT NULL,
    "connectionGeneration" INTEGER NOT NULL DEFAULT 0,
    "connectionStateToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "instance_quality_profile_overrides_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:41d8e80d1750f4d81b9a12f0e04c03ea470b8835aa35f560095cf06e04fad49a
CREATE TABLE "jellyfin_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "libraryName" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "jellyfinId" TEXT,
    "lastWatchedAt" DATETIME,
    "watchCount" INTEGER NOT NULL DEFAULT 0,
    "watchedByUsers" TEXT NOT NULL,
    "onDeck" BOOLEAN NOT NULL DEFAULT false,
    "userRating" REAL,
    "collections" TEXT NOT NULL,
    "addedAt" DATETIME,
    "thumb" TEXT,
    "connectionGeneration" INTEGER,
    "identityGeneration" INTEGER,
    CONSTRAINT "jellyfin_cache_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:50f5a42a11e135259270f3928a97d92739ec836c481f22184c2500bd46f5b258
CREATE TABLE "jellyfin_episode_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "showTmdbId" INTEGER NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "jellyfinId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "watched" BOOLEAN NOT NULL,
    "watchedByUsers" TEXT NOT NULL,
    "lastWatchedAt" DATETIME,
    "connectionGeneration" INTEGER,
    "identityGeneration" INTEGER,
    CONSTRAINT "jellyfin_episode_cache_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:ae3f850189a6ee80f30817d912e8f314f503908e66b71580e5ca07da1b353427
CREATE TABLE "jellyfin_episode_generation_rows" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "showTmdbId" INTEGER NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "jellyfinId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "watched" BOOLEAN NOT NULL,
    "watchedByUsers" TEXT NOT NULL,
    "lastWatchedAt" DATETIME,
    "connectionGeneration" INTEGER NOT NULL,
    "identityGeneration" INTEGER NOT NULL,
    CONSTRAINT "jellyfin_episode_generation_rows_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:d239b8d711ad038b9225593e527e840ebd2f89e6fab423950594495ee37e35d4
CREATE TABLE "jellyfin_episode_generation_show_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "showTmdbId" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "contentFingerprint" TEXT NOT NULL,
    "mappedProgressJson" TEXT,
    CONSTRAINT "jellyfin_episode_generation_show_receipts_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:ed97d9ff851a4247be948243904f5364f89c137e4f93b7bbc2043053c62c9414
CREATE TABLE "jellyfin_episode_observation_exclusions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "userKeyDigest" TEXT NOT NULL,
    "pass" TEXT NOT NULL,
    "jellyfinId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    CONSTRAINT "jellyfin_episode_observation_exclusions_runId_unitId_fkey" FOREIGN KEY ("runId", "unitId") REFERENCES "provider_observation_units" ("runId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:11851ab04db327c31f5ca0de6c8286e5ccd32a1c2148edd7bb0fd790f05c0381
CREATE TABLE "jellyfin_episode_observation_stage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "userKeyDigest" TEXT NOT NULL,
    "pass" TEXT NOT NULL,
    "jellyfinId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "played" BOOLEAN NOT NULL,
    "playCount" INTEGER,
    "lastPlayedAt" DATETIME,
    "userName" TEXT NOT NULL,
    CONSTRAINT "jellyfin_episode_observation_stage_runId_unitId_fkey" FOREIGN KEY ("runId", "unitId") REFERENCES "provider_observation_units" ("runId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:2a4cd557b8e2d3a79333c023c8b9426749d297f4835d3635ccf0df99e792a9c0
CREATE TABLE "jellyfin_episode_preparations" (
    "runId" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "leaseExpiresAt" DATETIME NOT NULL,
    "state" TEXT NOT NULL,
    "expectedRowCount" INTEGER,
    "expectedReceiptCount" INTEGER,
    "contentFingerprint" TEXT,
    "observedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "jellyfin_episode_preparations_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "jellyfin_episode_preparations_runId_fkey" FOREIGN KEY ("runId") REFERENCES "provider_observation_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:edcfd043aa80d456571f1cdc2796aaed115add5754241bb03edcd432572e17aa
CREATE TABLE "jellyfin_native_watch_publications" (
    "instanceId" TEXT NOT NULL PRIMARY KEY,
    "activeRunId" TEXT NOT NULL,
    "activeCacheGenerationId" TEXT NOT NULL,
    "activeObservedAt" DATETIME NOT NULL,
    "activeExpectedScopeCount" INTEGER NOT NULL,
    "previousRunId" TEXT,
    "previousObservedAt" DATETIME,
    "previousExpectedScopeCount" INTEGER,
    "connectionGeneration" INTEGER NOT NULL,
    "identityGeneration" INTEGER NOT NULL,
    CONSTRAINT "jellyfin_native_watch_publications_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:27910e892ee660eadba521e1d6dd2d40f0aecece8086e050fe7c6d2fb8b797e1
CREATE TABLE "jellyfin_native_watch_rows" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userKeyDigest" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "jellyfinId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "played" BOOLEAN NOT NULL,
    "playCount" INTEGER,
    "lastPlayedAt" DATETIME,
    "observedAt" DATETIME NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "identityGeneration" INTEGER NOT NULL,
    CONSTRAINT "jellyfin_native_watch_rows_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:8d0fdf6c9996723b695a71686e8e442692ebb6213c0a4acd9b4e56553f4e6dca
CREATE TABLE "jellyfin_native_watch_scope_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userKeyDigest" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "expectedRawCount" INTEGER NOT NULL,
    "observedRawCount" INTEGER NOT NULL,
    "exact" BOOLEAN NOT NULL,
    "contentFingerprint" TEXT NOT NULL,
    "diagnosticsJson" TEXT,
    "observedAt" DATETIME NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "identityGeneration" INTEGER NOT NULL,
    CONSTRAINT "jellyfin_native_watch_scope_receipts_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:b09c7d72e123675251ce846555b4013751d9afd35eda03a540fb4f9ec7349b0d
CREATE TABLE "jellyfin_positive_watch_rows" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "userKeyDigest" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "jellyfinId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "playCount" INTEGER,
    "lastPlayedAt" DATETIME,
    "observedAt" DATETIME NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "identityGeneration" INTEGER NOT NULL,
    CONSTRAINT "jellyfin_positive_watch_rows_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:3444ed27163ee6a246e51d7b6c611b789ca9c66d74a81ada9fd1632ed45b459f
CREATE TABLE "label_sync_mutation_attempts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "destinationInstanceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "identityGeneration" INTEGER NOT NULL,
    "targetItemId" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "intentFingerprint" TEXT NOT NULL,
    "ruleFingerprint" TEXT NOT NULL,
    "destinationTag" TEXT NOT NULL,
    "activeOperationKey" TEXT,
    "claimToken" TEXT,
    "sendAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "reconcileAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "requestStartedAt" DATETIME,
    "lastObservedAt" DATETIME,
    "completedAt" DATETIME,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT,
    "restoreEvidence" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "label_sync_mutation_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "label_sync_mutation_attempts_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "label_sync_rules" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "label_sync_mutation_attempts_destinationInstanceId_fkey" FOREIGN KEY ("destinationInstanceId") REFERENCES "ServiceInstance" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- arr-schema-atom table:8696bd55de0d1e68a5d15c0e7b5f4fc5745968a281720ab56d7d277d70183f19
CREATE TABLE "label_sync_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sourceService" TEXT NOT NULL,
    "sourceInstanceId" TEXT,
    "sourceTagName" TEXT NOT NULL,
    "destService" TEXT NOT NULL DEFAULT 'plex',
    "destInstanceId" TEXT NOT NULL,
    "destTagName" TEXT NOT NULL,
    "lastRunAt" DATETIME,
    "lastRunStatus" TEXT,
    "lastRunMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "label_sync_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:843117eed2dde069680f87ecdcebc89815de326330c2e9e0f66512097bd9139b
CREATE TABLE "library_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "arrItemId" INTEGER NOT NULL,
    "itemType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleSlug" TEXT,
    "sortTitle" TEXT,
    "year" INTEGER,
    "monitored" BOOLEAN NOT NULL DEFAULT true,
    "hasFile" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT,
    "qualityProfileId" INTEGER,
    "qualityProfileName" TEXT,
    "sizeOnDisk" BIGINT NOT NULL DEFAULT 0,
    "cutoffUnmet" BOOLEAN NOT NULL DEFAULT false,
    "infoHash" TEXT,
    "infoHashSource" TEXT,
    "pathBackfillRetryAfter" DATETIME,
    "torrentState" TEXT,
    "torrentRatio" REAL,
    "torrentSyncedAt" DATETIME,
    "data" TEXT NOT NULL,
    "episodeFileInventoryReceipt" TEXT,
    "episodeFileInventoryAttemptedAt" DATETIME,
    "episodeFileInventoryAttemptToken" TEXT,
    "arrAddedAt" DATETIME,
    "arrUpdatedAt" DATETIME,
    "cachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "library_cache_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:499166bf5d6a7d4944ab0b0273d5612b498a95c366be236264245dd7a1758705
CREATE TABLE "library_cleanup_approvals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "arrItemId" INTEGER NOT NULL,
    "itemType" TEXT NOT NULL,
    "targetScope" TEXT NOT NULL DEFAULT 'series',
    "arrEpisodeId" INTEGER,
    "episodeFileId" INTEGER,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "episodeTitle" TEXT,
    "title" TEXT NOT NULL,
    "matchedRuleId" TEXT NOT NULL,
    "matchedRuleName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "action" TEXT DEFAULT 'delete',
    "scanMediaServerAfterDelete" BOOLEAN NOT NULL DEFAULT false,
    "sizeOnDisk" BIGINT NOT NULL,
    "year" INTEGER,
    "rating" REAL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "executionToken" TEXT,
    "executionAuditCorrelationId" TEXT,
    "reconciledWithoutMutation" BOOLEAN NOT NULL DEFAULT false,
    "terminalAuditRecordedAt" DATETIME,
    "terminalAuditRecoveryAttemptedAt" DATETIME,
    "safetySnapshot" TEXT,
    "lastExecutionError" TEXT,
    "reviewedAt" DATETIME,
    "executedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "library_cleanup_approvals_configId_fkey" FOREIGN KEY ("configId") REFERENCES "library_cleanup_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:f34f2097e3db01c9f7941e5223edb6360e991d74faf0b992de8fdac32c03cd96
CREATE TABLE "library_cleanup_audit_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "configId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "approvalId" TEXT,
    "runLogId" TEXT,
    "instanceId" TEXT NOT NULL,
    "arrItemId" INTEGER NOT NULL,
    "itemType" TEXT NOT NULL,
    "targetScope" TEXT NOT NULL,
    "arrEpisodeId" INTEGER,
    "title" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleName" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT,
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "library_cleanup_audit_events_configId_fkey" FOREIGN KEY ("configId") REFERENCES "library_cleanup_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:b1a2dbf97cefb82b8c2a32702f42ec1448dac9197a497c5ef99373e381674814
CREATE TABLE "library_cleanup_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalHours" INTEGER NOT NULL DEFAULT 24,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "dryRunMode" BOOLEAN NOT NULL DEFAULT true,
    "maxRemovalsPerRun" INTEGER NOT NULL DEFAULT 50,
    "requireApproval" BOOLEAN NOT NULL DEFAULT false,
    "runClaimToken" TEXT,
    "runClaimedAt" DATETIME,
    "respectQuiSeeding" BOOLEAN NOT NULL DEFAULT false,
    "rejectionMemoryDays" INTEGER DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "library_cleanup_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:7b35c8ba816bc435dc7f04d1af14a8bbf960043c8ad33925aee8fcc31b53e563
CREATE TABLE "library_cleanup_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL,
    "isDryRun" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "itemsEvaluated" INTEGER NOT NULL,
    "itemsFlagged" INTEGER NOT NULL,
    "itemsRemoved" INTEGER NOT NULL,
    "itemsUnmonitored" INTEGER NOT NULL,
    "itemsFilesDeleted" INTEGER NOT NULL,
    "itemsSkipped" INTEGER NOT NULL,
    "details" TEXT,
    "error" TEXT,
    "prefetchHealth" TEXT,
    "warnings" TEXT,
    "durationMs" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "library_cleanup_logs_configId_fkey" FOREIGN KEY ("configId") REFERENCES "library_cleanup_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:a33080c7f3d06b9b6e424d05d28aff3b42ec3d2d2a88afc7d71049bdf8a64dd6
CREATE TABLE "library_cleanup_media_server_scan_leases" (
    "operationKey" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "executionToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- arr-schema-atom table:8815b6770284ff3f2267fc75c3d55c67afb94ace177cdd5b1ec9e9e9f24a96c1
CREATE TABLE "library_cleanup_media_server_scans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "approvalId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "serverIdentity" TEXT,
    "mediaType" TEXT NOT NULL,
    "plannedSectionIds" TEXT,
    "targetKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "executionToken" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "completedSectionIds" TEXT NOT NULL DEFAULT '[]',
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "requestStartedAt" DATETIME,
    "triggeredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "library_cleanup_media_server_scans_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "library_cleanup_approvals" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:7f3b61996973d74847888bec50ed09c37ed089e2fdfbb2454bcb3fddd5ed8718
CREATE TABLE "library_cleanup_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "ruleType" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "serviceFilter" TEXT,
    "instanceFilter" TEXT,
    "excludeTags" TEXT,
    "excludeTitles" TEXT,
    "plexLibraryFilter" TEXT,
    "targetScope" TEXT NOT NULL DEFAULT 'series',
    "action" TEXT NOT NULL DEFAULT 'delete',
    "scanMediaServerAfterDelete" BOOLEAN NOT NULL DEFAULT false,
    "operator" TEXT,
    "conditions" TEXT,
    "retentionMode" BOOLEAN NOT NULL DEFAULT false,
    "useGlobalRejectionMemory" BOOLEAN NOT NULL DEFAULT true,
    "rejectionMemoryDays" INTEGER DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "library_cleanup_rules_configId_fkey" FOREIGN KEY ("configId") REFERENCES "library_cleanup_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:4b5438244ae650e3234b8768ef53bff1a63cbfbd33f23a353a3c9755f3ddb265
CREATE TABLE "library_sync_status" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "lastFullSync" DATETIME,
    "lastIncrementalSync" DATETIME,
    "syncInProgress" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncDurationMs" INTEGER,
    "lastError" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "pollingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "pollingIntervalMins" INTEGER NOT NULL DEFAULT 15,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "library_sync_status_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:6aa80b0bfba55d4bd07beed1feebaa25e3a747b983d82bdcd8a355786a4eefb1
CREATE TABLE "list_cache_refresh_status" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "listKey" TEXT NOT NULL,
    "generationId" TEXT,
    "lastRefreshedAt" DATETIME,
    "lastResult" TEXT,
    "lastErrorMessage" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" DATETIME,
    "lastAttemptResult" TEXT,
    "lastAttemptErrorMessage" TEXT,
    CONSTRAINT "list_cache_refresh_status_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:2bf94b2ba6ac6026e534724eea646f20a53b064336f7bd51280f834abab091cb
CREATE TABLE "naming_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "selectedPresets" TEXT NOT NULL,
    "syncStrategy" TEXT NOT NULL DEFAULT 'manual',
    "lastDeployedAt" DATETIME,
    "lastDeployedHash" TEXT,
    "lastDeployStatus" TEXT,
    "lastDeployError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "naming_configs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "naming_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:9809a3cdb29c50a40248bed3f45259f35145281a5b10166606cfd4a61dbaefc4
CREATE TABLE "naming_deploy_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deployedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "selectedPresets" TEXT NOT NULL,
    "resolvedPayload" TEXT NOT NULL,
    "deployedHash" TEXT,
    "previousConfig" TEXT,
    "changedFields" INTEGER NOT NULL,
    "totalFields" INTEGER NOT NULL,
    "errorMessage" TEXT,
    "rolledBack" BOOLEAN NOT NULL DEFAULT false,
    "rolledBackAt" DATETIME,
    CONSTRAINT "naming_deploy_history_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "naming_deploy_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:c29ad828f0a4086f2707a024d9c9e83b685e6d90203884c473db57e83e765a2a
CREATE TABLE "notification_aggregation_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "windowSeconds" INTEGER NOT NULL DEFAULT 300,
    "maxBatchSize" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "notification_aggregation_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:2fa368efe14f76928709cdd18c111aaa396c6c75964b5df6fd2ece57601c1bd6
CREATE TABLE "notification_channels" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "encryptedConfig" TEXT NOT NULL,
    "configIv" TEXT NOT NULL,
    "lastTestedAt" DATETIME,
    "lastTestResult" TEXT,
    "lastSentAt" DATETIME,
    "lastSendResult" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "notification_channels_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:571f351a63760bef1ce1dc2619589754452be7cb381ac0b8a5c12a2aa12962eb
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- arr-schema-atom table:2df2bf5e43a10b6dd756c8d39c9128a0c927bce8bd9c36bc499ff806bbf2a5b1
CREATE TABLE "notification_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "action" TEXT NOT NULL,
    "conditions" TEXT NOT NULL,
    "targetChannelIds" TEXT,
    "throttleMinutes" INTEGER,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "quietHoursTimezone" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "notification_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:06effce1ed2a5fb3438b85a7729327c4bc18b7b9fb47b2a934eef977be5ee1e2
CREATE TABLE "notification_subscriptions" (
    "channelId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    CONSTRAINT "notification_subscriptions_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "notification_channels" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:af01d256e37d34d6561e377d7539853b5f85dd1183eeb2f0bc3ebe67b14577b0
CREATE TABLE "oidc_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "providerEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "oidc_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:df5ccdaecd321d81f9fe3a64a493104592771e1c40e8bb0d4e2344323c13bb74
CREATE TABLE "oidc_providers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
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

-- arr-schema-atom table:b3512c61858ed83551de55eaf966697a2ed8ed91b08c9ee582f977f133d12ab8
CREATE TABLE "plex_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "sectionTitle" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "ratingKey" TEXT,
    "lastWatchedAt" DATETIME,
    "watchCount" INTEGER NOT NULL DEFAULT 0,
    "watchedByUsers" TEXT NOT NULL,
    "onDeck" BOOLEAN NOT NULL DEFAULT false,
    "userRating" REAL,
    "collections" TEXT NOT NULL,
    "labels" TEXT NOT NULL,
    "addedAt" DATETIME,
    "thumb" TEXT,
    "connectionGeneration" INTEGER,
    "identityGeneration" INTEGER,
    CONSTRAINT "plex_cache_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:4e73f5613ef6fa2c78b5600d832f538d09cf1fda8ad99d6a5bac89f7e8f5f69e
CREATE TABLE "plex_episode_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "showTmdbId" INTEGER NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "ratingKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "watched" BOOLEAN NOT NULL,
    "watchedByUsers" TEXT NOT NULL,
    "lastWatchedAt" DATETIME,
    "watchCount" INTEGER,
    "refreshedAt" DATETIME,
    "sourceFingerprint" TEXT,
    "connectionGeneration" INTEGER,
    "identityGeneration" INTEGER,
    CONSTRAINT "plex_episode_cache_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:9206c666032a3bef36f52aaea8c1695e828f0dc3c76980e2bb679e63254766e4
CREATE TABLE "plex_episode_observation_stage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "showTmdbId" INTEGER NOT NULL,
    "parentRatingKey" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "ratingKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "watched" BOOLEAN NOT NULL,
    "watchedByUsers" TEXT NOT NULL,
    "lastWatchedAt" DATETIME,
    "watchCount" INTEGER NOT NULL,
    "refreshedAt" DATETIME NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    CONSTRAINT "plex_episode_observation_stage_runId_unitId_fkey" FOREIGN KEY ("runId", "unitId") REFERENCES "provider_observation_units" ("runId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:9c593a091a3ebd4f99cb2a8d254ffd36c99af9f5a57cc188616306f357593451
CREATE TABLE "plex_generation_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "sectionUuid" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "tvdbId" INTEGER,
    "ratingKey" TEXT NOT NULL,
    CONSTRAINT "plex_generation_targets_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:afa247c079aa687102a81779a1a7cdb612fab36c3cd012a4f106415a5f7f1d17
CREATE TABLE "provider_native_inventory_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "nativeId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "libraryIds" TEXT NOT NULL,
    "parentNativeId" TEXT,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "title" TEXT NOT NULL DEFAULT '',
    "externalIds" TEXT,
    CONSTRAINT "provider_native_inventory_items_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "provider_native_inventory_snapshots" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:6c68a6f08d525b84c97cec031e0db96353b15a84a2048a8389d31a6f437eeb40
CREATE TABLE "provider_native_inventory_page_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "passId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "pageKey" TEXT NOT NULL,
    "startIndex" INTEGER NOT NULL,
    "nextCursor" TEXT,
    "isLast" BOOLEAN NOT NULL,
    "expectedRawCount" INTEGER NOT NULL,
    "rawCount" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_native_inventory_page_receipts_passId_fkey" FOREIGN KEY ("passId") REFERENCES "provider_native_inventory_passes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:81e3f5dedfe8db202f5e980f8462ac72fe7a382040deeca2d9afa6792c256fdd
CREATE TABLE "provider_native_inventory_passes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'collecting',
    "scopeManifest" TEXT,
    "scopeDigest" TEXT,
    "comparisonDigest" TEXT,
    "libraryItemCount" INTEGER,
    "episodeItemCount" INTEGER,
    "pageRevision" INTEGER NOT NULL DEFAULT 0,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "provider_native_inventory_passes_runId_fkey" FOREIGN KEY ("runId") REFERENCES "provider_native_inventory_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:802e2b638aa59589ba0102c8478ef12d4c91d685434a3f3cf75687d6b0b2cf08
CREATE TABLE "provider_native_inventory_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "workKey" TEXT NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "identityGeneration" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "activeSlotKey" TEXT,
    "passOrdinal" INTEGER NOT NULL DEFAULT 1,
    "claimToken" TEXT,
    "leaseUntil" DATETIME,
    "nextAttemptAt" DATETIME,
    "lastFailureCategory" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "provider_native_inventory_runs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:b9767a10ee306e3e3ee89555fc60647af31ead00f66d8bb56f9cd7f815be5662
CREATE TABLE "provider_native_inventory_seen_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "passId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "nativeId" TEXT NOT NULL,
    "comparisonKey" TEXT,
    CONSTRAINT "provider_native_inventory_seen_items_passId_fkey" FOREIGN KEY ("passId") REFERENCES "provider_native_inventory_passes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:830eb0d0bbd9ac4579b5b1c6d1caac324f3eb5fe33dba5a8b912e9ba1315a826
CREATE TABLE "provider_native_inventory_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "generationId" TEXT,
    "observedAt" DATETIME,
    "connectionGeneration" INTEGER,
    "identityGeneration" INTEGER,
    "scopeDigest" TEXT,
    "contentDigest" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "scopeCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" DATETIME,
    "lastAttemptToken" TEXT,
    "lastAttemptResult" TEXT NOT NULL DEFAULT 'unknown',
    "lastAttemptReason" TEXT,
    "publishedPassId" TEXT,
    CONSTRAINT "provider_native_inventory_snapshots_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "provider_native_inventory_snapshots_publishedPassId_fkey" FOREIGN KEY ("publishedPassId") REFERENCES "provider_native_inventory_passes" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- arr-schema-atom table:1b19499efcd79c65f807db4aa604e46477297814a358da444f3ed109d34635fd
CREATE TABLE "provider_native_inventory_stage_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "passId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "nativeId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "libraryIds" TEXT NOT NULL,
    "parentNativeId" TEXT,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "title" TEXT NOT NULL DEFAULT '',
    "externalIds" TEXT,
    CONSTRAINT "provider_native_inventory_stage_items_passId_fkey" FOREIGN KEY ("passId") REFERENCES "provider_native_inventory_passes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:25cae406cabc93d969e276eb0bbf86901fa209172fbc074e5f083c4567cf1114
CREATE TABLE "provider_observation_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "cacheType" TEXT NOT NULL,
    "authorityKey" TEXT NOT NULL,
    "activeSlotKey" TEXT,
    "parentGenerationId" TEXT,
    "targetDigest" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "connectionGeneration" INTEGER NOT NULL,
    "identityGeneration" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "totalUnits" INTEGER NOT NULL,
    "completedUnits" INTEGER NOT NULL DEFAULT 0,
    "totalWork" INTEGER NOT NULL,
    "completedWork" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "lastReasonCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "provider_observation_runs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:29b5be48b4865b4aacb6c18551c7dc68330afbd932a69d2087a3db84f7d6f587
CREATE TABLE "provider_observation_units" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "scopeDigest" TEXT NOT NULL,
    "scopePayload" TEXT,
    "phase" TEXT NOT NULL,
    "expectedTargets" INTEGER NOT NULL,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "expectedRawCount" INTEGER,
    "observedRawCount" INTEGER NOT NULL DEFAULT 0,
    "completedPages" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL,
    "claimToken" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "lastReasonCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "provider_observation_units_runId_fkey" FOREIGN KEY ("runId") REFERENCES "provider_observation_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:6ad72bf99e27797970361854291bc641b8b6a8a1d72fd62f1d9a0d1c7bb2e337
CREATE TABLE "quality_size_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "presetTrashId" TEXT NOT NULL,
    "presetType" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "syncStrategy" TEXT NOT NULL DEFAULT 'manual',
    "appliedDataHash" TEXT,
    "lastAppliedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "quality_size_mappings_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quality_size_mappings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:c7220b026c1c2df52d34145f6d123730a161db0ce5003c67697dc853085e63b5
CREATE TABLE "queue_cleaner_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalMins" INTEGER NOT NULL DEFAULT 30,
    "stalledEnabled" BOOLEAN NOT NULL DEFAULT true,
    "stalledThresholdMins" INTEGER NOT NULL DEFAULT 60,
    "failedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "slowEnabled" BOOLEAN NOT NULL DEFAULT false,
    "slowSpeedThreshold" INTEGER NOT NULL DEFAULT 100,
    "slowGracePeriodMins" INTEGER NOT NULL DEFAULT 30,
    "errorPatternsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "errorPatterns" TEXT,
    "fileExtensionAllowlistEnabled" BOOLEAN NOT NULL DEFAULT false,
    "allowedFileExtensions" TEXT,
    "removeFromClient" BOOLEAN NOT NULL DEFAULT false,
    "addToBlocklist" BOOLEAN NOT NULL DEFAULT true,
    "searchAfterRemoval" BOOLEAN NOT NULL DEFAULT false,
    "quiAwareMode" BOOLEAN NOT NULL DEFAULT false,
    "lastSeedProtection" BOOLEAN NOT NULL DEFAULT true,
    "changeCategoryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dryRunMode" BOOLEAN NOT NULL DEFAULT true,
    "maxRemovalsPerRun" INTEGER NOT NULL DEFAULT 10,
    "minQueueAgeMins" INTEGER NOT NULL DEFAULT 5,
    "strikeSystemEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxStrikes" INTEGER NOT NULL DEFAULT 3,
    "strikeDecayHours" INTEGER NOT NULL DEFAULT 24,
    "seedingTimeoutEnabled" BOOLEAN NOT NULL DEFAULT false,
    "seedingTimeoutHours" INTEGER NOT NULL DEFAULT 72,
    "estimatedCompletionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "estimatedCompletionMultiplier" REAL NOT NULL DEFAULT 2.0,
    "importPendingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "importPendingThresholdMins" INTEGER NOT NULL DEFAULT 60,
    "importBlockCleanupLevel" TEXT NOT NULL DEFAULT 'safe',
    "importBlockPatternMode" TEXT NOT NULL DEFAULT 'defaults',
    "importBlockPatterns" TEXT,
    "autoImportEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoImportMaxAttempts" INTEGER NOT NULL DEFAULT 2,
    "autoImportCooldownMins" INTEGER NOT NULL DEFAULT 30,
    "autoImportSafeOnly" BOOLEAN NOT NULL DEFAULT true,
    "autoImportCustomPatterns" TEXT,
    "autoImportNeverPatterns" TEXT,
    "tagFilterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "includeTags" TEXT,
    "excludeTags" TEXT,
    "profileFilterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "includeProfiles" TEXT,
    "excludeProfiles" TEXT,
    "skipFutureEpisodes" BOOLEAN NOT NULL DEFAULT true,
    "whitelistEnabled" BOOLEAN NOT NULL DEFAULT false,
    "whitelistPatterns" TEXT,
    "lastRunAt" DATETIME,
    "lastRunItemsCleaned" INTEGER NOT NULL DEFAULT 0,
    "lastRunItemsSkipped" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "queue_cleaner_configs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:36dc756aa45366dca57a7446fb8084a03ee47531d7a3ece23cc8906ab4d1d402
CREATE TABLE "queue_cleaner_import_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "downloadKey" TEXT NOT NULL,
    "queueId" INTEGER NOT NULL,
    "downloadTitle" TEXT NOT NULL,
    "connectionFingerprint" TEXT NOT NULL,
    "commandFingerprint" TEXT NOT NULL,
    "commandId" INTEGER,
    "state" TEXT NOT NULL,
    "lastAttemptAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "queue_cleaner_import_receipts_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:2c29760e98c4cc5ee8960d5d7bdfb54f3650181c2bfea25ad0c171b2c79db9c6
CREATE TABLE "queue_cleaner_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "itemsCleaned" INTEGER NOT NULL DEFAULT 0,
    "itemsSkipped" INTEGER NOT NULL DEFAULT 0,
    "itemsWarned" INTEGER NOT NULL DEFAULT 0,
    "isDryRun" BOOLEAN NOT NULL DEFAULT false,
    "cleanedItems" TEXT,
    "skippedItems" TEXT,
    "warnedItems" TEXT,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "durationMs" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "queue_cleaner_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:7afb86456864ba93fe8413af009580d35079a1c6705b7b8cdf7d2aab4c88588a
CREATE TABLE "queue_cleaner_strikes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "downloadId" TEXT NOT NULL,
    "downloadTitle" TEXT NOT NULL,
    "downloadHash" TEXT,
    "downloadFingerprint" TEXT,
    "strikeCount" INTEGER NOT NULL DEFAULT 1,
    "lastRule" TEXT NOT NULL,
    "lastReason" TEXT NOT NULL,
    "importAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastImportAttempt" DATETIME,
    "lastImportError" TEXT,
    "firstStrikeAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStrikeAt" DATETIME NOT NULL,
    CONSTRAINT "queue_cleaner_strikes_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:c61432f5f53673000b0b3571068b2c3f305548cc9770a02196071dc64642044b
CREATE TABLE "qui_action_claims" (
    "userId" TEXT NOT NULL,
    "serviceInstanceId" TEXT NOT NULL,
    "qbitInstanceId" INTEGER NOT NULL,
    "torrentHash" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "serviceInstanceId", "qbitInstanceId", "torrentHash"),
    CONSTRAINT "qui_action_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "qui_action_claims_serviceInstanceId_fkey" FOREIGN KEY ("serviceInstanceId") REFERENCES "ServiceInstance" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- arr-schema-atom table:4bcbc2b13e05987f018df8579cd529779baff8927eba55dae555d296b545c816
CREATE TABLE "qui_action_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "serviceInstanceId" TEXT NOT NULL,
    "qbitInstanceId" INTEGER NOT NULL,
    "torrentHash" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "attemptId" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "qui_action_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "qui_action_logs_serviceInstanceId_fkey" FOREIGN KEY ("serviceInstanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:dae2831acc2d550cc4b4caa920dcbbff1bf87124a5d4c68b219be17356dc3e03
CREATE TABLE "qui_activity_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "qui_activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:f8e0807b96882571c89e449e12cd40f454bc393fb447158fe729b141ac9e893a
CREATE TABLE "qui_event_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "serviceInstanceId" TEXT,
    "eventType" TEXT NOT NULL,
    "torrentHash" TEXT,
    "payload" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "qui_event_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "qui_event_logs_serviceInstanceId_fkey" FOREIGN KEY ("serviceInstanceId") REFERENCES "ServiceInstance" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- arr-schema-atom table:08180d6ac4a05f4f5c29739fb087f52ac9f6817c01b025c612efdff341f0ac9a
CREATE TABLE "qui_observation_publications" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "generation" TEXT NOT NULL,
    "topologyDigest" TEXT NOT NULL,
    "observedAt" DATETIME,
    "rowCount" INTEGER NOT NULL,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "qui_observation_publications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:021c916a70bf00f75dfac3d7ce169f648dc601108a16ee4f9b28c93419f9f3de
CREATE TABLE "qui_torrent_observations" (
    "userId" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "infoHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "ratio" REAL,

    PRIMARY KEY ("userId", "generation", "infoHash"),
    CONSTRAINT "qui_torrent_observations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:4ee0f9e71a957a775cabf3e1423827b7a844ec9f609d090f3bf1b22a706e5df8
CREATE TABLE "seerr_action_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "detail" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "seerr_action_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:ec962e4580f5ec9c820774a251b03b77ff8d7871cd6e435b87dfbf854dbbf524
CREATE TABLE "session_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concurrentStreams" INTEGER NOT NULL,
    "totalBandwidth" INTEGER NOT NULL DEFAULT 0,
    "lanBandwidth" INTEGER NOT NULL DEFAULT 0,
    "wanBandwidth" INTEGER NOT NULL DEFAULT 0,
    "directPlayCount" INTEGER NOT NULL DEFAULT 0,
    "transcodeCount" INTEGER NOT NULL DEFAULT 0,
    "directStreamCount" INTEGER NOT NULL DEFAULT 0,
    "sessionsJson" TEXT NOT NULL,
    "measurementJson" TEXT,
    CONSTRAINT "session_snapshots_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:45938914f8b00e4f4bd15fc91dacec85f511073d29539cdb7e8e897cb39972c9
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:d4c94a44b19e2ce280db98964510a61ee2750bcd9f4e69f595d11996fdbce94b
CREATE TABLE "standalone_cf_deployments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "cfTrashId" TEXT NOT NULL,
    "cfName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "commitHash" TEXT NOT NULL,
    "deployedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "standalone_cf_deployments_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:4f2522f6f2401173f2ba1e6b7d5c39ac985659f2458a9cae530b7f9e9e4f9b0a
CREATE TABLE "system_settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "apiPort" INTEGER NOT NULL DEFAULT 3001,
    "webPort" INTEGER NOT NULL DEFAULT 3000,
    "listenAddress" TEXT NOT NULL DEFAULT '0.0.0.0',
    "appName" TEXT NOT NULL DEFAULT 'Arr Dashboard',
    "trustProxy" BOOLEAN DEFAULT false,
    "secureCookies" BOOLEAN,
    "notificationLogRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "externalUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- arr-schema-atom table:86f18d19eac317759f3f8a1e4c9a9d5f5a64253deb3aaffd7ade565dff173a0f
CREATE TABLE "tautulli_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "lastWatchedAt" DATETIME,
    "watchCount" INTEGER NOT NULL,
    "watchedByUsers" TEXT NOT NULL,
    "connectionGeneration" INTEGER,
    "identityGeneration" INTEGER,
    CONSTRAINT "tautulli_cache_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:d3f647dc7a886dc70e585f52a53dfa0b02573461b172866331b29c1644efc1ba
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
    "errors" TEXT,
    "warnings" TEXT,
    "backupId" TEXT,
    "canRollback" BOOLEAN NOT NULL DEFAULT false,
    "rolledBack" BOOLEAN NOT NULL DEFAULT false,
    "rolledBackAt" DATETIME,
    "rolledBackBy" TEXT,
    "undeployStatus" TEXT,
    "undeployAttemptedAt" DATETIME,
    "undeployProgress" TEXT,
    "deploymentNotes" TEXT,
    "templateSnapshot" TEXT,
    CONSTRAINT "template_deployment_history_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "trash_templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "template_deployment_history_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "template_deployment_history_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "trash_backups" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- arr-schema-atom table:47d040561aabbc77b6ace25218c9e18fb8b57ebe5972c69c8ea080d7090cd4a4
CREATE TABLE "template_quality_profile_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "qualityProfileId" INTEGER NOT NULL,
    "qualityProfileName" TEXT NOT NULL,
    "connectionGeneration" INTEGER NOT NULL DEFAULT 0,
    "connectionStateToken" TEXT,
    "managedCustomFormats" TEXT,
    "managedCustomFormatsCaptured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncStrategy" TEXT NOT NULL DEFAULT 'notify',
    CONSTRAINT "template_quality_profile_mappings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "trash_templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "template_quality_profile_mappings_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:f1e3cb5a555a1a6c19c7e23de1d35cbd0f8b270c9cb30d03bcc0e1d6298a79bc
CREATE TABLE "tmdb_list_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "generation" TEXT NOT NULL DEFAULT 'legacy',
    "refreshedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tmdb_list_cache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:d59a90dd93053136b63b7573e2ffe037dcb73e00361a634c8f92e8c8d38ecb7f
CREATE TABLE "trakt_list_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "listSlug" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "generation" TEXT NOT NULL DEFAULT 'legacy',
    "refreshedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trakt_list_cache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:c9b1ee969794a001dcb7d7358f7186acc81a7a13416bd63461fc67cac812238a
CREATE TABLE "trash_backups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "backupData" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    CONSTRAINT "trash_backups_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:cda581294a941744d5df6ae0472adbc94568ef14d7defe974294ea6c475b1d55
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

-- arr-schema-atom table:0ac59995bfe55ed4032475f7867e0616067973269b8be2e8d7e73992b355f98e
CREATE TABLE "trash_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "checkFrequency" INTEGER NOT NULL DEFAULT 12,
    "autoRefreshCache" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnUpdates" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnSyncFail" BOOLEAN NOT NULL DEFAULT true,
    "backupRetention" INTEGER NOT NULL DEFAULT 10,
    "backupRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "customRepoOwner" TEXT,
    "customRepoName" TEXT,
    "customRepoBranch" TEXT,
    "customRepoMode" TEXT NOT NULL DEFAULT 'fork',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "trash_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:5abfdec3459e2ac11a245fc754ed556c79a6841fb4950693daca8b90f5616f8e
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
    "rollbackStatus" TEXT,
    "rollbackAttemptedAt" DATETIME,
    "rollbackProgress" TEXT,
    CONSTRAINT "trash_sync_history_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ServiceInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "trash_sync_history_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "trash_templates" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "trash_sync_history_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "trash_backups" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- arr-schema-atom table:0ce5c7d7afb3a304231cdec26d2bbb83d8d5a75f4a3ae63b12762f1d96a1bd42
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

-- arr-schema-atom table:86e03c2506ecbfea5336b9bff9ca7aef18d9b3340cc56c016bdc55f9aa19b3a7
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

-- arr-schema-atom table:cb027cac8188770b447bca655cfd68c6ff523b55ab35c6db3da9c4d0a479223c
CREATE TABLE "user_custom_formats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "description" TEXT,
    "includeCustomFormatWhenRenaming" BOOLEAN NOT NULL DEFAULT false,
    "specifications" TEXT NOT NULL,
    "defaultScore" INTEGER NOT NULL DEFAULT 0,
    "sourceInstanceId" TEXT,
    "sourceCFId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "user_custom_formats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- arr-schema-atom table:8e4a7bab0942d42237e3bcddca3e1cb45d05d648897c982a913d191f50d07257
CREATE TABLE "vapid_keys" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "publicKey" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "privateKeyIv" TEXT NOT NULL
);

-- arr-schema-atom table:62bd1faa870a0394c688997f18eef1ad4c095a8f561c7402723f0d6e9c95c55e
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

-- arr-schema-atom column:cffec041e6a4ae0ba0641de011e9db972d6436c5c09266d8075ca0de17a1604c
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "channelId" TEXT NOT NULL;

-- arr-schema-atom column:038d9c411389025b7eabb9e3217084fdc647b5e77d3b92e74317536309d72b95
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "channelType" TEXT NOT NULL;

-- arr-schema-atom column:35b2618489fd3a0d69d67c2c04ded65cd33389f05b3328ccef69120d57986e84
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "subscriptionEventType" TEXT NOT NULL;

-- arr-schema-atom column:1e505b99bad0fd8b3603148a5eebac06ee91280bfbcf05e27ab48f365319945b
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "state" TEXT NOT NULL;

-- arr-schema-atom column:fdf0229631b5c3c6105e64dd92f4a8d145b539b45d4de13da3489dfefb178666
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "attemptOrdinal" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:1f2569392b888ddba898c4965aa18718afb000736012e5b7a80d7ac7aae2f0ee
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "nextAttemptAt" DATETIME NOT NULL;

-- arr-schema-atom column:97e5deab7e571aa436d95d0775d479d46dbc397354b99d02c0edbc94c09f4e36
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "attemptToken" TEXT;

-- arr-schema-atom column:0c4a9bd5401568a91fac092da2f3a04ecefe9ab65df515d719e068a19ebd68bb
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "workerEpoch" TEXT;

-- arr-schema-atom column:76b69993a96c443b1056e57c6b3d7b60615d3b28de333e20e2245433acaaffd2
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "attemptConfigFingerprint" TEXT;

-- arr-schema-atom column:bb4bc56892b91a2bae4ffdf32194e53de35ece040dbfd1f36f8747071b377d0d
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "dispatchedAt" DATETIME;

-- arr-schema-atom column:befb8e808dbdfa9d2fc32c8f71d9c858890f192a50ed7c00696e6fcfdd1aca7e
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "outcomeCategory" TEXT;

-- arr-schema-atom column:6fd3c988c87949958d4dbb24636bc9461d407ce2a5842bd7837f403d96d78d5a
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:de45de637d3b725f0fa2daf6509ef96b7d2488d7aabaedf454c1047a15b0dd8c
ALTER TABLE "NotificationOutboxDelivery" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:ff265a77db00d30a14158e330e5203d9941cc8f2b4062fb26ef8d3ea56b57fae
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "eventType" TEXT NOT NULL;

-- arr-schema-atom column:ad47826f9e5469af6ef94373dc85f6539029d59a4ae8851f094402973011576b
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "encryptedPayload" TEXT NOT NULL;

-- arr-schema-atom column:675077e9ec9f360f263b01a46b6aef7f18348c64a8250a6736e7d3b09496c5dc
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "payloadIv" TEXT NOT NULL;

-- arr-schema-atom column:af5e2c891d69f6da1a543e96f7961b71785a2585b6452d4757724208faca7de7
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "dedupFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:48aaa6811790f5a375c2ce6a71d1d26bb13f4ede195f3419536a1ef6c66ae3b1
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "scopeFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:78455efb09f154f56fe432b4aa96ad72be78e872843c4d13887c7cfb5b7d37ef
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "stage" TEXT NOT NULL;

-- arr-schema-atom column:1c2b6f6d65e617b1e71c31f51cabe398698b6c2695c9164f0e4b6ee9774b11ef
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "dueAt" DATETIME NOT NULL;

-- arr-schema-atom column:824222b526285e786f8f567f6a2833f78580f413db669816c03494da57d57af1
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "aggregationWindowSeconds" INTEGER;

-- arr-schema-atom column:c944380a01f7260852636c81a20db08196378c5804c85614febc2f067abe6094
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "maxBatchSize" INTEGER;

-- arr-schema-atom column:69426e7ccb0360cfcc5df22540530479e2acdd8c052819a56fcfd5fc581fdefe
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "destinationInstallationId" TEXT NOT NULL;

-- arr-schema-atom column:6760317a09b0b3e5729b530b059c78dff2ba198e20a2e241928698b6cccbee9a
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "restoreCommitId" TEXT;

-- arr-schema-atom column:aeb4a9f43cf2da11394d416f0c78ef328f740e31052800968aa76eb5d15188b4
ALTER TABLE "NotificationOutboxEvent" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:4396e5a044f63a637b095a217ad4ecc03c10374a77ce418b3d98edde314761c3
ALTER TABLE "RestoreRuntimeControl" ADD COLUMN "protocolVersion" INTEGER NOT NULL DEFAULT 1;

-- arr-schema-atom column:4c7a15358befc41103914a69dc6ec06f837786909facc94fd22ef8ed8f0a763d
ALTER TABLE "RestoreRuntimeControl" ADD COLUMN "phase" TEXT NOT NULL;

-- arr-schema-atom column:b79a8a215ebc59d592f37eb767235a590c10b9324ed4fcfa00675f228044750a
ALTER TABLE "RestoreRuntimeControl" ADD COLUMN "runtimeEpoch" TEXT;

-- arr-schema-atom column:4f405460bda602abcfbff1aa622ee923aee4fd976bfd015a6926186356e67044
ALTER TABLE "RestoreRuntimeControl" ADD COLUMN "ownerBackendPid" INTEGER;

-- arr-schema-atom column:df133417da976b9e3b7b822e25b8ec536586947369d6762d85892b54a85827d7
ALTER TABLE "RestoreRuntimeControl" ADD COLUMN "activeRestoreId" TEXT;

-- arr-schema-atom column:cba0cd8f9ab7b5352b86638157d9b14aef8151a41a048a9273b55d321cf688d6
ALTER TABLE "RestoreRuntimeControl" ADD COLUMN "lastCommittedRestoreId" TEXT;

-- arr-schema-atom column:d8b36aadcfa9c6b93d3f3d426949abd66f6ad7639da767782cf886f73177d78f
ALTER TABLE "RestoreRuntimeControl" ADD COLUMN "lastCommittedAt" DATETIME;

-- arr-schema-atom column:6491cefb060e2d49f2e6925cff0f096f60b6e544756521c1c5031338adca645f
ALTER TABLE "RestoreRuntimeControl" ADD COLUMN "destinationInstallationId" TEXT;

-- arr-schema-atom column:c11abbf1dbcfb49a1840c416bc8ad3d2ff9344cb2959f7922fc9fc591290d712
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "intentId" TEXT NOT NULL;

-- arr-schema-atom column:647c60b9f3f8f6c5c8caea22e3ede991001137e9a50ccb641c803102ac295584
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "serviceInstanceId" TEXT NOT NULL;

-- arr-schema-atom column:3c04dd2bf2a96cd4344e790861a2bc55f1ee9a901a8b9c11a9cdb59e82afe055
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "connectionFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:18236dd63ef7f7d0046d98a5d7e73b23ca4c111703b917a294d018b9baadae0b
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "targetHash" TEXT NOT NULL;

-- arr-schema-atom column:960ed936642b394925c83c33ebc1cfdb5f39de0c1cacff8913cd0b4982e1c49b
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "encryptedTarget" TEXT NOT NULL;

-- arr-schema-atom column:4db8968f2b7ef68824db35841c1bd2e2bb64a2a202723f6cd1f833ba8e6f8278
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "targetIv" TEXT NOT NULL;

-- arr-schema-atom column:b08c4f582e83d029a26e6e04b73f6afac30423463c17dfb6eefe1674fb4b7ba3
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'prepared';

-- arr-schema-atom column:680a3486358202b346d02098b8b48b137d2a50e9007afd93ae066867c09d8a17
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "outcomeCategory" TEXT;

-- arr-schema-atom column:eb595c29fdbd877202c5db45d72cb595f5afd8906f821941aa7de5b28d6853a5
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "workerEpoch" TEXT;

-- arr-schema-atom column:8b8eba758990c6008b2bf65feb4cc98767837db118dd4429dca5490e941f76e2
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:1867e224bf04d7d835c52200f1bce3f0f5bd946778dea17898d839288e409bf3
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "dispatchedAt" DATETIME;

-- arr-schema-atom column:2458ebd16410861896fbd22a2d240e3fe6adf34df60b580db131abe607145cc5
ALTER TABLE "SearchGrabAttempt" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:b7cefc1d6ef7bea78d2747efd2c81d25c884678f70309313a3177b253ddd6d8a
ALTER TABLE "ServiceInstance" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:cf12815c56744bb70d3059df80c000e92d6a6ef6281c526f71ada276bdaf76c2
ALTER TABLE "ServiceInstance" ADD COLUMN "service" TEXT NOT NULL;

-- arr-schema-atom column:4e8c6a4bd14dacbe96fa1bbf9320ecf6fd12b2b30c6943c7a546b3b40d5c62e6
ALTER TABLE "ServiceInstance" ADD COLUMN "label" TEXT NOT NULL;

-- arr-schema-atom column:a045c89121f42c20a622e570649a3f32eb2c3d132ba92aa3f2865a2f42f8c31d
ALTER TABLE "ServiceInstance" ADD COLUMN "baseUrl" TEXT NOT NULL;

-- arr-schema-atom column:f00d0dac9bc09806b2db45f64151a694a34b632973c15d282cd019634addd2be
ALTER TABLE "ServiceInstance" ADD COLUMN "externalUrl" TEXT;

-- arr-schema-atom column:b9204e1a689a68cb5d3fe91ce46781fcf45655db2f213483f9e0a137e61646a0
ALTER TABLE "ServiceInstance" ADD COLUMN "encryptedApiKey" TEXT NOT NULL;

-- arr-schema-atom column:e2749bbb7967ef4404c4c704ad1914fc84f848b0c9a51f27f02e71232fc6a979
ALTER TABLE "ServiceInstance" ADD COLUMN "encryptionIv" TEXT NOT NULL;

-- arr-schema-atom column:ddfa258b44891f2bb4fcdf9ea73aee7c628a24dfb992784461506050787c7b3f
ALTER TABLE "ServiceInstance" ADD COLUMN "encryptedHttpAuthCredentials" TEXT;

-- arr-schema-atom column:fd9354c59c5d1c2ce715fad13795657753c25e2e60ec646c851e44beea320c53
ALTER TABLE "ServiceInstance" ADD COLUMN "httpAuthEncryptionIv" TEXT;

-- arr-schema-atom column:10e00cec4f151a9237900366cdb6e6837a0b6b933197bb9a7a645e0aa26f6312
ALTER TABLE "ServiceInstance" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:7f885249103db4c27514e2afad19de9f2f1ff79b3f58b11e5821c3337d417c8e
ALTER TABLE "ServiceInstance" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:0cd8b97043f9e571877e8ec31401592b559c7706fd1b356ccf0c016ec0093c83
ALTER TABLE "ServiceInstance" ADD COLUMN "storageGroupId" TEXT;

-- arr-schema-atom column:9a76b34b53de3434eb36e345049f058ade0a346f9fdc13408df28228419d3031
ALTER TABLE "ServiceInstance" ADD COLUMN "hasLocalFilesystemAccess" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:083e79f778a7d1a51adb74211b817175164f870561e8d51a228fdc11e9e6fec6
ALTER TABLE "ServiceInstance" ADD COLUMN "pathPrefix" TEXT;

-- arr-schema-atom column:aa94e1d41b2a9b233b13b529b260142d5ddd372d9b3433939873ecfb74161738
ALTER TABLE "ServiceInstance" ADD COLUMN "connectionGeneration" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:a332a2d7dd272a8f0147beff5ae0b4896dd039951f68dc5239c224242aa96396
ALTER TABLE "ServiceInstance" ADD COLUMN "expectedIdentity" TEXT;

-- arr-schema-atom column:379765dd6f8ae0945157c69b7d96c285dd2dc8542c95588c132f8137e176c71d
ALTER TABLE "ServiceInstance" ADD COLUMN "identityKind" TEXT;

-- arr-schema-atom column:568534b40ffb54b809b769660c8522319043b2c9616151045ffe29cea95b4627
ALTER TABLE "ServiceInstance" ADD COLUMN "identityStatus" TEXT NOT NULL DEFAULT 'unverified';

-- arr-schema-atom column:38add20c16780884d021b7cbfec537b47f9f2a1d5b3054995c927a73aa32ca3f
ALTER TABLE "ServiceInstance" ADD COLUMN "identityGeneration" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:e0aeae4d0cf954d42979696f2624826619c439e82e1bccf26f2e14583dbb218a
ALTER TABLE "ServiceInstance" ADD COLUMN "identityVerifiedAt" DATETIME;

-- arr-schema-atom column:da9d5168104276e83037bb5b46883686f1366ff5623d107711c991495922b10d
ALTER TABLE "ServiceInstance" ADD COLUMN "identityLastCheckedAt" DATETIME;

-- arr-schema-atom column:b781774ff76258daa626ef28cf75908632747057c52d0e3fd7b16fbf62c8d972
ALTER TABLE "ServiceInstance" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:3b6d3b33df8368e70fabac99b5ad11a0ba4a428b19c9b554c9c311f3fea02de6
ALTER TABLE "ServiceTag" ADD COLUMN "name" TEXT NOT NULL;

-- arr-schema-atom column:746c612a63bcf51b215d20b269e81c304a4ece6403688cc41bc1669ed6a9ee6e
ALTER TABLE "ServiceTag" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:a7b39ff7e66fb3718ee82beec66cf4cd4a39118df8c8e1cbb4d2612f15e6569c
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "protocolVersion" INTEGER NOT NULL DEFAULT 1;

-- arr-schema-atom column:0ce36ac0dc3923556b1dd2314adf6499ce13838e4a8f91a455c1841b40b16df7
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "databaseDevice" TEXT NOT NULL;

-- arr-schema-atom column:b6eaa5bc34b36c60a2a63f5d46366edcd10b77cb0160ed8529f504ddce5c5643
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "databaseInode" TEXT NOT NULL;

-- arr-schema-atom column:fb2fa2aafc3c53b764f033418dbd4f043c3149820841aa780ca2716df16af45f
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "directoryDevice" TEXT NOT NULL;

-- arr-schema-atom column:f44fb97d2b60ede385906bb4b55adb68344c7925667820ddc7044ee8c07d1089
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "directoryInode" TEXT NOT NULL;

-- arr-schema-atom column:e3b68b075cb5e7ed77572e366239448ecb4db15551eb54e7b833c27d826947fc
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "coordinationDevice" TEXT NOT NULL;

-- arr-schema-atom column:1b8eb5510b562d7c294cd83df803ad8aab4b4f6b432013f7785229ee274e9aa0
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "coordinationInode" TEXT NOT NULL;

-- arr-schema-atom column:1aec506011f8dbe2d67db27275e7b734fe2c15bf0b8388065e494b1755d1afa3
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "ownerDevice" TEXT NOT NULL;

-- arr-schema-atom column:84f9d4b69a03879240e426f8418ea02c86cebd3bb559e3307cc30a09300bb90e
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "ownerInode" TEXT NOT NULL;

-- arr-schema-atom column:d17cdc52b948ac6806ec72fce200322e3a524b52c05b54755b643d97c7d50107
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "operationsDevice" TEXT NOT NULL;

-- arr-schema-atom column:6b017dbccff630f2a60373d424753826835f8b13f47bbdb9e3a48b436db42c03
ALTER TABLE "SqliteRestoreStorageBinding" ADD COLUMN "operationsInode" TEXT NOT NULL;

-- arr-schema-atom column:ff8dcb3df8b7650e86208c38e854018683842b9128448584c68ce34199b4da0d
ALTER TABLE "User" ADD COLUMN "username" TEXT NOT NULL;

-- arr-schema-atom column:163a9f79d77674cd464c4fbc417ca58f536c53319d46a3cc08c33e3f8c4f0dd2
ALTER TABLE "User" ADD COLUMN "hashedPassword" TEXT;

-- arr-schema-atom column:51bcfcecfce12496048e3f3d50f707e50955c13d371c44c5a46adea89e82a2b5
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:0ced20b2111726444eeb4bc467117584b0aa6dbfe786d245eb2d297785c40661
ALTER TABLE "User" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:1f89107853361657db5976e9743dc8999f5dd1ed4953814c085c837dab8dded5
ALTER TABLE "User" ADD COLUMN "lockedUntil" DATETIME;

-- arr-schema-atom column:1eb22b533cf992e13e6bb287c0d3599c10bebf442b383edebb411c0743fe2b51
ALTER TABLE "User" ADD COLUMN "encryptedTmdbApiKey" TEXT;

-- arr-schema-atom column:fce68fa3b3783aa5d3c7ed5af448a03f428e91bcfad722caf4252e3129b8ff39
ALTER TABLE "User" ADD COLUMN "tmdbEncryptionIv" TEXT;

-- arr-schema-atom column:249390b1a156bc69a8a43b4cb876bcfb3404949a5be7fb9d9894f251a8854ea3
ALTER TABLE "User" ADD COLUMN "hashedWebhookSecret" TEXT;

-- arr-schema-atom column:9be49bb675290fedeebf36410ffb434b79bf1ffef4ac73bfad88dad2fa04553d
ALTER TABLE "User" ADD COLUMN "hashedQuiWebhookSecret" TEXT;

-- arr-schema-atom column:7a17787adb6ed30ece8a98376f68952a3d4354169914ec5fa65d1a6835f95eb1
ALTER TABLE "User" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:42ae6549e2251ca42e1d9523c0903e2b05c4202c0199d7f26ebd13e707a93c11
ALTER TABLE "User" ADD COLUMN "encryptedTraktAccessToken" TEXT;

-- arr-schema-atom column:60ab4032d8faa2158c0af938753fe6a9fdc025f51fea3cc739dc861173282054
ALTER TABLE "User" ADD COLUMN "traktTokenIv" TEXT;

-- arr-schema-atom column:883c84b53f7663075567b33ac40e38dbe0b184f61a9555a71ec836da20059fd1
ALTER TABLE "arr_import_file_proofs" ADD COLUMN "operationId" TEXT NOT NULL REFERENCES "arr_import_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:0fbff6032d323fe610619e22077caa6e4fa48734e5bd289eca36f230f18cea0f
ALTER TABLE "arr_import_file_proofs" ADD COLUMN "fileFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:e613d11299039524a5bb84c469025acb888dbb6bd09be5d88fdf82c53b21f21e
ALTER TABLE "arr_import_file_proofs" ADD COLUMN "downloadKey" TEXT NOT NULL;

-- arr-schema-atom column:b3d6204bd3506a574124d67e95adf8d2934c1bbfaf702e0d56e4f66725690132
ALTER TABLE "arr_import_file_proofs" ADD COLUMN "identityJson" JSONB NOT NULL;

-- arr-schema-atom column:61c5abb1288eff1a14db9bb56d0573c4928ec622a6e45d733151294d71f825fe
ALTER TABLE "arr_import_file_proofs" ADD COLUMN "verifiedAt" DATETIME;

-- arr-schema-atom column:f1b7fb9dcd941d0d3b6d47158df6e75bab3d9e207eef17eabffda59a6108b7aa
ALTER TABLE "arr_import_operations" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:2ada45fbd41b8edce26d560d2936a081c71a42059e8eb1f9376bb78036b8a20c
ALTER TABLE "arr_import_operations" ADD COLUMN "instanceId" TEXT REFERENCES "ServiceInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- arr-schema-atom column:56776442839f4eb6733deb8f148eaae94814a3b4e3bc880608ea530e4ffd2645
ALTER TABLE "arr_import_operations" ADD COLUMN "originalInstanceId" TEXT NOT NULL;

-- arr-schema-atom column:2022e9606384e03fcb8bfde37c86e8057c4d3aebc12610bea36be2fcb2a5fb27
ALTER TABLE "arr_import_operations" ADD COLUMN "connectionFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:6d1248faae71e5665cdc3ba5980ca30410df954f4d163a1661f5e41fe261ee45
ALTER TABLE "arr_import_operations" ADD COLUMN "service" TEXT NOT NULL;

-- arr-schema-atom column:45f583184cf2e0b3c5787aaf97278658e1f7d6d2c538d4a42e954449f0106dd0
ALTER TABLE "arr_import_operations" ADD COLUMN "origin" TEXT NOT NULL;

-- arr-schema-atom column:9c077205cf433270856bd49604585fd71692750e049246858fe31d5a6a8a137f
ALTER TABLE "arr_import_operations" ADD COLUMN "mode" TEXT NOT NULL;

-- arr-schema-atom column:a2fcfde2ab72921934734ab03c9d6c3f9b8d2818513ce65ea7c7f739350377ee
ALTER TABLE "arr_import_operations" ADD COLUMN "idempotencyKey" TEXT NOT NULL;

-- arr-schema-atom column:ade2cc9de25494e13652aff33c47fef2aac930877dd76019a03c25e253470cb4
ALTER TABLE "arr_import_operations" ADD COLUMN "requestFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:61f2f8b637270d06cb49a3ab46734c9dbbfeb74382e18da73d05d97908c8eecd
ALTER TABLE "arr_import_operations" ADD COLUMN "commandFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:f8afe965efaf47ab82364faf624114c72be3bc90a5918a5d3d043d161e868307
ALTER TABLE "arr_import_operations" ADD COLUMN "encryptedSources" TEXT NOT NULL;

-- arr-schema-atom column:cefb99b8b3a082c233a74194beaf565fe8c2669dd220d0c79c6d582bb15a86f0
ALTER TABLE "arr_import_operations" ADD COLUMN "sourcesEncryptionIv" TEXT NOT NULL;

-- arr-schema-atom column:d5dcd4c0dd6d99b9f441a8d4aba10c63eca257855e98a6aa0c0b03dfd83653b3
ALTER TABLE "arr_import_operations" ADD COLUMN "legacyReceiptId" TEXT;

-- arr-schema-atom column:b55d291fd7cc975801bc9422d24a2c03bab51e33e54707690e3b4b621acfd5e6
ALTER TABLE "arr_import_operations" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'preparing';

-- arr-schema-atom column:143a4fe30af5002b73366161acae1abb3d8a952f7ebb5396f2042326cfb5a3eb
ALTER TABLE "arr_import_operations" ADD COLUMN "reason" TEXT;

-- arr-schema-atom column:bca5e6cfe1659b6008205a363b1effe639be0b75c927052d563af62300eb94ad
ALTER TABLE "arr_import_operations" ADD COLUMN "commandId" INTEGER;

-- arr-schema-atom column:b67a38c974e5e7c1a814358fefdb2840854a64266f7a08ec96bbd92124d172b6
ALTER TABLE "arr_import_operations" ADD COLUMN "commandState" TEXT;

-- arr-schema-atom column:a6d28365cc4188268819eaaa39572a599efc0af0cf89246c98dc842412dc2136
ALTER TABLE "arr_import_operations" ADD COLUMN "commandTerminal" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:bbe7611e685672eb1689d8d755ce01baba94913706ec074db73a3ef43da240d6
ALTER TABLE "arr_import_operations" ADD COLUMN "selectedFileCount" INTEGER NOT NULL;

-- arr-schema-atom column:c42a841c2ff1d4702b1bb522a2e1c5c33ec13fb4bacc707c4242996a77d61857
ALTER TABLE "arr_import_operations" ADD COLUMN "verifiedFileCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:95c07fc95cec9a8dc3d291c7b9c2fb21596b4f2c045a7ae9858291fca4727a95
ALTER TABLE "arr_import_operations" ADD COLUMN "preparationExpiresAt" DATETIME NOT NULL;

-- arr-schema-atom column:f504d44e8a3292ebc601f1207a19273f2a06b08d33c82f14321efd022801fd47
ALTER TABLE "arr_import_operations" ADD COLUMN "submissionStartedAt" DATETIME;

-- arr-schema-atom column:80a80a2790777b31b73e097f56116dee05aaa3184ea1f3651acee27ad33c42a8
ALTER TABLE "arr_import_operations" ADD COLUMN "lastCheckedAt" DATETIME;

-- arr-schema-atom column:421e5edec83a425997c8b06a3b63b671976ed9baec133c5b11b383521fa6d131
ALTER TABLE "arr_import_operations" ADD COLUMN "nextCheckAt" DATETIME;

-- arr-schema-atom column:330c498e8a2c65ebbe77a1f956d66fca28e330350d2da9e9ecd0a61de8ad9564
ALTER TABLE "arr_import_operations" ADD COLUMN "reconcileToken" TEXT;

-- arr-schema-atom column:94d40c76ef560362b78f028168486757d8257bb1f3b0413106095753ee66fe9c
ALTER TABLE "arr_import_operations" ADD COLUMN "reconcileExpiresAt" DATETIME;

-- arr-schema-atom column:78a1fdd9674eef93f23cbc3e7d5269c0b6c518b678bea0b8173fb315b9eb430c
ALTER TABLE "arr_import_operations" ADD COLUMN "reconcileCursor" JSONB;

-- arr-schema-atom column:b0de9abc415d460bcc9029500f04090a219c3563069cca67cc7d60fc4aa3de68
ALTER TABLE "arr_import_operations" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:6e8b2f00e8546a27193f007b451091519b61f75dadc0c7080bf06e18f42f672d
ALTER TABLE "arr_import_operations" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:5cfaa43abbe15da887ed41938f4d66262e14608bd537a72f0133e200bee5e2d8
ALTER TABLE "arr_import_source_claims" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:3a3a1a717ca7bd624159b04d610e561cf96dc340c9444a847574a179778de827
ALTER TABLE "arr_import_source_claims" ADD COLUMN "downloadKey" TEXT NOT NULL;

-- arr-schema-atom column:7b93a7f68e6f25062428eab24148d9e1a6003b2e272bb4d3f0f146ecc05ae9ab
ALTER TABLE "arr_import_source_claims" ADD COLUMN "activeOperationId" TEXT;

-- arr-schema-atom column:3b992cc462022b9838dc8fc681a0504f1c50939aa38bef4ca2b8b76e89c2efce
ALTER TABLE "arr_import_source_claims" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:9484b4b49dc44114c3ec86fb9e54e5ed7ab32c33e797559b43b193f24347bca5
ALTER TABLE "auto_tag_rules" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:b3aadc19bc888930b5746b88f1e27e8c1c67466714b0718425c5111b1af158e1
ALTER TABLE "auto_tag_rules" ADD COLUMN "name" TEXT NOT NULL;

-- arr-schema-atom column:a1839723139250619ccc2f0acc12f5405d9e9d17370bfbfb8290a56fc7defb0d
ALTER TABLE "auto_tag_rules" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:7a290afef8d9f26841763e1bed739f45a14afd1542e26cf94dad7bdfdc11e294
ALTER TABLE "auto_tag_rules" ADD COLUMN "ruleType" TEXT NOT NULL;

-- arr-schema-atom column:a6c3ec2398217f3dc558c0cbc6fff14fa39987b656567afa40584b7354c8eff9
ALTER TABLE "auto_tag_rules" ADD COLUMN "parameters" TEXT NOT NULL;

-- arr-schema-atom column:883d78bfe6f886a13b69a48c09b8cd6437dbc01bbe514fa503d45efbbf079bbf
ALTER TABLE "auto_tag_rules" ADD COLUMN "operator" TEXT;

-- arr-schema-atom column:3fcc6b7c6156e180faa3dce066a1055d504ddb559ac7732e6e97fc07609004e3
ALTER TABLE "auto_tag_rules" ADD COLUMN "conditions" TEXT;

-- arr-schema-atom column:a9e1939f0eb131948fa0a020a3f10ce15e5179b38fba1da8a3e330ab2ef9b895
ALTER TABLE "auto_tag_rules" ADD COLUMN "serviceFilter" TEXT;

-- arr-schema-atom column:46166ac09166b40c5f05d687e43e08e23582f82b38fda8e629d373a0221f0b1a
ALTER TABLE "auto_tag_rules" ADD COLUMN "instanceFilter" TEXT;

-- arr-schema-atom column:455ca1a4fba41a5dd0ecc6775cc29e95000a56a4503889fc01be2b1d67d38f7e
ALTER TABLE "auto_tag_rules" ADD COLUMN "excludeTags" TEXT;

-- arr-schema-atom column:b5c0c1c00bcfced558418126712972be6bf9457b8846f799a05baaf41911be47
ALTER TABLE "auto_tag_rules" ADD COLUMN "excludeTitles" TEXT;

-- arr-schema-atom column:2aca9f2fe09c25fba3a79c5c3ebc94dbb068e0fa3320f6d4e93f2c6e7478893b
ALTER TABLE "auto_tag_rules" ADD COLUMN "plexLibraryFilter" TEXT;

-- arr-schema-atom column:5c953dc2fa093d0c1a62e0f23af17f521ec46e1ba64bc36ebb046ed1c5ce5078
ALTER TABLE "auto_tag_rules" ADD COLUMN "tagName" TEXT NOT NULL;

-- arr-schema-atom column:8e0061f54521e3e56da2f27d08bcdfbd3317bc885def33993973e3b0d47024b5
ALTER TABLE "auto_tag_rules" ADD COLUMN "lastRunAt" DATETIME;

-- arr-schema-atom column:1267ee4ef63b90c2ac065cdeae2868d2857fb7ab707f75b1775f8e0160c97c5e
ALTER TABLE "auto_tag_rules" ADD COLUMN "lastRunStatus" TEXT;

-- arr-schema-atom column:4a4b8863e2be63fd83c51c675d6d2c0ca405d15050338feeeeee4baadecce2ee
ALTER TABLE "auto_tag_rules" ADD COLUMN "lastRunMessage" TEXT;

-- arr-schema-atom column:09426aa1a15d8fbe8937e9e0bc5d1a0276ca035df00a417e7e90acca86009dbb
ALTER TABLE "auto_tag_rules" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:037d17d18a7ee69891c11d91061d509381871a9c1cbe726e82cc2f55f310d94f
ALTER TABLE "backup_settings" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:1d970defbcb01a595d4869aef06434c211c14cafdc06c7552d75167644b0d7ee
ALTER TABLE "backup_settings" ADD COLUMN "intervalType" TEXT NOT NULL DEFAULT 'DISABLED';

-- arr-schema-atom column:1f9500cc98b3662133748fa854bc6e74a396bab5b2928e6a4cad204c359d4137
ALTER TABLE "backup_settings" ADD COLUMN "intervalValue" INTEGER NOT NULL DEFAULT 24;

-- arr-schema-atom column:3d796a039eecb77a79f3c9bddeee54896bb873e61c668003b2baa321bd1e167f
ALTER TABLE "backup_settings" ADD COLUMN "retentionCount" INTEGER NOT NULL DEFAULT 7;

-- arr-schema-atom column:225b4a2e908d693107e5865233a6dcebec2f4cbe45b4281f7c3e942c1ff21a2d
ALTER TABLE "backup_settings" ADD COLUMN "lastRunAt" DATETIME;

-- arr-schema-atom column:9412d0cf500bad9123c697e49764458faf7392489414089cb2516ff16ab05f76
ALTER TABLE "backup_settings" ADD COLUMN "nextRunAt" DATETIME;

-- arr-schema-atom column:92ef3d98c962d7bc7158c15923c0f42fbe6a06b9b03973f36c927ba8de05bdf3
ALTER TABLE "backup_settings" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:e6ff5882de435d25f2d8c22da7b83683ca9c62acd96281f2fc554dfe27e320ad
ALTER TABLE "backup_settings" ADD COLUMN "encryptedPassword" TEXT;

-- arr-schema-atom column:d06644691528eac71bd7b0a44d23670dd64cbbb13b70ec28e1348abf302fa293
ALTER TABLE "backup_settings" ADD COLUMN "passwordIv" TEXT;

-- arr-schema-atom column:55162d642a30b1797f48658f68801f2734bd2b769c5dd0a290ae3700d669ab13
ALTER TABLE "backup_settings" ADD COLUMN "includeTrashBackups" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:edc02c3972e624439bb58b35b97de49c805bcfebed10e99652297b20db56e875
ALTER TABLE "cache_refresh_status" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:e59469abe7af505eefe0a22915a101c0a9bee00eb744af0e220f58f40497c2f1
ALTER TABLE "cache_refresh_status" ADD COLUMN "cacheType" TEXT NOT NULL;

-- arr-schema-atom column:3c89d4ef71c389c0a43be2c63e4126f7df385d870754cc7b75792d319801eb25
ALTER TABLE "cache_refresh_status" ADD COLUMN "lastRefreshedAt" DATETIME NOT NULL;

-- arr-schema-atom column:0f5aa0dd2d240c5e5a9c60edd4c49de9e99902900db905e3b8c01d05c427dead
ALTER TABLE "cache_refresh_status" ADD COLUMN "lastResult" TEXT NOT NULL;

-- arr-schema-atom column:5caa926bfd739bcb4ee1584c3b84a78be45c4d7973ee61b43985688ab886ec9c
ALTER TABLE "cache_refresh_status" ADD COLUMN "lastErrorMessage" TEXT;

-- arr-schema-atom column:0a71fdf99691899814ea3f4c71933dcc77564371fb1a65aafc2d45ac57c04866
ALTER TABLE "cache_refresh_status" ADD COLUMN "itemCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:10847e756f539e70aa805f56d3c8c5c006dc29128c51dafff5e3b14dd6eef2d9
ALTER TABLE "cache_refresh_status" ADD COLUMN "generationId" TEXT;

-- arr-schema-atom column:e47da9128995af46f67d2845ea17ed0948b5533f69d9bf7e3fd6234f2c84f15a
ALTER TABLE "cache_refresh_status" ADD COLUMN "generationMetadata" TEXT;

-- arr-schema-atom column:c1018dc2b8eef85fdbba52f5d35729ad64f6f6472ba80a47ed8fac22288ff671
ALTER TABLE "cache_refresh_status" ADD COLUMN "lastAttemptAt" DATETIME;

-- arr-schema-atom column:73614750f597ae2b0a66d499bfd0ac81dd2987d2da1ce98fcd8ce1bc4bc57fa4
ALTER TABLE "cache_refresh_status" ADD COLUMN "lastAttemptResult" TEXT;

-- arr-schema-atom column:0b5f45b757df7578185342f7fec03443e3c13f89f33fa6951ba9b8592278350b
ALTER TABLE "cache_refresh_status" ADD COLUMN "lastAttemptErrorMessage" TEXT;

-- arr-schema-atom column:e08757b3015adeba8ca53b6b572f2a2dd09cd7a12f8a847c25afe053be507a44
ALTER TABLE "cache_refresh_status" ADD COLUMN "connectionGeneration" INTEGER;

-- arr-schema-atom column:bbe81a4e134189dd46e108b2da98dd9efafe77ef2738d2259619db0068ca8b4e
ALTER TABLE "cache_refresh_status" ADD COLUMN "identityGeneration" INTEGER;

-- arr-schema-atom column:7bc3b2c1027073929a416d7defe55a32f889d8619f82720493a43d6b289f10b0
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "sourceFingerprint" TEXT;

-- arr-schema-atom column:86607dbca17a378ec554c97e454b0e9b2972efc76afad74fb910eaecc5b582fc
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "payload" TEXT;

-- arr-schema-atom column:c589a1085e5cef2ad2c739dc438c329258ea7cd1101640c2d1105a749cd9b614
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "result" TEXT;

-- arr-schema-atom column:86301a3e3967accaa3e8ed765d3869686f96944386113ea9df9e5077c88da074
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "observedAt" DATETIME;

-- arr-schema-atom column:44eb7bd3fc0abc4eb9fa62f183aafbfcb45a270453136b720debcc77c6510583
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "claimFingerprint" TEXT;

-- arr-schema-atom column:9bcea6b0ea7826d194d6b2307b56fbf41d6880a22a73096d2c2a78e0cfa50d93
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "claimToken" TEXT;

-- arr-schema-atom column:fcbf211e5da5413557425fd30f0b983f7346fc924374f419ad8f16b3c24f3dfe
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "leaseUntil" DATETIME;

-- arr-schema-atom column:e16c1647d43f4d990ed189daea868d524c9fa3c5b913e56c687eddcaf435758b
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "retryAt" DATETIME;

-- arr-schema-atom column:d5f6a25ce429c9627d4e2c8fc91a5ad281b7ea105c94e258be958dbb36502291
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "retryFingerprint" TEXT;

-- arr-schema-atom column:7b82bb1f3bae57fce006b74ced3c9e4eb5b3c55dbae65d2fa668aa4758944caf
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "lastFailureCategory" TEXT;

-- arr-schema-atom column:0bb611640afe10d68b4a070a59e1645091f520c0b78ae3078b926907e4466a13
ALTER TABLE "dashboard_statistics_snapshots" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:9b64935ef391fbade44bffbbca0b8076788dace7c87e7c5c300779830ac3e749
ALTER TABLE "episode_file_cache" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:d30a75d17e5871680df4b022a1ea46ace815787a632c67cb7c48bbdf3a208767
ALTER TABLE "episode_file_cache" ADD COLUMN "arrEpisodeFileId" INTEGER NOT NULL;

-- arr-schema-atom column:39c019bbf15195081e51442b8b32f56e714a042425186619d79b938314e089ca
ALTER TABLE "episode_file_cache" ADD COLUMN "arrSeriesId" INTEGER NOT NULL;

-- arr-schema-atom column:a08bb6234cb4f18d705aaeb41914db18140f61adec814ea3882f9fc462ddaa5e
ALTER TABLE "episode_file_cache" ADD COLUMN "seasonNumber" INTEGER NOT NULL;

-- arr-schema-atom column:65047881a55fa694ef52d5fdfb3907b17654544e8e19b2fa918fc864f528c4b6
ALTER TABLE "episode_file_cache" ADD COLUMN "relativePath" TEXT NOT NULL;

-- arr-schema-atom column:189d109171fba91774545c3a0e1a107721c222c21a715721a8ce8dfb56bede04
ALTER TABLE "episode_file_cache" ADD COLUMN "path" TEXT NOT NULL;

-- arr-schema-atom column:73f20fd04b385c80831ef80d3839332aebcaa04cae801181c4bdd7ae3aaef153
ALTER TABLE "episode_file_cache" ADD COLUMN "size" BIGINT NOT NULL;

-- arr-schema-atom column:32686fdb9800836274e8f6e7297064c368a3923bea96d42274f70a7993ab4270
ALTER TABLE "episode_file_cache" ADD COLUMN "qualityName" TEXT;

-- arr-schema-atom column:ceb25cff2ef37d852fedc2a397715fff5b4b67af3174bb720f886518fe790718
ALTER TABLE "episode_file_cache" ADD COLUMN "releaseGroup" TEXT;

-- arr-schema-atom column:e077da4991f7528776eca6e7440830fca43d4aae4f350571e482cdc197e1470d
ALTER TABLE "episode_file_cache" ADD COLUMN "infoHash" TEXT;

-- arr-schema-atom column:6b7fb65d95d696c4f07908aa102900b16b0b1ad13e8770f97062014660600fe2
ALTER TABLE "episode_file_cache" ADD COLUMN "infoHashSource" TEXT;

-- arr-schema-atom column:37b9cfef82a5fb021465a9c18d72a4daea923a24c92afb5c73618dccc053ee89
ALTER TABLE "episode_file_cache" ADD COLUMN "inodeBackfillRetryAfter" DATETIME;

-- arr-schema-atom column:a10a7c150e5e39528a1ebb6557576700d5b4b80e0e61838df65c06ea187b7682
ALTER TABLE "episode_file_cache" ADD COLUMN "torrentState" TEXT;

-- arr-schema-atom column:97984f58bfd69032ac2a9c399e6baf8c3388c621b3cc5c46451ac5f2c9df010c
ALTER TABLE "episode_file_cache" ADD COLUMN "torrentRatio" REAL;

-- arr-schema-atom column:febb6123b6826c53c6ea231e55b9d03626fefb65dd114d21fa87fb4f0bc9fbf5
ALTER TABLE "episode_file_cache" ADD COLUMN "torrentSyncedAt" DATETIME;

-- arr-schema-atom column:0e4c9c330ad3704877c9fc74d8a2b3716b51fd027b048a00bd72ce99ae084255
ALTER TABLE "episode_file_cache" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:afe347aa0aeecd470cb880ab35dc278879168d11210e9a9aef6d7611c038824e
ALTER TABLE "history_collection_leases" ADD COLUMN "claimToken" TEXT;

-- arr-schema-atom column:107525f5e1c8aa0b8828515a7492467f1e915e784f9fbdae2edc6de51734a953
ALTER TABLE "history_collection_leases" ADD COLUMN "claimedAt" DATETIME;

-- arr-schema-atom column:caf5178ae215df4b92d7f95c22477a1ff78d976dff506cc07efadf6fd1544234
ALTER TABLE "history_collection_leases" ADD COLUMN "heartbeatAt" DATETIME;

-- arr-schema-atom column:eefc71fcbb8e43d84b922fa84e3f91dddb5681dd5863e43f641909d8ede4a594
ALTER TABLE "history_collection_leases" ADD COLUMN "expiresAt" DATETIME;

-- arr-schema-atom column:32a294029b331be3d7b69ddd5a89f56530e40459db21013c2ce5844bd7c52a3d
ALTER TABLE "history_collection_leases" ADD COLUMN "lastAttemptAt" DATETIME;

-- arr-schema-atom column:4ff6e64dda94b6ef4a5c58daed2d90b610751708bce44ebeb44dac9b3b3835f3
ALTER TABLE "history_collection_leases" ADD COLUMN "lastAttemptResult" TEXT;

-- arr-schema-atom column:ba3948358ec4881674b26a2fd711cee97866be149fe6abaead8a20205c2932bc
ALTER TABLE "history_collection_leases" ADD COLUMN "lastAttemptReason" TEXT;

-- arr-schema-atom column:b87eedebb5d71616dfda176eb741f1e824ce6924f7dd3d8c7ae51c2d28c5550f
ALTER TABLE "history_collection_leases" ADD COLUMN "nextSourceCursor" TEXT;

-- arr-schema-atom column:38d74c153e4cffd3e14e95b3f42957d238dd1cab4c7f42be0495f45d2cd5955b
ALTER TABLE "history_collection_leases" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:7e79f5c72fe7aeecba55f663331af48dcf2ebd2cf348f040ed3a627e0da41ec2
ALTER TABLE "history_observations" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- arr-schema-atom column:f76b150eb8ad7df45ed40bcc9c63633e70b54bcc0aa870d01eb04b83577c1456
ALTER TABLE "history_observations" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:f123b5574505ac3ac83e2cef0bb2da1bcb8002b2523459ba51f5945eb138d13c
ALTER TABLE "history_observations" ADD COLUMN "providerEventId" INTEGER NOT NULL;

-- arr-schema-atom column:1bdd2bd911573d531f0c2592663c11f8bec1e40070232973b50a8cf13bf3db59
ALTER TABLE "history_observations" ADD COLUMN "eventAt" DATETIME NOT NULL;

-- arr-schema-atom column:b523b9c2e775e008ed2034b70b1b64ab31dfd2a871f0d153f56795fc64879488
ALTER TABLE "history_observations" ADD COLUMN "eventTypeKey" TEXT NOT NULL;

-- arr-schema-atom column:9594576c72e77acf603950ca3f37e53227fff6262ed7b2d0619cc5111652a6da
ALTER TABLE "history_observations" ADD COLUMN "searchText" TEXT NOT NULL;

-- arr-schema-atom column:917c84f78dddc8fd48ec9c2966d1a265df09720badb03776898caad561c17971
ALTER TABLE "history_observations" ADD COLUMN "normalizedPayload" TEXT NOT NULL;

-- arr-schema-atom column:676845e84e55d2c531458b829007cb6b3d36f6af7bd4ca60156c8b698379d874
ALTER TABLE "history_observations" ADD COLUMN "firstObservedAt" DATETIME NOT NULL;

-- arr-schema-atom column:82dae54600f96e8cf5827abc3ff34ab3c958f0f532dd7cfd6f62a9cd1708e765
ALTER TABLE "history_observations" ADD COLUMN "lastObservedAt" DATETIME NOT NULL;

-- arr-schema-atom column:399c26162ad57e740ac71257a3bb551bd5a990ba1bde4ddb42598561bfe4a251
ALTER TABLE "history_source_statuses" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:7e1005b82bad5eb7f3049a181fd40ad72bf55bf18c62307e1fccd1170ef9aaa4
ALTER TABLE "history_source_statuses" ADD COLUMN "publishedAt" DATETIME;

-- arr-schema-atom column:0453ff3142fb33e65905df685d6cd9aba1ccb148157be7b090b35582dda70bab
ALTER TABLE "history_source_statuses" ADD COLUMN "publicationMetadata" TEXT;

-- arr-schema-atom column:f501172c306d65d92b7192ed1d667b4fcc37dd1f47b9bf698eefef0116bab378
ALTER TABLE "history_source_statuses" ADD COLUMN "retainedObservationCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:00ce0d000cafad4eb9e4cf72f1f2879ada2e9730ebaedc0fd2381e98d17a4713
ALTER TABLE "history_source_statuses" ADD COLUMN "lastAttemptAt" DATETIME;

-- arr-schema-atom column:6a84a98cfe7e3d927d8810cad435db8f126181e1101eb1c95e88f4ea8fe5ee0c
ALTER TABLE "history_source_statuses" ADD COLUMN "lastAttemptResult" TEXT;

-- arr-schema-atom column:0cda2452c12107123d13ebdc58ba0df7f54c8a70bfda54733fe8c35bd70bbf1c
ALTER TABLE "history_source_statuses" ADD COLUMN "lastAttemptReason" TEXT;

-- arr-schema-atom column:69015fb67e4c170c392db6789d3f042747b7a96a4503ecbce87e1b503e0f43d0
ALTER TABLE "history_source_statuses" ADD COLUMN "publicationRevision" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:47f4851d8db97dc5bf24faf88c7cc6fbd83b0bccc468152080c53cc50afbd941
ALTER TABLE "history_source_statuses" ADD COLUMN "retentionEpoch" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:61681e69efc08cca4acae266cd3fce7f768117fac1080e0efce80516391c0df0
ALTER TABLE "history_source_statuses" ADD COLUMN "collectHeadNext" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:5dd8c58703684c70e3d61891992a58b78736028518e2d86abb203c28fbbcd0e4
ALTER TABLE "history_source_statuses" ADD COLUMN "nextBackfillPage" INTEGER NOT NULL DEFAULT 2;

-- arr-schema-atom column:ce278ba74d6d1b13262070d1489bc12749aa6165d89e39029dae7520dc0362a9
ALTER TABLE "history_source_statuses" ADD COLUMN "activeCollectionPage" INTEGER;

-- arr-schema-atom column:485f62c2987e5f64440a911945bacb84047b60e9db58abcc4f877d52e2695c55
ALTER TABLE "hunt_configs" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:8285c73aef1f118aa362aee422e6a350c3916042577fd728896bb7960401c851
ALTER TABLE "hunt_configs" ADD COLUMN "huntMissingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:905ce20885d2d27843ecaa0987e74054b551ed709663b40123d480b680ad92de
ALTER TABLE "hunt_configs" ADD COLUMN "huntUpgradesEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:864d4ea3b3ab88348863d85608cf38a23ea3d314629839b03cd087e5b621f3ee
ALTER TABLE "hunt_configs" ADD COLUMN "missingBatchSize" INTEGER NOT NULL DEFAULT 5;

-- arr-schema-atom column:3b3c605a68be9fadcfa98645c2bccf54704ab0a3c241111d2eec8dd0694bdc42
ALTER TABLE "hunt_configs" ADD COLUMN "missingIntervalMins" INTEGER NOT NULL DEFAULT 60;

-- arr-schema-atom column:ac8197de3384f3b367242e4dfdce9e3cea795e617f1455610e36f7ce1a2e0186
ALTER TABLE "hunt_configs" ADD COLUMN "upgradeBatchSize" INTEGER NOT NULL DEFAULT 3;

-- arr-schema-atom column:4a11462240f7b24e7d0111bc5dcc20dcc92fd11d70524bc9fd3b6913c1bbc237
ALTER TABLE "hunt_configs" ADD COLUMN "upgradeIntervalMins" INTEGER NOT NULL DEFAULT 120;

-- arr-schema-atom column:635af2dfb7f09c8df556acad7dec9b3937879712cbafaa4574b3b678fed132a0
ALTER TABLE "hunt_configs" ADD COLUMN "hourlyApiCap" INTEGER NOT NULL DEFAULT 100;

-- arr-schema-atom column:b0ec414b069f5eac778b63b966f493e3c9285ea37a9dcc659c7c4bd83ee283bb
ALTER TABLE "hunt_configs" ADD COLUMN "queueThreshold" INTEGER NOT NULL DEFAULT 25;

-- arr-schema-atom column:f7601277bc7ff7fdee1832a476c410d42cfe4927c1c23bab8b54c26ba7a025aa
ALTER TABLE "hunt_configs" ADD COLUMN "filterLogic" TEXT NOT NULL DEFAULT 'AND';

-- arr-schema-atom column:fb1ad358ec1d17b860b316738f2f3a2ad1c939d81288de2bcbce5af7c01c41bf
ALTER TABLE "hunt_configs" ADD COLUMN "monitoredOnly" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:9f0e6a30c06b085a48d65a42037049b6463e8c2c23285a2073427b170ef61ed9
ALTER TABLE "hunt_configs" ADD COLUMN "includeTags" TEXT;

-- arr-schema-atom column:a901da4bd35cf54566b5500f1dc47ce30ebc9388ad3dc855d89c8f149f7cc789
ALTER TABLE "hunt_configs" ADD COLUMN "excludeTags" TEXT;

-- arr-schema-atom column:a960047e80e020b506076917d3063b84c573490b1989c6b832a7f888655c2463
ALTER TABLE "hunt_configs" ADD COLUMN "includeQualityProfiles" TEXT;

-- arr-schema-atom column:0aae79be5a7bcd4901358f590a6dd9748becb91087d07e372499f49d8a151d25
ALTER TABLE "hunt_configs" ADD COLUMN "excludeQualityProfiles" TEXT;

-- arr-schema-atom column:9c0d75180f152854c114bbe842664ad5b5ae5256075547365496302964edcfd7
ALTER TABLE "hunt_configs" ADD COLUMN "includeStatuses" TEXT;

-- arr-schema-atom column:585ed7810ba99cac1547fe2a64f32ce11bd433833b1d63f6325d94d76336419b
ALTER TABLE "hunt_configs" ADD COLUMN "yearMin" INTEGER;

-- arr-schema-atom column:01f7624c08e39aa19f62aae8d9b876c6805ea0501077830e7574d317bace44b3
ALTER TABLE "hunt_configs" ADD COLUMN "yearMax" INTEGER;

-- arr-schema-atom column:db8b2dd52d0ca633b852c667556a886ddc0c247d91b323e8627697a8730a9a45
ALTER TABLE "hunt_configs" ADD COLUMN "ageThresholdDays" INTEGER;

-- arr-schema-atom column:8bcb7bc987f7d460094c8ecc64fe48cea888b007cd54db1200f82b3ed20150e3
ALTER TABLE "hunt_configs" ADD COLUMN "preferSeasonPacks" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:46fec916b386aecf1a511ec1a0a19208e05965129519b77c78405a48170e6895
ALTER TABLE "hunt_configs" ADD COLUMN "upgradeSearchAll" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:54b5c9b3473fb5301b77586c7637b2c180b8d559285b1b0a7ffd446638cdb034
ALTER TABLE "hunt_configs" ADD COLUMN "researchAfterDays" INTEGER NOT NULL DEFAULT 7;

-- arr-schema-atom column:f36f391931387b64dc9b75a8c6fda71ca85415f820ccac66b29328111ead9213
ALTER TABLE "hunt_configs" ADD COLUMN "lastMissingHunt" DATETIME;

-- arr-schema-atom column:e12aa2aabf60c6334ece1864b41524a92157948e6fc097488bb4e5c7b311c922
ALTER TABLE "hunt_configs" ADD COLUMN "lastUpgradeHunt" DATETIME;

-- arr-schema-atom column:85bb455cf1afe9f0b3c16fc340fb5375024ffe2716f849a241734a95ef36171e
ALTER TABLE "hunt_configs" ADD COLUMN "apiCallsThisHour" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:657ab3e9ce10b5b1c83b0c6047b4acaf410b2a0e90a64f8cf670c54104e4825c
ALTER TABLE "hunt_configs" ADD COLUMN "apiCallsResetAt" DATETIME;

-- arr-schema-atom column:e0d6b17bca7fdab3b1d228203186801e728e6c44c07d0cfb6b0c4704db114147
ALTER TABLE "hunt_configs" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:9d2ee5cf275d641cee7fc4edd0e14126e7409f865f2b2fcedf044640c72fc35a
ALTER TABLE "hunt_logs" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:ba108ae86826afd9c8e708a4fa0a78aad1dd17570146c382e0975d7e83fdf974
ALTER TABLE "hunt_logs" ADD COLUMN "huntType" TEXT NOT NULL;

-- arr-schema-atom column:fc49f50197383a7f8fb85f19c935c851f8a79ec8ee23cf784fb23a6f6f6579ae
ALTER TABLE "hunt_logs" ADD COLUMN "itemsSearched" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:8f3cc1242c18974f67cf680c46185f3b767061fdb964d0708d9ce293dd70a2dd
ALTER TABLE "hunt_logs" ADD COLUMN "itemsFound" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:573cc6745f8e684a7a8d5e4c19e04f0b29f508b545126a993a8fe72c641fe630
ALTER TABLE "hunt_logs" ADD COLUMN "searchedItems" TEXT;

-- arr-schema-atom column:24439b2d493d058f9a64b7a41f56f303ea0709ded49a6dcbf907641ea3a9f9bd
ALTER TABLE "hunt_logs" ADD COLUMN "foundItems" TEXT;

-- arr-schema-atom column:ae611be7fab4e1587dfc5cafe9caebcfe8bdc177f0d80cb973ab1804f6780372
ALTER TABLE "hunt_logs" ADD COLUMN "status" TEXT NOT NULL;

-- arr-schema-atom column:ecaf0e63e86d9cbb3e3f513a5460889fcc0de3d8c2de057ceca8b8ca931148ad
ALTER TABLE "hunt_logs" ADD COLUMN "message" TEXT;

-- arr-schema-atom column:48ba11052dd3c9c41c5935bfd99850742306d27a38bc8c4ffb1ba1d6eda15c1e
ALTER TABLE "hunt_logs" ADD COLUMN "durationMs" INTEGER;

-- arr-schema-atom column:e3888fad89535f9307e2b022f81225e0fd7af5248feb96ff602392196ecdc26e
ALTER TABLE "hunt_logs" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:3a6ae87d855d2c1ff58ffff5ed0ca3251401ec26bdcc6300b27a1868af45de83
ALTER TABLE "hunt_search_history" ADD COLUMN "configId" TEXT NOT NULL REFERENCES "hunt_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:9cf757637db0c2429d40e08e00998de7d82dbfc6ffcb29dfa4c42928b46574fe
ALTER TABLE "hunt_search_history" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:2bb9685f580f5294f9f82d832a0e8449a2d302242e3bae403045585326471d33
ALTER TABLE "hunt_search_history" ADD COLUMN "mediaId" INTEGER NOT NULL;

-- arr-schema-atom column:1d3547391810c368f9d4e8ee9c029e2c203e83e8220338932f5ab1e1c6a84230
ALTER TABLE "hunt_search_history" ADD COLUMN "seasonNumber" INTEGER;

-- arr-schema-atom column:1e487ff73a0e47d0cc9e7e14d2e426abc42e531946e7c14556805dc37049336e
ALTER TABLE "hunt_search_history" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:b543a9c52e502395cb57140f32562f5f3a4487ecdde35a89927386781e5f1b04
ALTER TABLE "hunt_search_history" ADD COLUMN "huntType" TEXT NOT NULL;

-- arr-schema-atom column:ded25463257b5053189fb4158dd4589b71263f3c72b725fc3687328d4cb61a61
ALTER TABLE "hunt_search_history" ADD COLUMN "searchCount" INTEGER NOT NULL DEFAULT 1;

-- arr-schema-atom column:cc1c586060050db1e664502d8ec848029688b7cce6523b3e0bbf6b5cab66a206
ALTER TABLE "inode_index_cache" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:6e1a45fd4c4fe966bf6a23ddfa67c1c51b3aff03e9733f0c5893448468715c0d
ALTER TABLE "inode_index_cache" ADD COLUMN "builtAt" DATETIME NOT NULL;

-- arr-schema-atom column:236ab9d84fb7a19430de7efd0f811f4949f2f45d18e08cf549dd70e8a5dd4306
ALTER TABLE "inode_index_cache" ADD COLUMN "filesIndexed" INTEGER NOT NULL;

-- arr-schema-atom column:d148100e360ec9099281b30b43e0ded4a040766a04d70bcac1ef0b846fce7650
ALTER TABLE "inode_index_cache" ADD COLUMN "serializedData" BLOB NOT NULL;

-- arr-schema-atom column:2ef5dbe35f8fefe733ec2afc7816f8ae6cd0affe644a27017ec653903429ad35
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:fa6a5736e21187059df47729d39a3d8de9cd166a12c41c8c407564f560b1445b
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "qualityProfileId" INTEGER NOT NULL;

-- arr-schema-atom column:8864a9fcd3bca2018899f1dce1ad3011470074f7f3e2dc6cef7d5176a431f4c2
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "customFormatId" INTEGER NOT NULL;

-- arr-schema-atom column:2a8d1dfdd443353e905bbe4c2c86815e403541c7df133c4857e8e12701bf1a96
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "score" INTEGER NOT NULL;

-- arr-schema-atom column:f13166b2187ec4f8b60d86f2e3c05baedd00c65b9be059c3e07e6d10116a85bd
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'APPLIED';

-- arr-schema-atom column:b4d5a36d7fde6fd1e731509f93314033b8c399d817390c88d850d1bca4099b65
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "intentOperation" TEXT;

-- arr-schema-atom column:4a41bbaffdf671cc69d0565ab951533699bac65939c83dd854a732f6735ee23e
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "intendedScore" INTEGER;

-- arr-schema-atom column:c75cc4e6043ca67cf7bbc91299d0e4fe47449a86a2b7d40d0ca5d83f3f9a5e5d
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "userId" TEXT NOT NULL;

-- arr-schema-atom column:3872c269fba5e59231dbf8e9cd5bd93d668e830f60e94ad6d208b00fe47291f0
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "connectionGeneration" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:fa19a23d5e9c1e699e4cad2ca5decb7d56f25e289806b197657204ff5cbe65bf
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "connectionStateToken" TEXT;

-- arr-schema-atom column:d4667b686335d98abcdbac34fb781a2539d5019b306b864bcecc441319feeb5a
ALTER TABLE "instance_quality_profile_overrides" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:c3c74848c94508421e6ea30ac943b401c995002818659d8044e91cc058f4c65e
ALTER TABLE "jellyfin_cache" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:af0db66c2230c1095ecbc1d6502621d5a1f96a4e2d853d8e0992cfa5d8bd7911
ALTER TABLE "jellyfin_cache" ADD COLUMN "tmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:5ee4ae0f318b684115c15567838cbbe3d179d40d5304864a0972fb12274beb38
ALTER TABLE "jellyfin_cache" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:6ec4418be1fb183f38ce3c9c1bea164ff6e3156bd7b116b036dd50a087dee12a
ALTER TABLE "jellyfin_cache" ADD COLUMN "libraryId" TEXT NOT NULL;

-- arr-schema-atom column:9b5154364261b98936ffed73bbfcf760b9bd5f97cf43cb75ba946cb8b4f88640
ALTER TABLE "jellyfin_cache" ADD COLUMN "libraryName" TEXT NOT NULL;

-- arr-schema-atom column:6bde83660fd46b0e76d581eba335039314dac83e19caf5a18d48f81e8604abe7
ALTER TABLE "jellyfin_cache" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';

-- arr-schema-atom column:fd205544efcb61cca0269134fd236abbbbf5e66a841c4725bbcf0c48d2390289
ALTER TABLE "jellyfin_cache" ADD COLUMN "jellyfinId" TEXT;

-- arr-schema-atom column:a7f2b9facad17deb1ba131d45de87e6b1bc1c0f20d511b7f01258d1aae4d3211
ALTER TABLE "jellyfin_cache" ADD COLUMN "lastWatchedAt" DATETIME;

-- arr-schema-atom column:c66daac7af71291bab4a9ae496b43f3ba2d68c1cd2dc94112f9f5dd3c5afdb20
ALTER TABLE "jellyfin_cache" ADD COLUMN "watchCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:4224585f5d36d6799165ca987ecf3a5acae9d5bf13b702b7dc667b9cf1da6be3
ALTER TABLE "jellyfin_cache" ADD COLUMN "watchedByUsers" TEXT NOT NULL;

-- arr-schema-atom column:690a5abc587a4cf8095d98ae05806f522b7b97118c9b7b8a6c68b427bc379572
ALTER TABLE "jellyfin_cache" ADD COLUMN "onDeck" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:8cabfe6c0bfafadc995af0fba27cc4b7d97b2ac5786c28b50289ecc972537f2e
ALTER TABLE "jellyfin_cache" ADD COLUMN "userRating" REAL;

-- arr-schema-atom column:f9973d870d8b33d7bf8a41da108e3af4c82f0ecfda4471f616126c199d138d27
ALTER TABLE "jellyfin_cache" ADD COLUMN "collections" TEXT NOT NULL;

-- arr-schema-atom column:b54f85fb948f994f9ba4b18ba6b12e89e18ae5be5184d89f8b437aa2e3598df1
ALTER TABLE "jellyfin_cache" ADD COLUMN "addedAt" DATETIME;

-- arr-schema-atom column:46c228ec39f0e9054844b7dde4ee3a7d5f1dd22b7719ae8db11e90de92c3779d
ALTER TABLE "jellyfin_cache" ADD COLUMN "thumb" TEXT;

-- arr-schema-atom column:3ccea8d84528ea0d9e8138f12bee14d9a4227c9fb6505fe8d4370c57b6ce4d88
ALTER TABLE "jellyfin_cache" ADD COLUMN "connectionGeneration" INTEGER;

-- arr-schema-atom column:abf4678974513f309a1ff7c09aaeaeb0fa5bd20e1b8d2581e28ea1e4ee5c3159
ALTER TABLE "jellyfin_cache" ADD COLUMN "identityGeneration" INTEGER;

-- arr-schema-atom column:e356e2f9dfbd350bf4b5c5cc3c8aed70a4c24d7e81f7f7020065d22ff53e7b9b
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:dbfbca358b6d967d65e98d8b8bdbe7d9b004c0ede1a32b3ed6eb45260618d9cb
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "showTmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:7ec3e397ba81994c662f9d64745251ad028bf9f32312a21b18734dc6ab1432c2
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "seasonNumber" INTEGER NOT NULL;

-- arr-schema-atom column:cfe5936e840aeeb8124b72bb7d57f93587754df905a08b7bb0fa9148980b2ad4
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "episodeNumber" INTEGER NOT NULL;

-- arr-schema-atom column:eacc02b5bef2cb7b4c9f0c98b0dc18597fd1933b63184e80e5757da9a5b4bc1f
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "jellyfinId" TEXT NOT NULL;

-- arr-schema-atom column:63d925d224aeb85730958fcac40c3ef9ad1f5fb9d5113fcf1f45cfafda33a427
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:ea00edc1da61af3639ff069543aa2fa41be9744878f55dd6352ee0f8db23f9de
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "watched" BOOLEAN NOT NULL;

-- arr-schema-atom column:32a5bea0e2bcd54ca4cd791898206b156bb4a4f3b66f2a64d8dddbae7797342c
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "watchedByUsers" TEXT NOT NULL;

-- arr-schema-atom column:9f50a22e2f5ef8ec6d9f1b10e1d1cb64a17d071d04a39c3fbd2c3e61ff8f5901
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "lastWatchedAt" DATETIME;

-- arr-schema-atom column:0150d4420214cae0b7ab3be81647f2cf5f8753a62107dc8da03ef4e6b664285d
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "connectionGeneration" INTEGER;

-- arr-schema-atom column:87f53759fc9346118f767062b1e14ba3b66e8bc9655dd31e4eef9453d7a60d3e
ALTER TABLE "jellyfin_episode_cache" ADD COLUMN "identityGeneration" INTEGER;

-- arr-schema-atom column:760fc3a59f80ce0963b77fef45e9661041299eb7e8beff7eee9a7df28a911606
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:aa57944099e7b1ee3d264c3e452b5a614b0e4cb8d2f9d271894445d2b3df1ecd
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "generationId" TEXT NOT NULL;

-- arr-schema-atom column:3dfae7361ecb8f5d757e449b98c3950728c28d9cf6c353d98826d5037c1349ba
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "showTmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:ad890bfa1166618e101178fff223e1f07a12c2a30ae07b1b4edc81484553f9fa
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "seasonNumber" INTEGER NOT NULL;

-- arr-schema-atom column:583aa5c694dad39964a67973144efc6685e6d0926ccefb55182923f4d86ba70b
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "episodeNumber" INTEGER NOT NULL;

-- arr-schema-atom column:cf5c337ac0403b55638a347d542ffac2a509b85f49a0785a6b76487e7811c8b6
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "jellyfinId" TEXT NOT NULL;

-- arr-schema-atom column:05aa783b087ccf00df73efffa2e15d13ea9f67e57348c5c05469cac14581a105
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:44194d01faaef24828a633a41b1475c22c76141187cea7e2289ba0c1d7d8ea09
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "watched" BOOLEAN NOT NULL;

-- arr-schema-atom column:fb7ce8531627827156beed1d6d316ef66a6b594c306010aad4ab0bb653d3231e
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "watchedByUsers" TEXT NOT NULL;

-- arr-schema-atom column:f8cc72f964a82206f66e8897b137beda785cfb74a453e9e8dd3f9346cd82d96c
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "lastWatchedAt" DATETIME;

-- arr-schema-atom column:c1c78fd5b491ab8ff00ac4a99f7ce2e8c784d4189746e1b926f78baad8b9ea34
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:65a324941f335288a9ca7161bab88b1953d9108fdcee1e119ed9541b7ff9a945
ALTER TABLE "jellyfin_episode_generation_rows" ADD COLUMN "identityGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:9688512b6c520333cfd2608b937469afc05857d65df637193accf33806125af9
ALTER TABLE "jellyfin_episode_generation_show_receipts" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:38f227c6637c45e7e05034ede3b5912b15d3ba3dec1eba89a515d557c1633a59
ALTER TABLE "jellyfin_episode_generation_show_receipts" ADD COLUMN "generationId" TEXT NOT NULL;

-- arr-schema-atom column:1815b442c980104702185b43e79c9bff094a973a346716f494c5a4a5a0169c09
ALTER TABLE "jellyfin_episode_generation_show_receipts" ADD COLUMN "showTmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:67f9f972f22fe80de3224700b1076928f095ca150a32ff6432fff253a688b260
ALTER TABLE "jellyfin_episode_generation_show_receipts" ADD COLUMN "rowCount" INTEGER NOT NULL;

-- arr-schema-atom column:c40b1590f7274f779bf186b738f60db70482eed8f0a69edba50defacc70590d0
ALTER TABLE "jellyfin_episode_generation_show_receipts" ADD COLUMN "contentFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:dd628f8d93bfec0fc9b7acef0be12d9e305a95536cc61642ea114973e0d7a1e3
ALTER TABLE "jellyfin_episode_generation_show_receipts" ADD COLUMN "mappedProgressJson" TEXT;

-- arr-schema-atom column:073476704e79468047e080573bbc36d0e2f4b60c7b92e87eef14a9f4d9d621db
ALTER TABLE "jellyfin_episode_observation_exclusions" ADD COLUMN "userKeyDigest" TEXT NOT NULL;

-- arr-schema-atom column:bd224cf8f5c5aae17752814f4208e1d24c22d93ead2921def010d1fe08389e4f
ALTER TABLE "jellyfin_episode_observation_exclusions" ADD COLUMN "pass" TEXT NOT NULL;

-- arr-schema-atom column:361b074acce019f77fc5412a951a9e9e03998a9005bd00d49122be916f759ccb
ALTER TABLE "jellyfin_episode_observation_exclusions" ADD COLUMN "jellyfinId" TEXT NOT NULL;

-- arr-schema-atom column:29d56136267c37dd8168b4c6c381a7410d1ac01704afe0c402eeaa2924ec12b5
ALTER TABLE "jellyfin_episode_observation_exclusions" ADD COLUMN "reason" TEXT NOT NULL;

-- arr-schema-atom column:b2519d7493b3cd84d9bf56778c0acf0744b6f105033266be16f9b40aec3be30f
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "userKeyDigest" TEXT NOT NULL;

-- arr-schema-atom column:9e0cf4c70952519779ddf671519cba6b6a9d412ee528c67b8e49e86f9fe22839
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "pass" TEXT NOT NULL;

-- arr-schema-atom column:ab7b7ed7f06f80965790c93637acf6e09cda9eef3ee41f9fdf79e6f8ff603074
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "jellyfinId" TEXT NOT NULL;

-- arr-schema-atom column:921a8c78878bd86f833ff81334f6d239197d9793b06b2e73c998f9927c52dd2f
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "seriesId" TEXT NOT NULL;

-- arr-schema-atom column:2015c40343418480bd3c338851478690540d24112d9724fb723457a433dc3f83
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "seasonNumber" INTEGER NOT NULL;

-- arr-schema-atom column:7cad0119a2601e52eb081efcbdd1284254e5bf476cbe0c3afc38650958aa3233
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "episodeNumber" INTEGER NOT NULL;

-- arr-schema-atom column:ed4395adeeff13c6fc9344eb501bcb8bf56d468ad5a50058b22e9b7d1b998ee8
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:b495e8fa193ff97f90ff04d7e862badca051ff8235a9318768df2996d326952c
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "played" BOOLEAN NOT NULL;

-- arr-schema-atom column:b168fccc4a4596e697e63d0529965726b92bfa3ed582e47d3fbde1ca03d7ec7c
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "playCount" INTEGER;

-- arr-schema-atom column:784e2ec1807406b117a5349a0dd7326b3008423862cd9b6dc6566098bcaacc5a
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "lastPlayedAt" DATETIME;

-- arr-schema-atom column:33e7ae98cccc2216e725824add01792fb3684d483192f41c7d61865d72c42460
ALTER TABLE "jellyfin_episode_observation_stage" ADD COLUMN "userName" TEXT NOT NULL;

-- arr-schema-atom column:390a624b3cd2d9e45d8c53a930a6e709643d5fd8a9b1438b8ffd74f645b5bef8
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:b3cba44002dd01f877c632424183af4cf347dc6b5d405de6d45526dae84af436
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "generationId" TEXT NOT NULL;

-- arr-schema-atom column:2e41684aa760aa83da0e4163d94906dc7500101796cf033c86313b1d6d35d44f
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "token" TEXT NOT NULL;

-- arr-schema-atom column:dfd450055ad2f9751690449b1f743b7c89b7795d23955d94525ea573decf401f
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "leaseExpiresAt" DATETIME NOT NULL;

-- arr-schema-atom column:e922c23f1cabbeb94a1739ef1bb135857518635b4e4c049650b85e34d6145430
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "state" TEXT NOT NULL;

-- arr-schema-atom column:ec086b89890797fc84b7d5946d80023836de461c5c243579cee238d2d6331409
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "expectedRowCount" INTEGER;

-- arr-schema-atom column:c16be0f84c5f8c3dd2917c0aa4bc4b285690c1df2d213c542acde7eb9be9d9a4
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "expectedReceiptCount" INTEGER;

-- arr-schema-atom column:01585ed12247c76c84486088a8a7d1f11233086f454f871882c6dca7f2b9272a
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "contentFingerprint" TEXT;

-- arr-schema-atom column:34cbe33a336f82022d025ba606ca0267858a1cfc9652e2bc9d428ea80d8282c8
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "observedAt" DATETIME;

-- arr-schema-atom column:78d5033a2585afdd1a49de9712f380cad82398bc5d23cc4acfb34fef7d22fc92
ALTER TABLE "jellyfin_episode_preparations" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:00eefa530f912cb74099467b0bbf499802386b28fe0810dad839babf1469c9f6
ALTER TABLE "jellyfin_native_watch_publications" ADD COLUMN "activeRunId" TEXT NOT NULL;

-- arr-schema-atom column:229db65957e42dd57ef81ad970a23bef39a1388b65f3df839748f8e03a7ce1fd
ALTER TABLE "jellyfin_native_watch_publications" ADD COLUMN "activeCacheGenerationId" TEXT NOT NULL;

-- arr-schema-atom column:dd170520c0c6e710968bb28deafc7471f2a42ca52d729245bba6fa51bf25998b
ALTER TABLE "jellyfin_native_watch_publications" ADD COLUMN "activeObservedAt" DATETIME NOT NULL;

-- arr-schema-atom column:aab9bd844fbdff961b402f4d44695627e5f2af8aa1072a4c4731e580eeb9b4ce
ALTER TABLE "jellyfin_native_watch_publications" ADD COLUMN "activeExpectedScopeCount" INTEGER NOT NULL;

-- arr-schema-atom column:707bd21e8191142e75917ed3d3ed050b62b606a39fe6c35ff81781576dc38d2f
ALTER TABLE "jellyfin_native_watch_publications" ADD COLUMN "previousRunId" TEXT;

-- arr-schema-atom column:16b25744f8e9c94cb95774cf7be0b2c479eafe56e151286f0dec4666e7d13e71
ALTER TABLE "jellyfin_native_watch_publications" ADD COLUMN "previousObservedAt" DATETIME;

-- arr-schema-atom column:65296b3b758838630c48a48f2f0e8b6a2117a390b58f2c20bf27b51d164f4a52
ALTER TABLE "jellyfin_native_watch_publications" ADD COLUMN "previousExpectedScopeCount" INTEGER;

-- arr-schema-atom column:ea45bdd7360150a8c711674b9129b6f680c712931a5c65542f6ff1511efd5b24
ALTER TABLE "jellyfin_native_watch_publications" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:b3f5c4ee8d7d60c392caeea7a02fb7fc0fd4fe6996d6dc101ea172b0762a94ab
ALTER TABLE "jellyfin_native_watch_publications" ADD COLUMN "identityGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:ee92692307fc015179b76737ac5d1890b78d9743ac28bd8c1bee356f26a47a3d
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:1b3c577559dc855bda32d2e4df410d1e16a02ac2475b36179b08d7497d2f31c2
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "runId" TEXT NOT NULL;

-- arr-schema-atom column:73a77376eaf60337840bd86840573140eb4d362ab64e32ddf861a62c9d9b2d7b
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "userKeyDigest" TEXT NOT NULL;

-- arr-schema-atom column:5f321955ba6e1595184d1f00749d4fe66598861a6d6ce18df4d824266cace2ea
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "libraryId" TEXT NOT NULL;

-- arr-schema-atom column:884c3c55ade5d9c0ccc7999c834d3f158a3565cd49c95e8613a4520dcb9f1b7f
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "jellyfinId" TEXT NOT NULL;

-- arr-schema-atom column:d594a08487e04381c1ee52e06246547e2af0ce133a427eb9ab4fd4dd6283e95c
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "seriesId" TEXT NOT NULL;

-- arr-schema-atom column:e5f48b63f41c656ad5f6d3502ea29a7aa71763835567900833094c6635c699c3
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "seasonNumber" INTEGER NOT NULL;

-- arr-schema-atom column:59f7fb145473761020e602d79a1d7fd08259b084f82f18ca14d1d42a9d24b4b3
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "episodeNumber" INTEGER NOT NULL;

-- arr-schema-atom column:174324446b5a2e28a581d3f02dc63e885d7556a6b56d00930eb617e227fa9843
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "played" BOOLEAN NOT NULL;

-- arr-schema-atom column:ceed2af7e5dd7f0cdc4f0755293725794b88b53ba3e4ecfd8a60c42c12e820c9
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "playCount" INTEGER;

-- arr-schema-atom column:b5cafd3111b5f98b96eb0961b1252c57dc65a484068a2bfcd21c026045f11e86
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "lastPlayedAt" DATETIME;

-- arr-schema-atom column:cc628ea530b7cf698e7df168d4386b1d24aaf270a8a24db9dc12ba8688e8ad70
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "observedAt" DATETIME NOT NULL;

-- arr-schema-atom column:32221d1551eabbbafe41dea595bf7710c477c0d3ba1c91e2c3dfebdfd7c17bca
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:2497b4f8e34942e4dc616b904429b85b014e54a1c6f7bcb0b155441e76bafc8d
ALTER TABLE "jellyfin_native_watch_rows" ADD COLUMN "identityGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:499660a251a36abff1ba0f5ee3957bcecb98dbfe464d228ae23cf0ec6f42641a
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:055e94437c66562377f6bc6c94e033be146cd6bba9f39e17e65c67f6cfc7167a
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "runId" TEXT NOT NULL;

-- arr-schema-atom column:b247eac1613f2a2edc72324ad838d1c8da7a2face8c5ec39b18815c463b12d7a
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "userKeyDigest" TEXT NOT NULL;

-- arr-schema-atom column:ce23b694259a618b7c9a3f851393a84c736ef1fce4a973935cc189df9fae52a3
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "libraryId" TEXT NOT NULL;

-- arr-schema-atom column:802dd2bf802271c659d416f20fed0adcf0ba42867a6689a7d9c4a63d59445f64
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "expectedRawCount" INTEGER NOT NULL;

-- arr-schema-atom column:c7da69113764f11297c1276f5ff028f4daa4638a4dc2149463402a740814fd2c
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "observedRawCount" INTEGER NOT NULL;

-- arr-schema-atom column:bcc802b47c674f7f7fd5ef41cfa03068f31baa675b1ae0e5ccfef4a4b0682b36
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "exact" BOOLEAN NOT NULL;

-- arr-schema-atom column:46e7ccd9508710d5ed1d08722d44d9c578d275dada1e2656ea067c8f7d40f84c
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "contentFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:3415605d602b8509e957114440b757e4e03936e0efc602987eb664a53db08572
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "diagnosticsJson" TEXT;

-- arr-schema-atom column:06b2dcc3650fc952d364f8b30cc4927f4cbb0c5a8229f306a95645813654504a
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "observedAt" DATETIME NOT NULL;

-- arr-schema-atom column:04d2abff20989e21f637d44feced49f1daf8d9c2057896f1e2a16a64641f3d36
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:33541ebe9470d4a4d88e65faa246885874c389acd71b9ab01c71cb1cbbcb3dd5
ALTER TABLE "jellyfin_native_watch_scope_receipts" ADD COLUMN "identityGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:ead9c703c94ed993e83bc1c3ab7d862bef703d30d2d7467308fcb8b4a3e1929f
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:1ac2a5124a67c4d62fd14cacf07f65efa078b37f5a61e90dfeb41485f0d40d61
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "generationId" TEXT NOT NULL;

-- arr-schema-atom column:82339153bae3f8834448a979dba472b23674cdf890a162aad7b70dedcec62e1e
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "userKeyDigest" TEXT NOT NULL;

-- arr-schema-atom column:5772000dcca6674813f6ce91cdd66e90b6fae203fbbed581b6040beb9815a5f5
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "libraryId" TEXT NOT NULL;

-- arr-schema-atom column:db7d957348938dcf402f7c34b9c15766fd4f56a8cc8dbf9ef3a4ab07b93ba33f
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "jellyfinId" TEXT NOT NULL;

-- arr-schema-atom column:debed06294dd21eed5f67f9c477cf04d869327c9e756ad3dc53429e9f11a2e67
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "seriesId" TEXT NOT NULL;

-- arr-schema-atom column:ccdd8d4099c53e7a034c538338f1f3c624376219d1de4b1adda25f2acc334cb3
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "seasonNumber" INTEGER NOT NULL;

-- arr-schema-atom column:fb72acbd8753f411b3693eed4a0db3653c2f74f8a5104788276ea64bd50b0256
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "episodeNumber" INTEGER NOT NULL;

-- arr-schema-atom column:f729a8281d9b928d81b34faf746d4fbc63044774888d77a4568e7ac3a5e18792
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "playCount" INTEGER;

-- arr-schema-atom column:d71a505e4bba0c298283067827f964f2bb97ab2ae439907b1683d2375f158d0b
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "lastPlayedAt" DATETIME;

-- arr-schema-atom column:eebf5b4137a5d04797b25d596014f52800eec73be9b7f43d635d271e6058da17
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "observedAt" DATETIME NOT NULL;

-- arr-schema-atom column:5fa8695d8a82f726af33af4494edc37c0250f96e4e5f90b120621a6c150f5ef5
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:7a73280cdb62be43a23e51d2a2e036bebb723573941cfb466af4bd5484b3c163
ALTER TABLE "jellyfin_positive_watch_rows" ADD COLUMN "identityGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:c12517e5c3164e158bdc3b681ca8c82e14226d92a4c4ce2bab4f0b4798f90572
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- arr-schema-atom column:ac0b6ad99d0a57beb2425ef9a7f4867c3563eb8385eeb641e16f1ef0b5679bb8
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "ruleId" TEXT NOT NULL REFERENCES "label_sync_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- arr-schema-atom column:e5075af9f57b0074967c0b3e6ba6dd3bb2366d51d4ad435c4f580c8fee0a2691
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "destinationInstanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- arr-schema-atom column:2e3b623625b3ea02e246f24e8a8c19f677dd882f2fbe7c218e2dbc1c06b6123e
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "provider" TEXT NOT NULL;

-- arr-schema-atom column:3c06b98a408262bf181f3cac91a20ba419433b2792b49a1cf0f01879d017c0de
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:ae93bfa466f71e1863cc24e9c8aa40ffec9ffd76a8e075377c1a25ca069c4a11
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "tmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:d88af3e84f9a9682f05026ab6e0f28feef842b3cd62ad0d376fecea8c3238c98
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:f2c83724e0275bdb67270b2ad72f4a17e9f967d1788d1bd4963e24080995a539
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "identityGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:d64602c36da15d4a997dd9000de88227a1533e7152bcc33c1386439cc872aacc
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "targetItemId" TEXT NOT NULL;

-- arr-schema-atom column:56cbd2ae868a23d12c2b75aca4df5975f9073594453690b49222ed418ea841f5
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "libraryId" TEXT NOT NULL;

-- arr-schema-atom column:c18528496e2e2f3b1860ee4f05c75640e6b752eb484f84b91b6c0027bc401d1d
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "intentFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:e4078e516c6d2db5f88072064b060743bc6c1699fa62eee46f72edb5dc5f8eb8
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "ruleFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:d30d06685ba99ecc61081c128b3774170747610f9851bd70d37abb61cb5984d3
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "destinationTag" TEXT NOT NULL;

-- arr-schema-atom column:1d56dc63dce1c38037018b640358d3afd0a7e6a5922e269844474e71cbdbbe82
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "activeOperationKey" TEXT;

-- arr-schema-atom column:6558716e0f44df168ca681ab57d60c272124190a6748cf74824fdd6c902b9cfd
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "claimToken" TEXT;

-- arr-schema-atom column:8e402727f068f98fd130e6187889b2b7d9d5dfbd49150671023f70ddce9d9d77
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "sendAttemptCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:edf8cd335542c1a9878d9b8c1d24982d05e17d11ae4fb2f692e025c70561d92f
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "reconcileAttemptCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:d78148f70ec80637b05624806c8885442dbc024e3b2c16b7a0aa5f89debab1a7
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "requestStartedAt" DATETIME;

-- arr-schema-atom column:41ac34f8de7cf2671b771ee9a90a82da9f5a4e9316c46f700655ed178bd160d6
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "lastObservedAt" DATETIME;

-- arr-schema-atom column:a38b341c7f6f5aac57743120cd742dd4c8e4044db9d619d02014b823f550fa81
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:034df865029d5b5927da85793a617c23611e55311f49ba816c8bbad75553da4f
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "status" TEXT NOT NULL;

-- arr-schema-atom column:8391375f0a2fd19d36294cba6a133e49c113b4adb7438fbdc7b299a320e7ea2d
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "reasonCode" TEXT;

-- arr-schema-atom column:7b59025bd127be11aa9d898780770aa42bcb962579de301b6ce72cd9a79d8533
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "restoreEvidence" TEXT;

-- arr-schema-atom column:8d94f7a1eaf3062e3bcd18c7c1f3bb7e2d8f925b66dc995fc0b212584b7ea157
ALTER TABLE "label_sync_mutation_attempts" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:f56d326c3f3feb4671acd8048b1ae02899399e1835ab4404bc63545c13190b40
ALTER TABLE "label_sync_rules" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:664acfc8d51940c82ce20baf3f69696314fb6d7f805e9065dd5c9c429c3d8434
ALTER TABLE "label_sync_rules" ADD COLUMN "name" TEXT NOT NULL;

-- arr-schema-atom column:c0a2857cfd2c538b4bd137fea75de10c136ef344cf72dfb66f533481db75d099
ALTER TABLE "label_sync_rules" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:3510676d867b5bdaf16b1979dee9b94a3da9fbe0ec41a1a5c96f5a9640f8d34a
ALTER TABLE "label_sync_rules" ADD COLUMN "sourceService" TEXT NOT NULL;

-- arr-schema-atom column:c2559aa90ba47a9aeb2c7ad237442714d274b370339573fa00d628afc4152c3f
ALTER TABLE "label_sync_rules" ADD COLUMN "sourceInstanceId" TEXT;

-- arr-schema-atom column:c0f81fb56b9e6be95766e2d9359068a5a5fdf0ef3f5ae9f4c989f632af2b608e
ALTER TABLE "label_sync_rules" ADD COLUMN "sourceTagName" TEXT NOT NULL;

-- arr-schema-atom column:b0a3364c3e3fe8eba2b9140ee67b6ade3bc0dff25701c1a7868901e14138dc52
ALTER TABLE "label_sync_rules" ADD COLUMN "destService" TEXT NOT NULL DEFAULT 'plex';

-- arr-schema-atom column:562a0675d1d57703636a6108570216e1305c9fb20748c0758c4cb50e8d0ecd70
ALTER TABLE "label_sync_rules" ADD COLUMN "destInstanceId" TEXT NOT NULL;

-- arr-schema-atom column:4298bec5cf22ea05f0a63085be1f2d7b91de4341e04faee65eeff9b873d0d968
ALTER TABLE "label_sync_rules" ADD COLUMN "destTagName" TEXT NOT NULL;

-- arr-schema-atom column:9add403103ecefe796f7e3f770bc8bbc8d7ea25affe1c881530148e5de3e4445
ALTER TABLE "label_sync_rules" ADD COLUMN "lastRunAt" DATETIME;

-- arr-schema-atom column:a0496864d985327d43dba416c9fe860d6225fbd67b7e418556ebb8c5a12f8bf3
ALTER TABLE "label_sync_rules" ADD COLUMN "lastRunStatus" TEXT;

-- arr-schema-atom column:0053a628e9084241173f4c2dec61da16bea48bfb2e8187f47fd1ac925cb61ac3
ALTER TABLE "label_sync_rules" ADD COLUMN "lastRunMessage" TEXT;

-- arr-schema-atom column:a08b5a916bfb2c3b6b9587e501ab3fbdf9696a469c2c8b3fc7c95882a30c9148
ALTER TABLE "label_sync_rules" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:01a5a8adb421b34f4d7b5fe34248a6734ba59609730fca4b318c3187b685dedd
ALTER TABLE "library_cache" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:942f5d64073a18e8077ce0063749b2b03e8a613ba7afd8382f2c7e73966965d3
ALTER TABLE "library_cache" ADD COLUMN "arrItemId" INTEGER NOT NULL;

-- arr-schema-atom column:fa4b9d3b175ab9b588cbeef60bde19e0a94aebe433da8f7281a2e75044e40da7
ALTER TABLE "library_cache" ADD COLUMN "itemType" TEXT NOT NULL;

-- arr-schema-atom column:30183d1c80df6ed5bed0b58f1703b3540169f5a91b4428d9ac29ec46be152e3e
ALTER TABLE "library_cache" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:3be4db54857ed0882f2e92daac9ebaddb3efc95c3e9a3ec868213d96f26f0497
ALTER TABLE "library_cache" ADD COLUMN "titleSlug" TEXT;

-- arr-schema-atom column:6c9b234890eb54926aefbaaa8b4085ce811d84fabe9f4d5948c7970a885ac7b4
ALTER TABLE "library_cache" ADD COLUMN "sortTitle" TEXT;

-- arr-schema-atom column:ab060434f4125aab44da4c1bbfc3b105616b674d3db6d3f3ba769565a460960b
ALTER TABLE "library_cache" ADD COLUMN "year" INTEGER;

-- arr-schema-atom column:b7c32a02c362374b9de7090e94f828773b55134646f021ec81f2f58b232f8781
ALTER TABLE "library_cache" ADD COLUMN "monitored" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:2cf5603507b64aa2a207d10f669171f99bd1e097af7c84c5722c7fc9a9df8926
ALTER TABLE "library_cache" ADD COLUMN "hasFile" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:06bb4fc23a36ba8c55af09d0a8cbca834909a4e922c2d75e3fead7581eaeeca6
ALTER TABLE "library_cache" ADD COLUMN "status" TEXT;

-- arr-schema-atom column:c99b9814fde357ed1f7d1e44a6c48a8d4719d2f2242478d95448452d8b2f5b76
ALTER TABLE "library_cache" ADD COLUMN "qualityProfileId" INTEGER;

-- arr-schema-atom column:a77588b2d58d597b5cd68452718379f6294321dc96c26d3717a2b0d567d6a1b6
ALTER TABLE "library_cache" ADD COLUMN "qualityProfileName" TEXT;

-- arr-schema-atom column:cd3be4c8f57219b4f3277e32a45bb8347c56d58c2111bcd4f0e572aeeb479945
ALTER TABLE "library_cache" ADD COLUMN "sizeOnDisk" BIGINT NOT NULL DEFAULT 0;

-- arr-schema-atom column:dc9c7c02726be99be481813dda33b3221b167f97b9039b87eee4d10d3f3a8413
ALTER TABLE "library_cache" ADD COLUMN "cutoffUnmet" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:fec7bf72030112ef133969cc604a3518226cfc5bd9354ee6af5284a68bd4fb84
ALTER TABLE "library_cache" ADD COLUMN "infoHash" TEXT;

-- arr-schema-atom column:778da235497c5e5bf41d1fc24bb6c6615c5994e8b737cf7025559b58ce04e23e
ALTER TABLE "library_cache" ADD COLUMN "infoHashSource" TEXT;

-- arr-schema-atom column:4c4cbf17ad6486499cbed6b112bb3f98f489733b14f89c2b488395741f278c7a
ALTER TABLE "library_cache" ADD COLUMN "pathBackfillRetryAfter" DATETIME;

-- arr-schema-atom column:202f1d91bb153eb398585da1cd339a50220f63d672e6e63591da37583cecea40
ALTER TABLE "library_cache" ADD COLUMN "torrentState" TEXT;

-- arr-schema-atom column:56e0347f73a2bf4ca64b06939dbff8b1eebfa92928089689b28209f99dc00639
ALTER TABLE "library_cache" ADD COLUMN "torrentRatio" REAL;

-- arr-schema-atom column:23fa02a8e2f8769fa824d21f23f52d6011aa78ef207ad807ce40f570ffd78dac
ALTER TABLE "library_cache" ADD COLUMN "torrentSyncedAt" DATETIME;

-- arr-schema-atom column:ffcbf97a1b61d5d8b99dc693f5514a017b8892ec6301cfa928d86b35783c55d1
ALTER TABLE "library_cache" ADD COLUMN "data" TEXT NOT NULL;

-- arr-schema-atom column:dcbeab8c8c1ce0e0b7957c3a6151c4fc908ddba8d5586f24867b25cc08c10570
ALTER TABLE "library_cache" ADD COLUMN "episodeFileInventoryReceipt" TEXT;

-- arr-schema-atom column:797334e6d5ab1c39ed01e49908d72ca4a01a969bac93a87202d99021711b6b33
ALTER TABLE "library_cache" ADD COLUMN "episodeFileInventoryAttemptedAt" DATETIME;

-- arr-schema-atom column:4d1ae476b9009b78b5110d9e656846d8f1aa95f19d50cd231898dabb63e60d9e
ALTER TABLE "library_cache" ADD COLUMN "episodeFileInventoryAttemptToken" TEXT;

-- arr-schema-atom column:678830976be020af12140a6300dc402c43cc9c13806311b478ae752036eca0d1
ALTER TABLE "library_cache" ADD COLUMN "arrAddedAt" DATETIME;

-- arr-schema-atom column:dcf6fd831c6e31b2f4547f56becaac0a50aef0e2b5c2725dae5dd7b211e296c4
ALTER TABLE "library_cache" ADD COLUMN "arrUpdatedAt" DATETIME;

-- arr-schema-atom column:f71976f5b9834ba15caf33bdf2abb73d32bec7beb2cd5295cd4cd629d54ac84c
ALTER TABLE "library_cache" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:289c5ab5e0bb150e6a16e66bf10fad275b33e31702992acb3274200dff60eb02
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "configId" TEXT NOT NULL REFERENCES "library_cleanup_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:6c422d26e23956737e28c99f9bf84aec05e89abd7726f6043603d5d5f2c1f6ba
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "instanceId" TEXT NOT NULL;

-- arr-schema-atom column:5c5c24d3fb39417810d57d995f36f237669eb97b44eb8660ad9b23a042bffd86
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "arrItemId" INTEGER NOT NULL;

-- arr-schema-atom column:f3eb87e87c1fe0ce2b27cdae57a43d57573ad23a9d5659842d29875fb4bd5f99
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "itemType" TEXT NOT NULL;

-- arr-schema-atom column:0ff00b01742146c71d7421972de7805286034cfb7e9cd8a3f7ab39d39a82acba
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "targetScope" TEXT NOT NULL DEFAULT 'series';

-- arr-schema-atom column:9706b8508d9c01e5e4f45100e0516940fea190f8e7fc51e64cef192fd7e2f779
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "arrEpisodeId" INTEGER;

-- arr-schema-atom column:ff271842b7537f645111134515c6104cce5beaecc384dbe69e8f9e454fa34326
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "episodeFileId" INTEGER;

-- arr-schema-atom column:2b6310056059f3bbd231a18cbb00833be77699cb3ec20d7ea8054cb377e7c834
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "seasonNumber" INTEGER;

-- arr-schema-atom column:f45d3c0431a23452b632dc25ccc78c26ff16e91a1f759295e2b23f5315c12f5d
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "episodeNumber" INTEGER;

-- arr-schema-atom column:c4b6b496145f80232c4c45cd93559ed2887a94b705c8e102ea40f699a3b5d0fa
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "episodeTitle" TEXT;

-- arr-schema-atom column:9ea07b38651206499a880f03b4d2abb913be7ab0234d793d02e95dc4b156b193
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:a93b92e5e9f9ecd3b7bf9b421f689ffebff3a80cfde458c3d1e0ca91927a6d29
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "matchedRuleId" TEXT NOT NULL;

-- arr-schema-atom column:ffd9913c7db74f9caeb25652cb1936fcbac31c4762b17747dbd49f27a7311330
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "matchedRuleName" TEXT NOT NULL;

-- arr-schema-atom column:b7aa72acbbc74dbfce19032888151650358f88e2f9caaece07aa012a983999e4
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "reason" TEXT NOT NULL;

-- arr-schema-atom column:0929942d3ffa151b5c8fd7166957d26a7f8f255841075f6d28ac3f89f8c742db
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "action" TEXT DEFAULT 'delete';

-- arr-schema-atom column:9ae1216d91a802865ef422b55d8b90a8d82a8b4372122619e4c47b4dbee7e01e
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "scanMediaServerAfterDelete" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:91fc53bd1a40ca5660435b988982cc88c0da13f922eced38f56896a9f6d2c39d
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "sizeOnDisk" BIGINT NOT NULL;

-- arr-schema-atom column:62dce4c3cac38f7607133a872d67f03a13852ef854daeda69f3faabe8c74c580
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "year" INTEGER;

-- arr-schema-atom column:29237b1609508d6e176d468e9c3d46b2e2c864455208140a37faebf44b725bf3
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "rating" REAL;

-- arr-schema-atom column:2f675ddd76473abb5e7f6c20a94fb0355c472d3090f4db49d26c7ffe9c1ad540
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';

-- arr-schema-atom column:229dfc4587603ed5ad0e4540f323ed2b8da48dcf8b2b21e59083aa25726b1393
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "executionToken" TEXT;

-- arr-schema-atom column:297e21bf6e5c882a40fbff19aee9b6d2ea5a0e4cd6be1d69accc1dd9262779bd
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "executionAuditCorrelationId" TEXT;

-- arr-schema-atom column:b2c9a4741af880e8bc3efbc11ab31884018f961378ee9bcffc4bf3d70dd4d6c6
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "reconciledWithoutMutation" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:b721ce67924c9c54d2f059528970fb5b0a2ec0bbdabd066f99de7c0b1a9db522
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "terminalAuditRecordedAt" DATETIME;

-- arr-schema-atom column:ed2e0f4bcb225aef2a034116e4b391182030c59c59a1eb8b70e1ad29c9086363
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "terminalAuditRecoveryAttemptedAt" DATETIME;

-- arr-schema-atom column:2024acedbd938c28a4154112c6713b96554fa2c0eed26d1f122f535ade6b2e59
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "safetySnapshot" TEXT;

-- arr-schema-atom column:6cf8e368a2431b850f8354822d3752666d7055dd182e685abdfb95aa0f6c99b2
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "lastExecutionError" TEXT;

-- arr-schema-atom column:8bd1b5ab15f523ac6a6c10b2cd9924f697aae9e5a2d6162783bf272220d2e9af
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "reviewedAt" DATETIME;

-- arr-schema-atom column:dcf092fa6805153e21ca9b09f057d5425515f27f904237b42f687f62313ccf67
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "executedAt" DATETIME;

-- arr-schema-atom column:931bcbf5addcd1a35242fab563904afee20c603056faf69366a2f94040c63072
ALTER TABLE "library_cleanup_approvals" ADD COLUMN "expiresAt" DATETIME NOT NULL;

-- arr-schema-atom column:f8dba48fa7665ebabadebbf532f52318cff342d6d7719cf5ad7ddd35d574d841
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "configId" TEXT NOT NULL REFERENCES "library_cleanup_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:311ca33ffcd4a351409d3eb0922a6f5548ff73e655f534c1e868add134e99849
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "actionId" TEXT NOT NULL;

-- arr-schema-atom column:7344e8fa24d54898e523287516b80c8a0a80f7608942f65940f79ebcf1b859bf
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "correlationId" TEXT NOT NULL;

-- arr-schema-atom column:5ccb75636d8e8d98cad882a03cf12f162a237bf17d5d877584bb35e52e0ab311
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "eventKey" TEXT NOT NULL;

-- arr-schema-atom column:a4d57b12641caab5135ed4ad68f3c1e8d15af0d9b55229b35c1d3e49ae19352c
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "sequence" INTEGER NOT NULL;

-- arr-schema-atom column:c3e505adfce9a540993d635e402cdc06a060b941218d5f450b607ee3d8612823
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "eventType" TEXT NOT NULL;

-- arr-schema-atom column:5ad50f345426cf175320ed2aa80a4927f60f8068e2ccfbd8511c1e8f8c6a9447
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "outcome" TEXT NOT NULL;

-- arr-schema-atom column:762ec1279241d9e45ce02d0d78d9981cd6c7ff9721f77da9bf934b7835fbee32
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "trigger" TEXT NOT NULL;

-- arr-schema-atom column:1c2e78aed704e9ac71e70d984335bdd1449507afac508174779c216578be7b8f
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "actorType" TEXT NOT NULL;

-- arr-schema-atom column:4121b7b08b9b94ba35d107788a443a61435ce50cd2e138e67a8c125a26fce733
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "actorId" TEXT;

-- arr-schema-atom column:a8cc38b0f4ec6ce883a03905cddcdb36010dd17a240a7ffa5a19d89832e6f364
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "approvalId" TEXT;

-- arr-schema-atom column:eb4b5b5cb2c9d12b5449f655a2e728752527d2ba2fe032c24346c1507b28a213
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "runLogId" TEXT;

-- arr-schema-atom column:430a7d035ce5b023bed9a062e569b3c17616a531a4b4d8b957f8fb1012e44fc3
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "instanceId" TEXT NOT NULL;

-- arr-schema-atom column:00a37a149e9f741ff912b72326f68bd3b10f0269bfc5eeb30d1d13074d806f2f
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "arrItemId" INTEGER NOT NULL;

-- arr-schema-atom column:031d7065dd7f4ad6dce35dcb6309f5da7fb27f2d7585873b9b1d0c3279c96d4d
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "itemType" TEXT NOT NULL;

-- arr-schema-atom column:04d2fc4d450b2356afcb1ec57c78b5f6500d38613cd90e21229047844ae50a77
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "targetScope" TEXT NOT NULL;

-- arr-schema-atom column:deebed75cebb3ecdd67ef31dc2e915eaf3163fb0a44e09ccdba496ec35d8f63c
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "arrEpisodeId" INTEGER;

-- arr-schema-atom column:92631ed7b3cd0caa0e7ea6d0410371f02315dd019f6c31797f60ff9589c4c360
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:945baadb808c723a2dadd3587ef3f3d20fd9918d1fca41e1b2b970f6cdb499fc
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "ruleId" TEXT;

-- arr-schema-atom column:a78f1088c07c1128d4e0f4dc885c3f2eb91dc473b3523e393585864d0adb1cfa
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "ruleName" TEXT;

-- arr-schema-atom column:43537ff29ba74d73dfd34e7f9f1bd20d075e183a2d808efe4c5df44a347bca37
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "action" TEXT NOT NULL;

-- arr-schema-atom column:09c56bcf440d87ed836489cf583d3e62a2cef6c65e6f3e29d4d92c19fdbcf6b0
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "reason" TEXT NOT NULL;

-- arr-schema-atom column:87ec74ed87800d376c2b2a87c32d08506a90ab0c227c3283df9247f950637306
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "evidence" TEXT;

-- arr-schema-atom column:eaf0d772b7ad57c6121e81b51edd94302dca16e8e281ada25140689a41becd08
ALTER TABLE "library_cleanup_audit_events" ADD COLUMN "details" TEXT;

-- arr-schema-atom column:c03c2d94c476509af4cde3f1ad93b308bc79cd553e4e492eac7d9163c1990ff7
ALTER TABLE "library_cleanup_configs" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:01bfeb09af25f332d26d37930ae645b4c477ace09c04a9c3cfb6ec552bb59ef5
ALTER TABLE "library_cleanup_configs" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:7f9919662636d327307a04e377989bf7f18ea345327da083d691bb5e4b33d869
ALTER TABLE "library_cleanup_configs" ADD COLUMN "intervalHours" INTEGER NOT NULL DEFAULT 24;

-- arr-schema-atom column:3019b5a33f45842a72e0610a7c443754b701b167c237f6d0ecf2f1a85af789dd
ALTER TABLE "library_cleanup_configs" ADD COLUMN "lastRunAt" DATETIME;

-- arr-schema-atom column:c79def38e24a7129507ea80c8a8d26008fb01b3aae4cc0f62375944488a4b838
ALTER TABLE "library_cleanup_configs" ADD COLUMN "nextRunAt" DATETIME;

-- arr-schema-atom column:a44faacd903f47d0d205092c7c3de3c2cd3785f07253544fbad42b5ccfc986e0
ALTER TABLE "library_cleanup_configs" ADD COLUMN "dryRunMode" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:c65de14c73d13a2893b3b6367e52e72a313f83104a223f7888392f132fe971f2
ALTER TABLE "library_cleanup_configs" ADD COLUMN "maxRemovalsPerRun" INTEGER NOT NULL DEFAULT 50;

-- arr-schema-atom column:9f66c46929b97de748b99f826983b3a50867ea1f8ee5d906da5712b3972b1f86
ALTER TABLE "library_cleanup_configs" ADD COLUMN "requireApproval" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:aaa8d2b73ed136fde7adb822abc835fb7abb7fafdc025dab5882bc6e760aca55
ALTER TABLE "library_cleanup_configs" ADD COLUMN "runClaimToken" TEXT;

-- arr-schema-atom column:96eea1e887908188d556f8047bc39e37d0ba5bd8dac1b9d58708aae5054148ab
ALTER TABLE "library_cleanup_configs" ADD COLUMN "runClaimedAt" DATETIME;

-- arr-schema-atom column:b0592203c939fbd40fd100c26b336761ba914189cc4371fed1c9cbb90cbe35b9
ALTER TABLE "library_cleanup_configs" ADD COLUMN "respectQuiSeeding" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:30276e4cbb1089eda44810571e0a768a1763b6bc03cf6540c50c03d0a66f378f
ALTER TABLE "library_cleanup_configs" ADD COLUMN "rejectionMemoryDays" INTEGER DEFAULT 0;

-- arr-schema-atom column:64394bfb5ebf211e967aa3692a5b1f6a71773e15702c9a93c11d15f1994512a4
ALTER TABLE "library_cleanup_configs" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:ecdcb2d8bb31c60987aa918c94102dd503fae4db61e6e4444688f01f1171d065
ALTER TABLE "library_cleanup_logs" ADD COLUMN "configId" TEXT NOT NULL REFERENCES "library_cleanup_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:95b36764598699ca7d9e09623ea74411739015b3bf3eb287651c8179b8cef572
ALTER TABLE "library_cleanup_logs" ADD COLUMN "isDryRun" BOOLEAN NOT NULL;

-- arr-schema-atom column:9ea401898688cd5270fcafb2a000d746a6c415055cff827cdda3c9e375c9549b
ALTER TABLE "library_cleanup_logs" ADD COLUMN "status" TEXT NOT NULL;

-- arr-schema-atom column:56ae5e3da5fb6df7d00a75feb0502139880172e2f8da317b35680f086d5fddf4
ALTER TABLE "library_cleanup_logs" ADD COLUMN "itemsEvaluated" INTEGER NOT NULL;

-- arr-schema-atom column:83b8635b4fded55a89dcbc5b39e44fac67ddc40c008fad27bc3a59f7c1c41d6a
ALTER TABLE "library_cleanup_logs" ADD COLUMN "itemsFlagged" INTEGER NOT NULL;

-- arr-schema-atom column:6e3dd3b6d774917f1b10e601258a5aa8771b21e2570351bc3d3347552abf12e7
ALTER TABLE "library_cleanup_logs" ADD COLUMN "itemsRemoved" INTEGER NOT NULL;

-- arr-schema-atom column:f577bc4188bfe29242064cff8685512768dbd4a533f4cc2304bc733c9768e04a
ALTER TABLE "library_cleanup_logs" ADD COLUMN "itemsUnmonitored" INTEGER NOT NULL;

-- arr-schema-atom column:a05656ce35ff201ad1e52f41dc6c1c50bf043f0c06b69fc343aa8d519f425c44
ALTER TABLE "library_cleanup_logs" ADD COLUMN "itemsFilesDeleted" INTEGER NOT NULL;

-- arr-schema-atom column:ac124de5d3b9f711d14d48f228468680c4bdbe2ca76dc1ca868cc5de4efa9410
ALTER TABLE "library_cleanup_logs" ADD COLUMN "itemsSkipped" INTEGER NOT NULL;

-- arr-schema-atom column:43282262844803699e6088d40d804096fc454aeedd5ad20051370ddf3b539906
ALTER TABLE "library_cleanup_logs" ADD COLUMN "details" TEXT;

-- arr-schema-atom column:25e2e4b890c8bd3dd8e0d45c25a771c1e3d28226b67debcdf3f92d9bdbf51590
ALTER TABLE "library_cleanup_logs" ADD COLUMN "error" TEXT;

-- arr-schema-atom column:f7b51a4e220dfc0bb020cc7377fc21ebf48d51b964c309b6f2095425224915f1
ALTER TABLE "library_cleanup_logs" ADD COLUMN "prefetchHealth" TEXT;

-- arr-schema-atom column:75e93962e654e5e9e95a7fda79ff5e6fc34ce9fc1bd0025a534b69e4e00429da
ALTER TABLE "library_cleanup_logs" ADD COLUMN "warnings" TEXT;

-- arr-schema-atom column:8ac13451c77cb0d737f0f7749bf0a9e61477133f8afb6123a4537dc7e2b9f2ab
ALTER TABLE "library_cleanup_logs" ADD COLUMN "durationMs" INTEGER NOT NULL;

-- arr-schema-atom column:757bf5505c96e30bb5f78af531c0f2dabbd38e4a6e2ee8d7b26c6ee8fdfd9fdc
ALTER TABLE "library_cleanup_logs" ADD COLUMN "startedAt" DATETIME NOT NULL;

-- arr-schema-atom column:f836c935245db4125db2efa9fe69dd38fdb95dd0250d7356bc6c86f81254eafb
ALTER TABLE "library_cleanup_logs" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:990a9d275760dbe3ca4e3ff99bb32ac925acd44153aaf4b1b3e22dc7c9a0d35d
ALTER TABLE "library_cleanup_media_server_scan_leases" ADD COLUMN "userId" TEXT NOT NULL;

-- arr-schema-atom column:fab00a18196c6ac3d5a3f50e9d94ae38fe9c206cde290f8a316ecc10f5bbec03
ALTER TABLE "library_cleanup_media_server_scan_leases" ADD COLUMN "executionToken" TEXT NOT NULL;

-- arr-schema-atom column:0d84346d268b0ca0e619b55b6a7317399e377238cc16d1ad146c8ba08b169ecb
ALTER TABLE "library_cleanup_media_server_scan_leases" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:9874403ad25ac550d99a7686838f4883962035779967842fd823c986131a9973
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "approvalId" TEXT NOT NULL REFERENCES "library_cleanup_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:273c9aef8e7baf4f72c006b245891b5e00d186282d8099026009a77e2adf26fd
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "instanceId" TEXT NOT NULL;

-- arr-schema-atom column:ab7d82d6f5f57928f809623dde2233fa287746ce502415e9631fcfe7594354da
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "service" TEXT NOT NULL;

-- arr-schema-atom column:52a975280f2274ac2aef8736d435d9117e70f4a687e42e62c8c030d9ea10d606
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "serverIdentity" TEXT;

-- arr-schema-atom column:bf9026e7bd2108ee4c1879127663840b5c7b679ad21451d24f7ec891bf030b73
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:a6a80802e4f66b87794d7837fe74875980c33ca1cb6d93b47670d3438d1aa952
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "plannedSectionIds" TEXT;

-- arr-schema-atom column:12a087640c8c59b04884be358ce84adf8458df732ff2e8bd6669b2551cb4cd73
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "targetKey" TEXT NOT NULL;

-- arr-schema-atom column:24494ba712329341fe56e7d1d8c1e3f566e3f6df9ad6a7704cf6c167764dcbbe
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';

-- arr-schema-atom column:c6011fb72f532a845fd12e828a0e036eb41b5efde12d662e625883f599e20471
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "executionToken" TEXT;

-- arr-schema-atom column:9cadc9f6860b0fc78f3de0214008c7fc036295d1dc642de61f0b868b57feb75c
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:e48b6784ead6d67b89b851491fa2706c4169a503ddca58f8afff921c7cc0f5c6
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "completedSectionIds" TEXT NOT NULL DEFAULT '[]';

-- arr-schema-atom column:e64a06ab27012a00001d55f078c660fc9af14563a96d57956026286b20a99e96
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "lastError" TEXT;

-- arr-schema-atom column:eeaf826d84155a142f6077ba6aaa69d108be2fa1f7dcec1bd98d5db33ed6b9c2
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "nextAttemptAt" DATETIME;

-- arr-schema-atom column:aed5418455d208c1145bd17e3d490fe5e02c7aa1de3d0bde07b7b9c12ad3a643
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "requestStartedAt" DATETIME;

-- arr-schema-atom column:c48135c55ef21d9b34ade518f7408b1bca059cfada2ab27b80182c2c7568e7b3
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "triggeredAt" DATETIME;

-- arr-schema-atom column:7a3234b13f1a86eb0667f7187ae910cccc20d20151706463c35dd71077e88d80
ALTER TABLE "library_cleanup_media_server_scans" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:e36ef1fc824e3d5485bdb447c805edf458394427bc812c44f4bdefee074eaf75
ALTER TABLE "library_cleanup_rules" ADD COLUMN "configId" TEXT NOT NULL REFERENCES "library_cleanup_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:f2eb804be24cf7975fe5e71e6552c145ca41b3b0b4508a50142c34922e341da7
ALTER TABLE "library_cleanup_rules" ADD COLUMN "name" TEXT NOT NULL;

-- arr-schema-atom column:f5735de58daa3d68a91ae5bc97439ff450204835fab2957c3f3396d46826d6d1
ALTER TABLE "library_cleanup_rules" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:a289d6f660069782ed1b65776b21c45e1a445a2930a3cf7fa65857349d39b4b3
ALTER TABLE "library_cleanup_rules" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:7632fe839367662976c792e07fe34c06b85dd6c570b1128055d59cfb5d68164c
ALTER TABLE "library_cleanup_rules" ADD COLUMN "ruleType" TEXT NOT NULL;

-- arr-schema-atom column:8db8e1e98653b93cd4787676e239b66d3c81438246ed7cdecd693328e27d6a6e
ALTER TABLE "library_cleanup_rules" ADD COLUMN "parameters" TEXT NOT NULL;

-- arr-schema-atom column:e9b52549ef3dc017f23436f789ab34fc55c2795131e5348c0812c092b8b62ed3
ALTER TABLE "library_cleanup_rules" ADD COLUMN "serviceFilter" TEXT;

-- arr-schema-atom column:c9b149f8d4a1d50ff5954e976996767201d5a23b81fb18660be88e75adf012aa
ALTER TABLE "library_cleanup_rules" ADD COLUMN "instanceFilter" TEXT;

-- arr-schema-atom column:d4ded64ab5fbe81f08b257bed34f4455d04a192f61e36248533a7dc73cd041cb
ALTER TABLE "library_cleanup_rules" ADD COLUMN "excludeTags" TEXT;

-- arr-schema-atom column:0df1e6d9bfd6ec3af08e93def77599fc0c4153ff1d048e5332698bc78b9a3e14
ALTER TABLE "library_cleanup_rules" ADD COLUMN "excludeTitles" TEXT;

-- arr-schema-atom column:df927d9ddcd18b0b749c2d7c7f25684dd29bbcc28636053f58d10fdeaacfb990
ALTER TABLE "library_cleanup_rules" ADD COLUMN "plexLibraryFilter" TEXT;

-- arr-schema-atom column:f4c25239612a8338a91ed93c687bf514f95b5795f2dded466386cfb9188e7096
ALTER TABLE "library_cleanup_rules" ADD COLUMN "targetScope" TEXT NOT NULL DEFAULT 'series';

-- arr-schema-atom column:9aded2860f3e0231ea0748edb4e99c1a0c17ceb994934c8aa718a5eeea184238
ALTER TABLE "library_cleanup_rules" ADD COLUMN "action" TEXT NOT NULL DEFAULT 'delete';

-- arr-schema-atom column:932a9bffdeb0e102361ec3e099ac468ad920ed5a8bf06cbb719d72f752fc2684
ALTER TABLE "library_cleanup_rules" ADD COLUMN "scanMediaServerAfterDelete" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:78fb4406c66533611b3c3426f294dc2b238cd6244ebfd1414cba356d6771eab7
ALTER TABLE "library_cleanup_rules" ADD COLUMN "operator" TEXT;

-- arr-schema-atom column:114f978886934ad3cc8d9d1581b80a9c129a8ffd3ea30518b61620b192ff29c8
ALTER TABLE "library_cleanup_rules" ADD COLUMN "conditions" TEXT;

-- arr-schema-atom column:6a05371c22546637d944f21cdedd6afb52b6623749fba2935b36c95b4007a873
ALTER TABLE "library_cleanup_rules" ADD COLUMN "retentionMode" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:1657f005a4282941f117583c44702167ee8db608bd316165e890aac6acb14e9c
ALTER TABLE "library_cleanup_rules" ADD COLUMN "useGlobalRejectionMemory" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:e27891d971ac85e3009880dfdf4212e23b0eb8a8d8d41ad472ca4446568d598c
ALTER TABLE "library_cleanup_rules" ADD COLUMN "rejectionMemoryDays" INTEGER DEFAULT 0;

-- arr-schema-atom column:face11df8083045e95b4e3a69fad930c7246572f45a3eb2d51b9fccf9a39365e
ALTER TABLE "library_cleanup_rules" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:b5a494d20dce4073cc0132e6b4a06e1ada9d61fdfabe675c21fe4b9473aef77e
ALTER TABLE "library_sync_status" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:cf74a5e83e8e4e9b592ba0fcbc74c068672011693e42aeb0a944393869a7b85e
ALTER TABLE "library_sync_status" ADD COLUMN "lastFullSync" DATETIME;

-- arr-schema-atom column:d5df11af4f24b70041385b5fca3e673a5c05f755d7e8bdde540dc9b65b132cc7
ALTER TABLE "library_sync_status" ADD COLUMN "lastIncrementalSync" DATETIME;

-- arr-schema-atom column:79d7b3c2989f212e5aea8a2f2b35ff517ee1cda71a5c100e0e101794272bf624
ALTER TABLE "library_sync_status" ADD COLUMN "syncInProgress" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:4dd54ee0c1732fe9f94ae4899ab90b094948e208a22b0b2971ed677af762fbad
ALTER TABLE "library_sync_status" ADD COLUMN "lastSyncDurationMs" INTEGER;

-- arr-schema-atom column:ccf0e5e786f339644eb4db9c7e94ebfed6249363c9789bf1ff15132ae09299a8
ALTER TABLE "library_sync_status" ADD COLUMN "lastError" TEXT;

-- arr-schema-atom column:57a042dc926c65b131678f2be1d1e1f3fe8912e71bd5b413374518f1592acb03
ALTER TABLE "library_sync_status" ADD COLUMN "itemCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:c3426225222116cfa1b25b2ef94cbe12df7b71f145dcb6397ab36dfdbe2b9467
ALTER TABLE "library_sync_status" ADD COLUMN "pollingEnabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:f99925215dc09a4255a1c707da594d17665b2df585386f675439e00879e5e71b
ALTER TABLE "library_sync_status" ADD COLUMN "pollingIntervalMins" INTEGER NOT NULL DEFAULT 15;

-- arr-schema-atom column:c7afb225feb14325e8f523ab62702301c86389dcdb53a28eef2a359bf9b1709a
ALTER TABLE "library_sync_status" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:9c2809a551db2ea65f4459b513495c2694112a80274a16709ff0e68d92f90f3c
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:e64ff49c769473aa70587f01dd3ad764c7da3d8347ac5bdf18d2c5ce2a9f9468
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "provider" TEXT NOT NULL;

-- arr-schema-atom column:f44dd60d2ae1b7ff2726f1692d45c1962e36d54794957c8702534ae956cac295
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "listKey" TEXT NOT NULL;

-- arr-schema-atom column:0652b3501dadc8f6b7914f077ab745096034a43b97e6987b740525bb77105d1e
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "generationId" TEXT;

-- arr-schema-atom column:16584895551fecf303fc8550664589c1821e4cd832f186d210b110aad38de363
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "lastRefreshedAt" DATETIME;

-- arr-schema-atom column:6715af954ee2cd6a1a348ae6511ab7f9908b70edb47ff8b9b8216866d6973025
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "lastResult" TEXT;

-- arr-schema-atom column:b2f7b34c02146bccda22d19dca79532aafee77e1b206059d6d3ede5c69d617e5
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "lastErrorMessage" TEXT;

-- arr-schema-atom column:37647fa0b24205b9f8802d45d0ff2572d4ef6bbfd759f14f41f456eef44d73d0
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "itemCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:257d297fdc145694d33346e39b4e74763da34bb62d96f0816efe78868284d0d5
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "lastAttemptAt" DATETIME;

-- arr-schema-atom column:f54ddfdf42b2e5996090a0115ae1348581a3a91c61153ba7c7ff21a32b2d492d
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "lastAttemptResult" TEXT;

-- arr-schema-atom column:8dcb20b5e798d4e2ee4ce3f6c6748528552156d7558a9c5a9f6077aa57b28054
ALTER TABLE "list_cache_refresh_status" ADD COLUMN "lastAttemptErrorMessage" TEXT;

-- arr-schema-atom column:957d9bcc0578398010d87ae5a34d01e6a4d246d8156b448e909f9cf65f9df2c6
ALTER TABLE "naming_configs" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:7b8034f4f4e8b96ab4d993f19e6a4b8be1bd513be4bd71b0853f8d375d2978a9
ALTER TABLE "naming_configs" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:530a59079641ce7798b57e1c9d6191d6d62eea14b8c29a28518132ab07de7dcb
ALTER TABLE "naming_configs" ADD COLUMN "serviceType" TEXT NOT NULL;

-- arr-schema-atom column:8dacb5bbd0439b21aeacf6185b52beb310580e14b774ac53c98fed3609364a21
ALTER TABLE "naming_configs" ADD COLUMN "selectedPresets" TEXT NOT NULL;

-- arr-schema-atom column:12ecb07eb2b45a0fc5358c1c184703f1b7b16384926b2fc7ed26cf1a3c844989
ALTER TABLE "naming_configs" ADD COLUMN "syncStrategy" TEXT NOT NULL DEFAULT 'manual';

-- arr-schema-atom column:cafc43ddd7b0f71f439b097812e4372c45a0330e6c9776609a29d3e987d6e62f
ALTER TABLE "naming_configs" ADD COLUMN "lastDeployedAt" DATETIME;

-- arr-schema-atom column:5424a62dfecf65683e9db7d002217b2f6ff4f7ee1e9cddb46509c001bd0f39f7
ALTER TABLE "naming_configs" ADD COLUMN "lastDeployedHash" TEXT;

-- arr-schema-atom column:c5078aa0cd7600d305fb32c9b07730a9946e00ec73857d348185f955d334a3a7
ALTER TABLE "naming_configs" ADD COLUMN "lastDeployStatus" TEXT;

-- arr-schema-atom column:72656e5cf7a60a95ee7897c177104e5cfba57b83b6dcb46d8a809bf6c569a596
ALTER TABLE "naming_configs" ADD COLUMN "lastDeployError" TEXT;

-- arr-schema-atom column:65b91e88d48e2d7b70ef0c20aa78bc0c180f7173cd5fcd1a466b87a110fe12bc
ALTER TABLE "naming_configs" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:70271eed1dad7c57eac8b7ffaf23e3ae2fb2eebfcb5c9e79d73d62c70fc83019
ALTER TABLE "naming_deploy_history" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:e70f5c60bbcc16b09dea9e92d8e359b3abbfd08f8e7997d0ddd2650a6de00953
ALTER TABLE "naming_deploy_history" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:17a6e9f252d7302fee2d8f9fc1ef18a0fa941ac501056a8a9788face7ec21482
ALTER TABLE "naming_deploy_history" ADD COLUMN "status" TEXT NOT NULL;

-- arr-schema-atom column:1158e023cae9e53d2cb7ff16f49c0fb0b7ba2a8d4830a50e1fd27d152b55e1ef
ALTER TABLE "naming_deploy_history" ADD COLUMN "selectedPresets" TEXT NOT NULL;

-- arr-schema-atom column:eff44e302891edd005ad597f4d81f1d4cd1fc559d7b6c2f26b8eb0dd11358579
ALTER TABLE "naming_deploy_history" ADD COLUMN "resolvedPayload" TEXT NOT NULL;

-- arr-schema-atom column:528dc7eb96e8d8d95693acb474b418159c2a37b2418e5668259e4bfe8a832bc8
ALTER TABLE "naming_deploy_history" ADD COLUMN "deployedHash" TEXT;

-- arr-schema-atom column:9cdd969b23b5ab422bef9a86cd6dc7392db39b3dc79d694d275629f2336064a9
ALTER TABLE "naming_deploy_history" ADD COLUMN "previousConfig" TEXT;

-- arr-schema-atom column:83c66f58f4500b9c04cd15c7164a2355cec0abb8f502ae3c37f6fb513e483270
ALTER TABLE "naming_deploy_history" ADD COLUMN "changedFields" INTEGER NOT NULL;

-- arr-schema-atom column:2e29c7fe4beff1926643507c03d8331ab3ace1d8f05e34fa4b74bd5560c3f423
ALTER TABLE "naming_deploy_history" ADD COLUMN "totalFields" INTEGER NOT NULL;

-- arr-schema-atom column:b3682b2edd630ec35951a2bf66c753a71152e2bdef1633d8e8388f8592d0349e
ALTER TABLE "naming_deploy_history" ADD COLUMN "errorMessage" TEXT;

-- arr-schema-atom column:c3d07c13f08e175c42c102d6b196d4793068baf4e02c966318a0748169abe85e
ALTER TABLE "naming_deploy_history" ADD COLUMN "rolledBack" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:085f74171246797b1cb7bd1627c7cd2066b11514369686bf51196d1817c37cfa
ALTER TABLE "naming_deploy_history" ADD COLUMN "rolledBackAt" DATETIME;

-- arr-schema-atom column:3810da3a647482098cf92a11d5b347df4d783ccfe403f8324fdaa9febb07a069
ALTER TABLE "notification_aggregation_configs" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:a9ee3955cd1fb2583619edecf7565a7a80049a13c70ab657a1d710df7b9ce939
ALTER TABLE "notification_aggregation_configs" ADD COLUMN "eventType" TEXT NOT NULL;

-- arr-schema-atom column:e3be99815fecc2641415a1b328b8bf0e9af31037aac24c53cdd7108b39d765dd
ALTER TABLE "notification_aggregation_configs" ADD COLUMN "windowSeconds" INTEGER NOT NULL DEFAULT 300;

-- arr-schema-atom column:45ed409f77fa5789ec308808132c79c6867e6eccec006a1efd45f9439f431155
ALTER TABLE "notification_aggregation_configs" ADD COLUMN "maxBatchSize" INTEGER NOT NULL DEFAULT 10;

-- arr-schema-atom column:f7b8aad4c7145d58efdb734f230ef179a665269eab2fdc7987d2f55748c4f9dc
ALTER TABLE "notification_aggregation_configs" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:a7521084c14f080b1b56f33df18d94288f973718aca5581cb43d3f7854b76f88
ALTER TABLE "notification_channels" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:c76b413d2e39c5377719631115cfaafff59ec31f72845140f585dc93bc1d7167
ALTER TABLE "notification_channels" ADD COLUMN "name" TEXT NOT NULL;

-- arr-schema-atom column:9cb5ca621de0861552437c48ae781ea861f6ca595b4c3d4a1ec3c45e5d0b64f8
ALTER TABLE "notification_channels" ADD COLUMN "type" TEXT NOT NULL;

-- arr-schema-atom column:72dffcf7220c6226276f9f297861b740b5e7e31837dadfb881da1e4a2c0c8cfe
ALTER TABLE "notification_channels" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:6e4aa82adc0407a5864f734a79dc0ed801b96b632fb58518e8e9d536289dbbc4
ALTER TABLE "notification_channels" ADD COLUMN "encryptedConfig" TEXT NOT NULL;

-- arr-schema-atom column:34c8553c956116996f01a9d7ba52e2fbd3e111f575180db9af5ccc6bdb5ce71d
ALTER TABLE "notification_channels" ADD COLUMN "configIv" TEXT NOT NULL;

-- arr-schema-atom column:359fd12a4890d946d296f5f65f53e98287781ca08d41cee5a89d12fe8e0ecf68
ALTER TABLE "notification_channels" ADD COLUMN "lastTestedAt" DATETIME;

-- arr-schema-atom column:601e4055c23eb578b2b738bea04c7c10358dd630890d20fe97f3f90caf1729eb
ALTER TABLE "notification_channels" ADD COLUMN "lastTestResult" TEXT;

-- arr-schema-atom column:d9af96691ab141625488f052188b8e932c588745ace99bea7fc429db8f170bef
ALTER TABLE "notification_channels" ADD COLUMN "lastSentAt" DATETIME;

-- arr-schema-atom column:34862908973c5110cb9b9909c83a3503a394923ce1988ef897661f85672ca487
ALTER TABLE "notification_channels" ADD COLUMN "lastSendResult" TEXT;

-- arr-schema-atom column:aa58a73ca0c6bcb73eb53d0d96d0ee4aef8df6e581ade6d5bbce1dac54f47076
ALTER TABLE "notification_channels" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:9687ca980c3a2e6eea5457aeffe0136dd5aac0786912548be5193c41ac1d71d6
ALTER TABLE "notification_logs" ADD COLUMN "channelId" TEXT NOT NULL;

-- arr-schema-atom column:8582aae4cc78c866d88f82851fabb49cca1859371f05bc1c9df4665e22584abd
ALTER TABLE "notification_logs" ADD COLUMN "channelType" TEXT NOT NULL;

-- arr-schema-atom column:6bc40b198834ea161bcb5e13ee745b8fdb61d581f78ca0460f96b9995d824eed
ALTER TABLE "notification_logs" ADD COLUMN "eventType" TEXT NOT NULL;

-- arr-schema-atom column:ef28f597e769c9355840e4b633123f56b49d22b7616b83ddb86158dd75626d5b
ALTER TABLE "notification_logs" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:215d83306bd8437c2a5511cc048e4f16ed9facf7879e5ce55f96872052751f50
ALTER TABLE "notification_logs" ADD COLUMN "body" TEXT NOT NULL;

-- arr-schema-atom column:028ff58c7cf8feffabae80e84db07f00d2fc98cfc59ac43464d8d05cf40e4f06
ALTER TABLE "notification_logs" ADD COLUMN "status" TEXT NOT NULL;

-- arr-schema-atom column:90e60f44e6ef818b8c157de7a5a752b67737aff4eaa4f4cacd822bb8cacdf284
ALTER TABLE "notification_logs" ADD COLUMN "error" TEXT;

-- arr-schema-atom column:c65fd9f3fb01c6a2a93068dabf0210d83b1b2855fee88d683c20140f8c0d5dee
ALTER TABLE "notification_logs" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:333f50daa81645c48fe0d49f0c33b2255742ea89100724094e7e34d9659014a0
ALTER TABLE "notification_rules" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:bc7f16f673d3dc189d07cf7c556a222fdfe583b35037776b411c5e40abe6d14f
ALTER TABLE "notification_rules" ADD COLUMN "name" TEXT NOT NULL;

-- arr-schema-atom column:33078efcb3b24818bb027d0d1433c9bc46eef36f4847b98a230f577abc7fa132
ALTER TABLE "notification_rules" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:25e964ed3dfa13e3a92b5edcf78155f648ede267bce4850e6afa86dd084407ef
ALTER TABLE "notification_rules" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:48835d32eb53945d118a4d500de626c8df9c0b2b823619e0801e550dd14ebbdb
ALTER TABLE "notification_rules" ADD COLUMN "action" TEXT NOT NULL;

-- arr-schema-atom column:cd69bec69c3f86bdad28b1de24cf42cc9e6187eccd648f112a2723d8572d2c34
ALTER TABLE "notification_rules" ADD COLUMN "conditions" TEXT NOT NULL;

-- arr-schema-atom column:c6f3a420cb80e7892ff87447fa1eda37b0d619652d005997efe74012a3dda45a
ALTER TABLE "notification_rules" ADD COLUMN "targetChannelIds" TEXT;

-- arr-schema-atom column:8489196c3e0be6f7a9bd5d533f01eca0ca8c84dd61f23ea051dbad4c9fa16db5
ALTER TABLE "notification_rules" ADD COLUMN "throttleMinutes" INTEGER;

-- arr-schema-atom column:3534f511921179b49e1730c64062df178dac886a9bda54e58e5ce4a9bde70cd4
ALTER TABLE "notification_rules" ADD COLUMN "quietHoursStart" TEXT;

-- arr-schema-atom column:3ed8f7bc7ea14bf50b0d001b0064e4ad28cde7e1acdbebd7430c389be54ca183
ALTER TABLE "notification_rules" ADD COLUMN "quietHoursEnd" TEXT;

-- arr-schema-atom column:d0c9b1aeda87ca7ea587cbd077a55e076ef1e626490b0653bf8750264406e7a0
ALTER TABLE "notification_rules" ADD COLUMN "quietHoursTimezone" TEXT;

-- arr-schema-atom column:991cdcd735ae640ecda6d0f35fe3fce8ab84abfee08ecb0cded93520d9b40e09
ALTER TABLE "notification_rules" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:0eca7787d98ea49ff677f80615b80c76393b7906366dd447a819dd1b846f700f
ALTER TABLE "notification_subscriptions" ADD COLUMN "channelId" TEXT NOT NULL REFERENCES "notification_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:79d1c452e2b6f69e32c9cb73b792b224f58cbcb12f93c0d3886340ff1d403802
ALTER TABLE "notification_subscriptions" ADD COLUMN "eventType" TEXT NOT NULL;

-- arr-schema-atom column:de945fc5461b1ef96858d30d048c9c96ba52c8585f6c9ee614c4d5d692e49ff9
ALTER TABLE "oidc_accounts" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:3aac47f4c4cd53f5c2915e01d5a368ae32a9b6ce8fe79fc6c020807ce303fd14
ALTER TABLE "oidc_accounts" ADD COLUMN "providerUserId" TEXT NOT NULL;

-- arr-schema-atom column:ce990a1963f91530d655e5a2d3bdd3472a44ab1115f86951dcadb35af8c1080e
ALTER TABLE "oidc_accounts" ADD COLUMN "providerEmail" TEXT;

-- arr-schema-atom column:42f47244e4c1f3d3c6afb0e49389c61e5d69197d5529c53a9d758463c11feb62
ALTER TABLE "oidc_accounts" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:6bcb37717c9e7183fcaec0eefde9e4583c85f34097843ee1e3d0e79afee54e16
ALTER TABLE "oidc_providers" ADD COLUMN "displayName" TEXT NOT NULL;

-- arr-schema-atom column:9003bdb17cbca94d29b77346bd9bfa11d74106409739a7930ad5fe567bf9131a
ALTER TABLE "oidc_providers" ADD COLUMN "clientId" TEXT NOT NULL;

-- arr-schema-atom column:47180bdbf583e9546df02f80c1591213ad6bb32ec37c055aa2502fd9b063e33c
ALTER TABLE "oidc_providers" ADD COLUMN "encryptedClientSecret" TEXT NOT NULL;

-- arr-schema-atom column:1eb2b946523e4948f67bf8dda3737772c54981566b3e08a50c4e025682efe518
ALTER TABLE "oidc_providers" ADD COLUMN "clientSecretIv" TEXT NOT NULL;

-- arr-schema-atom column:4af7e16939139173a3a1b259797a90bf4afd04d42be54835999e2b0ad908aadc
ALTER TABLE "oidc_providers" ADD COLUMN "issuer" TEXT NOT NULL;

-- arr-schema-atom column:4ad6e3d3ad13593fa9f90a1db531faa834307dc7d4619fc404b75e7f87cca9b1
ALTER TABLE "oidc_providers" ADD COLUMN "redirectUri" TEXT NOT NULL;

-- arr-schema-atom column:52890a29427d7a52b2f485ab8068cd95a8b27cb1aa0b6ed2e72bb1d5f1243b5a
ALTER TABLE "oidc_providers" ADD COLUMN "scopes" TEXT NOT NULL DEFAULT 'openid,email,profile';

-- arr-schema-atom column:5262e5141753d33c40ab20792b831b3145cf3415a6fdf177f087383ba815a170
ALTER TABLE "oidc_providers" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:e51fb6bbc9590fca7e8c4479641e29698248706a10beea9144dc893150d5dd7a
ALTER TABLE "oidc_providers" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:175bbb4882e171c6288354ee8be202b1c6825583dbfdfe1482daf89564ff6c2c
ALTER TABLE "plex_cache" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:eab1008e0399e5f7a090918f82680fc7bb102ebebefc4b20e2e872bdccef15f5
ALTER TABLE "plex_cache" ADD COLUMN "tmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:2b8dd4180e85be06d8c69d43be578e7ee8636dc397e55ccafa496f82b6ee294f
ALTER TABLE "plex_cache" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:f7018c4d6e1fb9897d75181d3f5f9f73ec0cd038b0f8e8de72854583d08e21c0
ALTER TABLE "plex_cache" ADD COLUMN "sectionId" TEXT NOT NULL;

-- arr-schema-atom column:011ff45fce8dfaf1d3227842466e1b5f03fc5b46e1d173cc0a07289c059a69c7
ALTER TABLE "plex_cache" ADD COLUMN "sectionTitle" TEXT NOT NULL;

-- arr-schema-atom column:a764eca09cffaf768af16c4ca93e8f9b29b8af7e4cc95f656529fb0d448849bc
ALTER TABLE "plex_cache" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';

-- arr-schema-atom column:cfc7c5e3a53445140169d0fe11b4621715823192b9810aadad8da7f09eb73d3c
ALTER TABLE "plex_cache" ADD COLUMN "ratingKey" TEXT;

-- arr-schema-atom column:c2c707f75290777d23e07006654abb8beb32c2665862faf177dcb3073010b4ab
ALTER TABLE "plex_cache" ADD COLUMN "lastWatchedAt" DATETIME;

-- arr-schema-atom column:98ba3cc7a89f1861d4769df294e3b4be622bf1440dff7d0863812a8714db9e4c
ALTER TABLE "plex_cache" ADD COLUMN "watchCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:dae916cc95b2c3f487e53ff9ab16e7ddf7b02156815e62bd9f300c758f93f21b
ALTER TABLE "plex_cache" ADD COLUMN "watchedByUsers" TEXT NOT NULL;

-- arr-schema-atom column:bc3e83426ab72f200faac10975bfa0c6681c2922f654e7714600a2812420a474
ALTER TABLE "plex_cache" ADD COLUMN "onDeck" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:f5e7ef02acae8a070f695dc02bff290d5f18ca6c3cd631b7f666e8e2215d68ce
ALTER TABLE "plex_cache" ADD COLUMN "userRating" REAL;

-- arr-schema-atom column:f0fde48a5f9239ab6c1f7299f897672d22ee43f39ff87c1170e9fa4cf30a4ec7
ALTER TABLE "plex_cache" ADD COLUMN "collections" TEXT NOT NULL;

-- arr-schema-atom column:353e01df3da5407bb0d4105686eae6d1471ed01401f0a6d01b024ded8e86762f
ALTER TABLE "plex_cache" ADD COLUMN "labels" TEXT NOT NULL;

-- arr-schema-atom column:3b7e2593067d0fb0c3e36c06e8c503806fb7fc8a8321c3d720d50d5c6293a65c
ALTER TABLE "plex_cache" ADD COLUMN "addedAt" DATETIME;

-- arr-schema-atom column:f9996f9cb8c8086e16a689bf5ee8ac85745e599b24ad7a97a6d048a4d6dc7884
ALTER TABLE "plex_cache" ADD COLUMN "thumb" TEXT;

-- arr-schema-atom column:34e4f2b3f243fbb2567e7c08f52e7d2c8ae436ccca6d671a5643f649a5abb0e4
ALTER TABLE "plex_cache" ADD COLUMN "connectionGeneration" INTEGER;

-- arr-schema-atom column:f8e16066d36d40ee0a8a35a13f44d8253d9c8fcdb3f804bbdb29e31f3e88499f
ALTER TABLE "plex_cache" ADD COLUMN "identityGeneration" INTEGER;

-- arr-schema-atom column:04cfa79aad4b16123e7319fd9fbe4b4a2e5e1a660097b7912afc0deb1d2db8e1
ALTER TABLE "plex_episode_cache" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:e0d9cea3f087a976b9da76fdbe71b2ecac194bd6612ea5c17537f86301f29b24
ALTER TABLE "plex_episode_cache" ADD COLUMN "showTmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:45186ebdc395f5771a68bd1b5f0f66c25912ccf9e4a48c8430c68b73a7567cac
ALTER TABLE "plex_episode_cache" ADD COLUMN "seasonNumber" INTEGER NOT NULL;

-- arr-schema-atom column:69e83ca7190be966da74bcad086383aff6ca772bb55a9908c1c32229fabe2c7d
ALTER TABLE "plex_episode_cache" ADD COLUMN "episodeNumber" INTEGER NOT NULL;

-- arr-schema-atom column:c7f704ccba4b25f4696c96d8a8cb8273fb7a3a8ba1f4dbeeb9a549eebfb17655
ALTER TABLE "plex_episode_cache" ADD COLUMN "ratingKey" TEXT NOT NULL;

-- arr-schema-atom column:c2565cf7f7fbed99a9932b720952a2901fe0289cc8f2ac2f86067e4662dcec60
ALTER TABLE "plex_episode_cache" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:5c253cb00e674f13a43adb03c9ec41eae6f1e6a19e5a1f53ea34817050fa2ffd
ALTER TABLE "plex_episode_cache" ADD COLUMN "watched" BOOLEAN NOT NULL;

-- arr-schema-atom column:2e3dc30067149d86a285150ac9aab780b690c08dde7238a7b534233d117d0a61
ALTER TABLE "plex_episode_cache" ADD COLUMN "watchedByUsers" TEXT NOT NULL;

-- arr-schema-atom column:580093ab64bc3315e7b8e10cef4f88807131dc0e36597b6d0df064d93d4c0b10
ALTER TABLE "plex_episode_cache" ADD COLUMN "lastWatchedAt" DATETIME;

-- arr-schema-atom column:451464d230918bb15950ab95f1434b319b745b63ac9dd87a51e272e4a0b7f39a
ALTER TABLE "plex_episode_cache" ADD COLUMN "watchCount" INTEGER;

-- arr-schema-atom column:bf1fae02511afb12bb3aeb08e62e328c9766a6a9ddc833fef5f58c250a981b00
ALTER TABLE "plex_episode_cache" ADD COLUMN "refreshedAt" DATETIME;

-- arr-schema-atom column:ec231a820427a34cb9f4cef15d142316ae4e3746bd6b6cd2fe24d5b5a92079fe
ALTER TABLE "plex_episode_cache" ADD COLUMN "sourceFingerprint" TEXT;

-- arr-schema-atom column:73ee569d53ac26029126de94464cd5b75c41722debb42c568b5ae2e9dfb49885
ALTER TABLE "plex_episode_cache" ADD COLUMN "connectionGeneration" INTEGER;

-- arr-schema-atom column:1812e1630442b00200efa18c73a600c39991d3f99b47d9cc7058ed4684277956
ALTER TABLE "plex_episode_cache" ADD COLUMN "identityGeneration" INTEGER;

-- arr-schema-atom column:7779d761de42cfaf2c8a0a434635c27bf3a813222a1010f7f7027769af88ac25
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "showTmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:841e3e53235a62b72987d86a0910842d8907c0254341aba1b58984e9b4423f48
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "parentRatingKey" TEXT NOT NULL;

-- arr-schema-atom column:741a44cc12975a9fc3826c6d6cf6718d0a91e3ad6bcd11e71d8fadec21233d35
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "seasonNumber" INTEGER NOT NULL;

-- arr-schema-atom column:d08c613a28f5ac87d4f145afbe374b3c29591348050550fd88a120362f5e78bf
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "episodeNumber" INTEGER NOT NULL;

-- arr-schema-atom column:de9e9d6f722623539f98c9729b3b424d06eb5f88f77bf75c00849a692bdc2e83
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "ratingKey" TEXT NOT NULL;

-- arr-schema-atom column:1ec1ce2c9907fd31f7964c69b6953a73e8ce995350d455943bd68680fd478d06
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:814262c60d22cb86f696a2974963b91a54b05cac01a3b8acce786c5d11a02d0f
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "watched" BOOLEAN NOT NULL;

-- arr-schema-atom column:7943548dbee5d9bc51238021a6c71403a906536440efb6e3d9a10a6e850f5266
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "watchedByUsers" TEXT NOT NULL;

-- arr-schema-atom column:8ce0883bb8a554bf1c38b4e88617c6c931b93dac785661acd0e852c0bf4e3568
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "lastWatchedAt" DATETIME;

-- arr-schema-atom column:51cd98ade2fef621792f50ae69864363672443f7e2a4b3a044b1d47c9de1e818
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "watchCount" INTEGER NOT NULL;

-- arr-schema-atom column:0f10ccef8d6007927b4fbf22e27e27f7dbce55372c44d53e28882054c822767d
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "refreshedAt" DATETIME NOT NULL;

-- arr-schema-atom column:5282db42bacf9e935fdded02deaed6ba63ddf88b00913ea76167428943bc02ad
ALTER TABLE "plex_episode_observation_stage" ADD COLUMN "sourceFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:57b75d195fe2ecf178999892dc3fbe959fbd4cf12fa8dce509d10586b4eef09a
ALTER TABLE "plex_generation_targets" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:18cb20e44bdaf4908be35e1b884f1e329365c23fcbf9266a26373465fdb195e3
ALTER TABLE "plex_generation_targets" ADD COLUMN "generationId" TEXT NOT NULL;

-- arr-schema-atom column:1c2d298f1b1cb62d79150de861b4994dfb7d4ac9decfff984d847ff5302e6845
ALTER TABLE "plex_generation_targets" ADD COLUMN "sectionId" TEXT NOT NULL;

-- arr-schema-atom column:36b5465f710dbf8be5933b2434504f44af1badf21caf4ad47f44772f86103663
ALTER TABLE "plex_generation_targets" ADD COLUMN "sectionUuid" TEXT NOT NULL;

-- arr-schema-atom column:5594cfa515afd533d0abd08b365f22d999c8e3c1040a4967397b215f6a4a6f62
ALTER TABLE "plex_generation_targets" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:97fabd492cb6faa6d49fd60c0f1f651c41ea03b04a92463c3d83addd62b4c284
ALTER TABLE "plex_generation_targets" ADD COLUMN "tmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:5a5fc5135ecd702b204751e972739cd4edea51db092d2d2f9cf0c89878ef11cd
ALTER TABLE "plex_generation_targets" ADD COLUMN "tvdbId" INTEGER;

-- arr-schema-atom column:2ba86e8299209b8cb5ad019c6b39690ebd7c12915bad825d0ec3e2f30ffbb811
ALTER TABLE "plex_generation_targets" ADD COLUMN "ratingKey" TEXT NOT NULL;

-- arr-schema-atom column:2ee5fb0dbff2c3665da1468a72641130d8434d52c488180600da651b4db4d3b8
ALTER TABLE "provider_native_inventory_items" ADD COLUMN "snapshotId" TEXT NOT NULL REFERENCES "provider_native_inventory_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:2c55fb11cbd432864a027bf27ccb3854304526b3f7292fcd36b9a724539ce950
ALTER TABLE "provider_native_inventory_items" ADD COLUMN "nativeId" TEXT NOT NULL;

-- arr-schema-atom column:fa546a9cbe7f9dd4b458e47f1889361b42aa4f56233ae453c54a5b68b24d661e
ALTER TABLE "provider_native_inventory_items" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:8b105b8ddbf7b0034582b5fadde044526eadd9277d579e6e2121e8bdb98e9d15
ALTER TABLE "provider_native_inventory_items" ADD COLUMN "libraryIds" TEXT NOT NULL;

-- arr-schema-atom column:451e71c59029f16feaa9752c4d870f1e997f39e3a96f6d6d43a0f1505e90495d
ALTER TABLE "provider_native_inventory_items" ADD COLUMN "parentNativeId" TEXT;

-- arr-schema-atom column:4663e3c7cf6f71abdfa4a9c62b8672692f93e52a535cadb0e4326f65585210b5
ALTER TABLE "provider_native_inventory_items" ADD COLUMN "seasonNumber" INTEGER;

-- arr-schema-atom column:9cb1ab9647b4efe8f21f494a16db7024730df90094278f66cce82f482a5dbd1c
ALTER TABLE "provider_native_inventory_items" ADD COLUMN "episodeNumber" INTEGER;

-- arr-schema-atom column:46ed088ccabd5556e6374c27578e6e1adda1077bd3b9e8a2f4c34941b49d8c70
ALTER TABLE "provider_native_inventory_items" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';

-- arr-schema-atom column:2a1797526ce278968d822b919d9191b1d6590bac23e366bd6c90a679046f03ef
ALTER TABLE "provider_native_inventory_items" ADD COLUMN "externalIds" TEXT;

-- arr-schema-atom column:67c6c2e897d0b7282bd9789988c7631172557ea67829904f5f343d01c591a57d
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "passId" TEXT NOT NULL REFERENCES "provider_native_inventory_passes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:61659597f695a72796f28d2339c34f0e26580c78411438a830ec1820a48c518f
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "domain" TEXT NOT NULL;

-- arr-schema-atom column:6f5e2155516ad4b68cb169f42814ef73ea2feb90032c3d054b5d55b7dda757d9
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "scopeKey" TEXT NOT NULL;

-- arr-schema-atom column:97276760898249cd99d0a9205674dadcab30aadda90332c87790f9b11d2bf737
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "pageKey" TEXT NOT NULL;

-- arr-schema-atom column:46ec23cfd3bdb2ff624e62f23cec3ff6db4015477279786f3dec47ec4253c670
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "startIndex" INTEGER NOT NULL;

-- arr-schema-atom column:7806920d4486de9da22b47ed274c48f1158c46beb9a4c4c1c4d373651a88808d
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "nextCursor" TEXT;

-- arr-schema-atom column:4d63cdcef6a6ef584522775512eb4264c17fdd90b702616d97b46271383d6ce2
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "isLast" BOOLEAN NOT NULL;

-- arr-schema-atom column:c4859aa53651c67a8df2b0feac3cb7fcfb1d49be863ead6140d9a014af893668
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "expectedRawCount" INTEGER NOT NULL;

-- arr-schema-atom column:fbe4af01211e57f1da0908fa7633d623ffb1c69a9659269a73981081f1c904ec
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "rawCount" INTEGER NOT NULL;

-- arr-schema-atom column:b1b494c21646d9c92f905b0dea77e6d159b00c4749893119a464a4a56a697307
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "rowCount" INTEGER NOT NULL;

-- arr-schema-atom column:d264471c5b0420c8d7693f868c6251ee379bf2db1d27f4cf4d3c40bf7e9ca14e
ALTER TABLE "provider_native_inventory_page_receipts" ADD COLUMN "contentHash" TEXT NOT NULL;

-- arr-schema-atom column:7a33fad632b5040e878f60bb9e7da0c7f5d3cbfd0a456dbdb6e4c496a8a129ff
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "runId" TEXT NOT NULL REFERENCES "provider_native_inventory_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:c2e071ff9d33020520f1bb55736f4069c44506682bb0084f3a3cdfc31f066e7b
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "ordinal" INTEGER NOT NULL;

-- arr-schema-atom column:6351e43731c89cfa32871163f9b49ff1b862e30b30605f1b1e6cc3107e58f275
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'collecting';

-- arr-schema-atom column:672def4264e30c0f8d781605d4d535d675737fb0dfa38581e9c1f3beb18a5e24
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "scopeManifest" TEXT;

-- arr-schema-atom column:9940266e5b4402ffeb35b9f69afd63b7e4e60a66064d98c7d3aa121d50805892
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "scopeDigest" TEXT;

-- arr-schema-atom column:396084fde04747a5b5bb4014372614525b2cd2e7d340107dfab28696ede417b7
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "comparisonDigest" TEXT;

-- arr-schema-atom column:8b4c8416548e716562377285536ce5384f104c8db87dee31a66a163687c85c10
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "libraryItemCount" INTEGER;

-- arr-schema-atom column:e586b5b55af04edca9c38d8298a0cb548ff49f1129c4a8b95e6b147b5a95fcc6
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "episodeItemCount" INTEGER;

-- arr-schema-atom column:0499e75c97eb39e0df1c42c1f5298f580e7d8a9e7a94becca714e2010f6cd0f5
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "pageRevision" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:6893532c02f720d139ddd143da2c11a0fb812a74eb147b83c4638c123cae22c5
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:46a720566bb13e3eb8051407fe45f950e34d51bc25b82c9b4c68bc9f3f597433
ALTER TABLE "provider_native_inventory_passes" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:10ec86ebb0f5e74c5c531b73d88fff8a6ecafe93d542fd3c61cfaa0c562fcb4b
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:5658cc99464c730214289c0915f5b4c4a1167d494c396590333c3f7ca905f609
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "workKey" TEXT NOT NULL;

-- arr-schema-atom column:25b2d942cad3129e0b3c3fa96a8d7b7c1b5e798165ced430d358fed7439e3af8
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:731c9956fcfb423da8815db84c72bac287527910f3b9261de876ac4f87c2eb13
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "identityGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:14efeab9bbd9fad7bb3d104cd30c13aa3af3f03dae71e1fce5ca38d45afa9575
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "state" TEXT NOT NULL;

-- arr-schema-atom column:dd415608903abc0fc74a59984ce548cd87b8ae7b2bb93b7feaf9f9d488488dfe
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "activeSlotKey" TEXT;

-- arr-schema-atom column:b0eeca319a00cc3323f73663a966e6d18f05969664a341a5bc36d684aacb42cb
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "passOrdinal" INTEGER NOT NULL DEFAULT 1;

-- arr-schema-atom column:7ebc655b77ee1a159220113bc0e68b43c9c25c0596eba1a49cd97e8677a7752c
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "claimToken" TEXT;

-- arr-schema-atom column:bf7238ff93fc381eaa89334830aa31ac02d1671e5ba34d29fb6a498716240c75
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "leaseUntil" DATETIME;

-- arr-schema-atom column:1cd749d9adf647646212fe54e39de1510fd56b6b17f4766f80e240d7523bc48d
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "nextAttemptAt" DATETIME;

-- arr-schema-atom column:4ff20dc3df5ddd75268c47f547e894122d9498016136729e2a63ede8c7049593
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "lastFailureCategory" TEXT;

-- arr-schema-atom column:f297fef6243583139d548c9985f66eca81d5f3b1a0de1ceeffe07bb8399ffef4
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:f37b5f6d33ea8169093b541e8287ad943f718ef6c6c9d983f71e9b1e5d4af2e7
ALTER TABLE "provider_native_inventory_runs" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:9b6101bd186a567f0fab9b2b4b8b1c6c7f94b1d2790efd66209a217d1635da89
ALTER TABLE "provider_native_inventory_seen_items" ADD COLUMN "passId" TEXT NOT NULL REFERENCES "provider_native_inventory_passes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:02d724abcc354a19abc6206739dcdb3665b56defba01143ca733e2b6ed3a2b3c
ALTER TABLE "provider_native_inventory_seen_items" ADD COLUMN "domain" TEXT NOT NULL;

-- arr-schema-atom column:740d8623c431fad898ad58e2a5953ec4c5eedfda86806be72402b2e5ffac80a3
ALTER TABLE "provider_native_inventory_seen_items" ADD COLUMN "scopeKey" TEXT NOT NULL;

-- arr-schema-atom column:64f93324d9daf721870c4ae963610f7423a28bb121bb1722fd9a444a509f7918
ALTER TABLE "provider_native_inventory_seen_items" ADD COLUMN "nativeId" TEXT NOT NULL;

-- arr-schema-atom column:86863423eddfe33021c887500a21fecf69e1864185ab616caa26d316bd53903e
ALTER TABLE "provider_native_inventory_seen_items" ADD COLUMN "comparisonKey" TEXT;

-- arr-schema-atom column:f3aa2abc01ae546be2625bb12c809d1a6da0e1785322e2ea40c4b17ef0710c0c
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:ba53faf37643e8d61556c0a4796a28280f632f85d995de020eff3e13307c0142
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "domain" TEXT NOT NULL;

-- arr-schema-atom column:405fbc66e8397196ff424dc474ca9177becc5ffa113ca40db53fe511d861d6d1
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "generationId" TEXT;

-- arr-schema-atom column:e52ea9bcf076ee760b3d4c4a6d235c21ca0f2be5d19431c681f49374a414613e
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "observedAt" DATETIME;

-- arr-schema-atom column:f24151a02c19dad42b9d9dc39197a9c8e2300c71cd91397784a98f0db9c3a484
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "connectionGeneration" INTEGER;

-- arr-schema-atom column:1afd1cac01c4d7c668ca71ce8f9d80e22b379ac0d52fea5bfd0ba015c0fbb759
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "identityGeneration" INTEGER;

-- arr-schema-atom column:dd18fcfc42acbf8ed637b0e256933ae61c857baae6eb6cbba1b4807a4e7cc83b
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "scopeDigest" TEXT;

-- arr-schema-atom column:d43d614e0a3b5b99e4770233dd271924520ab12c336ce2efea4143b7a42b9871
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "contentDigest" TEXT;

-- arr-schema-atom column:0824be63be711873ca335e4f2e2f5efef12fb099edf12ccb4a78b41d883b3119
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "itemCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:6c95e1c011f548dbcfb6ba271557bba5fad9d678bdbc4b281e124bb2ad0802e4
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "scopeCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:a7eedac29621023f198344a53bfbed1538cf614aac1837eef607779162a5bd09
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "lastAttemptAt" DATETIME;

-- arr-schema-atom column:c56552194d85e589256a8c12eb9614c5d39974bee59b499726824afabe5b8b00
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "lastAttemptToken" TEXT;

-- arr-schema-atom column:f0b7be43aa144e41cdc0e637e33cb76705063d34df1e65878b858dfd96d891b3
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "lastAttemptResult" TEXT NOT NULL DEFAULT 'unknown';

-- arr-schema-atom column:ffe6079fc698cc38d8bece4e88d28314bd281695f3f0945e0d60913760bf76a5
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "lastAttemptReason" TEXT;

-- arr-schema-atom column:947e8eab3f182da197baaf2826480682f5471dee225f0681d44b8176472b8c85
ALTER TABLE "provider_native_inventory_snapshots" ADD COLUMN "publishedPassId" TEXT REFERENCES "provider_native_inventory_passes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- arr-schema-atom column:2277d03180156d119823a397656694cecf42e9ea2854e3b85d8265092cba1f81
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "passId" TEXT NOT NULL REFERENCES "provider_native_inventory_passes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:0e25f6d1e11a342f3b8be8d4887a3514c6bf4baf392edd821725a9133926ab47
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "domain" TEXT NOT NULL;

-- arr-schema-atom column:66dad08f9f16a8bf5856540990dc2652bbb1003a1b3bb6afb452764fc3ff8f98
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "nativeId" TEXT NOT NULL;

-- arr-schema-atom column:65654613f460324dab6f79efb55c3d7b625772fca415bb7af23f51199c825b6a
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:4a16a110430fc190fda23b4ad56c7b5f3bf68a5a919572dd30f364f52f41e30b
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "libraryIds" TEXT NOT NULL;

-- arr-schema-atom column:ea945c31fc04f3be91207001e25fd22f4de4020c483dd83bf1f29687a29b7c68
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "parentNativeId" TEXT;

-- arr-schema-atom column:cbc21e7e6dfc4c740f4723e0e27b4478c0423ad05d7c74ced436654b9700da25
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "seasonNumber" INTEGER;

-- arr-schema-atom column:cb149e7b83aea6bfa230e9f68fc8960f59ee584e34d557ff3a0250a08d3198fb
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "episodeNumber" INTEGER;

-- arr-schema-atom column:62e1dafdfa105031737f4c62c0b3613365e57d3010b73c41eb9da7f516d8726b
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';

-- arr-schema-atom column:27b0e62792b028c7b391fd86eda65f90bcc3bf4a82df572ca974035f8aadac60
ALTER TABLE "provider_native_inventory_stage_items" ADD COLUMN "externalIds" TEXT;

-- arr-schema-atom column:afa96a00014255a18dcb42887d046dc6e3aabe30690393dbbccba8ee81b4cabe
ALTER TABLE "provider_observation_runs" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:70be225f3749023b68fcc79889deb9680785e095db4504308e7f0f2d076ace4c
ALTER TABLE "provider_observation_runs" ADD COLUMN "provider" TEXT NOT NULL;

-- arr-schema-atom column:08e99b3117ee068a398bfb28fffdb56757d3f3ff259c3a4edda5781bbdef65af
ALTER TABLE "provider_observation_runs" ADD COLUMN "cacheType" TEXT NOT NULL;

-- arr-schema-atom column:ed63d34a5052f47791b65364fdfd7b4ef2a3f97e1342da6e7263a9fdb9c099db
ALTER TABLE "provider_observation_runs" ADD COLUMN "authorityKey" TEXT NOT NULL;

-- arr-schema-atom column:1f20ca41652c2d90b137138920ded982472c7f447ae709edfe0dc0a1590a0d5b
ALTER TABLE "provider_observation_runs" ADD COLUMN "activeSlotKey" TEXT;

-- arr-schema-atom column:dac839e38b7c831604f5f40ada010e6dfc2df1f3e1ddaac9e4f8e9f95af70084
ALTER TABLE "provider_observation_runs" ADD COLUMN "parentGenerationId" TEXT;

-- arr-schema-atom column:fea7aa6d166bddae0afb0460c810701144b0edba9867b8e782ee59edc23b0234
ALTER TABLE "provider_observation_runs" ADD COLUMN "targetDigest" TEXT NOT NULL;

-- arr-schema-atom column:695452bbd0cd1a3b4b0ee4c8a05b4162caeb02fd947d4886d241d81883fc493d
ALTER TABLE "provider_observation_runs" ADD COLUMN "targetCount" INTEGER NOT NULL;

-- arr-schema-atom column:18df582cca1791783f9a8723cb5efe2c981ece59cc372253dee2384717ed4e1a
ALTER TABLE "provider_observation_runs" ADD COLUMN "connectionGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:b5f14fdb40d043f8ae410cfaeb4db7316054b32c1c391fd1fd12e30521a85587
ALTER TABLE "provider_observation_runs" ADD COLUMN "identityGeneration" INTEGER NOT NULL;

-- arr-schema-atom column:5bad8376b523f8363472bdea32e8ae36c248538a5b92a32ade61a8a3982d3fc4
ALTER TABLE "provider_observation_runs" ADD COLUMN "state" TEXT NOT NULL;

-- arr-schema-atom column:65f878e233431316bdcb5c25ac090a325b466cd751d34adaf658bf3e9d9ac703
ALTER TABLE "provider_observation_runs" ADD COLUMN "totalUnits" INTEGER NOT NULL;

-- arr-schema-atom column:1788ef4ee1e20c9bcac3f02b418fe9e2e8e44d66999b3b1186c99e9c5d5b3f26
ALTER TABLE "provider_observation_runs" ADD COLUMN "completedUnits" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:4e7c3a2110bd0eacf71ff70dca8700e1125c0737b315e20ae45f0467cb9787a5
ALTER TABLE "provider_observation_runs" ADD COLUMN "totalWork" INTEGER NOT NULL;

-- arr-schema-atom column:ae264af39f9dbfc1e5c88c96a2ae2daa9f6697911935fefacdc306166f040c32
ALTER TABLE "provider_observation_runs" ADD COLUMN "completedWork" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:86b3649cb83b1c95acc55850495588314788a7336b6f48922b32b075d89687f9
ALTER TABLE "provider_observation_runs" ADD COLUMN "nextAttemptAt" DATETIME;

-- arr-schema-atom column:f31c0ddd925f5332922d6f950fb16236a9aba8cfbdc494d926b15e00a703a1ee
ALTER TABLE "provider_observation_runs" ADD COLUMN "lastReasonCode" TEXT;

-- arr-schema-atom column:7dc066808c4e5357b12a3ee2af264584594fa1606fc99ee6fadbd4a01c503919
ALTER TABLE "provider_observation_runs" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:c5c32c96d8475ae1b5aaf5f7c38568a5c890d5eb96226bc8a7ecb6f807431646
ALTER TABLE "provider_observation_runs" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:817aba9d003494b871c6d58945fccd813bcd9c3bfc482d10abff2355d672003f
ALTER TABLE "provider_observation_units" ADD COLUMN "runId" TEXT NOT NULL REFERENCES "provider_observation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:12e330209778e79414a88d17dc7b965bbdb1adda017ec8a3a16484f10a8eb407
ALTER TABLE "provider_observation_units" ADD COLUMN "ordinal" INTEGER NOT NULL;

-- arr-schema-atom column:0dbd7addb0aece0d8c01aeca8deaf4ca878e7e4b48c300b5587a511731f684c2
ALTER TABLE "provider_observation_units" ADD COLUMN "scopeKey" TEXT NOT NULL;

-- arr-schema-atom column:c2926e40f4d72f05339b9e810ddba0ff8de27ab9337fd1f06962995bbaa746ea
ALTER TABLE "provider_observation_units" ADD COLUMN "scopeDigest" TEXT NOT NULL;

-- arr-schema-atom column:b4107914cbf1f7ef497a5015b7e9c1bbb52c8e5c234e1db3d9a230ca5aed77a9
ALTER TABLE "provider_observation_units" ADD COLUMN "scopePayload" TEXT;

-- arr-schema-atom column:fa8de0a62afed817dcc9fdc710646c5adbadbc01fdada04733571852f762e32e
ALTER TABLE "provider_observation_units" ADD COLUMN "phase" TEXT NOT NULL;

-- arr-schema-atom column:6f318c09db6c5b31affef250cb66eabbc1aacbd864076f615c78cace466279b5
ALTER TABLE "provider_observation_units" ADD COLUMN "expectedTargets" INTEGER NOT NULL;

-- arr-schema-atom column:d64a49c3cbadefb333263d854a91046d1bf85ac0fde07ece9cf5cda95b245728
ALTER TABLE "provider_observation_units" ADD COLUMN "cursor" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:4abf21db012fbedbac8f72a1edb0ad03f636986da2a3fdf3041d4c1c312a04a6
ALTER TABLE "provider_observation_units" ADD COLUMN "expectedRawCount" INTEGER;

-- arr-schema-atom column:60a3d9ca0a7766c2ffe608ffe5b665e311a8bc05e6a29baf863c6b0c1e1ae4c5
ALTER TABLE "provider_observation_units" ADD COLUMN "observedRawCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:b134de1e6e0f902069feb03ef99732de52889021388ceb18e29bdacbe072ccb5
ALTER TABLE "provider_observation_units" ADD COLUMN "completedPages" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:d1982c08b26144b09f6a197235af1c9208503ab62aca9cdfa98fb7f2383215b2
ALTER TABLE "provider_observation_units" ADD COLUMN "state" TEXT NOT NULL;

-- arr-schema-atom column:e28b285bf5d6cb08e3ce246470235260c6c4f37fa1923b7ea5121dc932cd72ba
ALTER TABLE "provider_observation_units" ADD COLUMN "claimToken" TEXT;

-- arr-schema-atom column:f68c9726d7cbc68e2382d5db1878ab9b15dc44e94ceae3723855abed86da4376
ALTER TABLE "provider_observation_units" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:63fc4d0f6a09ab5115d63fd00c9f9ad43c4c61981e0d9403638f601cb8e658ce
ALTER TABLE "provider_observation_units" ADD COLUMN "nextAttemptAt" DATETIME;

-- arr-schema-atom column:e25fc2730196ca4582aef910ef108b23e182a697a8020b1743ad57beae15ab55
ALTER TABLE "provider_observation_units" ADD COLUMN "lastReasonCode" TEXT;

-- arr-schema-atom column:e80c497996d72d085ab8df2570b1671ef10fda0637c51c68591cd87e6613c604
ALTER TABLE "provider_observation_units" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:b8393c9575792ab53057c2492cf7f1dcd0540b1c74ecd544e6dcb94edfd7bc03
ALTER TABLE "provider_observation_units" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:b1b5a43270a58da642a1efb65b53a3b02ac2a005aa6df33d473559567fe90acd
ALTER TABLE "quality_size_mappings" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:4f1b3fd0caa8d472a30027c1369419ce9ee1f12328c103473a1dbe7f53cd0ae9
ALTER TABLE "quality_size_mappings" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:4b18e7cba7a99ad53521516d1eb884eeacd113de4996b215ab7a9a64bcff6580
ALTER TABLE "quality_size_mappings" ADD COLUMN "presetTrashId" TEXT NOT NULL;

-- arr-schema-atom column:d0c3cf1396a6b1c0b60d9f46c2696d48a5bb18123385d47a8a6c8b7d7157b4ef
ALTER TABLE "quality_size_mappings" ADD COLUMN "presetType" TEXT NOT NULL;

-- arr-schema-atom column:ef9f7e6dd14a91f9b7a732c9530f7a56bfe511587e65c876e527b12048785588
ALTER TABLE "quality_size_mappings" ADD COLUMN "serviceType" TEXT NOT NULL;

-- arr-schema-atom column:98e01244529a57798add9328f6d25334c3d7b8c8e5934a7afee2c28eff146150
ALTER TABLE "quality_size_mappings" ADD COLUMN "syncStrategy" TEXT NOT NULL DEFAULT 'manual';

-- arr-schema-atom column:f6895a8d275534098d257c3ca2cb20358632194cbd1f3db7c2299e0b41090640
ALTER TABLE "quality_size_mappings" ADD COLUMN "appliedDataHash" TEXT;

-- arr-schema-atom column:e7350cbc93d7c10d08106489d0c2085165fd9c8e2a69d8f25783bfa339c7462c
ALTER TABLE "quality_size_mappings" ADD COLUMN "lastAppliedAt" DATETIME NOT NULL;

-- arr-schema-atom column:3e914cc9177671d4a516cc7f653ae56479e45777f4e6d1cf92025a5454cc6558
ALTER TABLE "quality_size_mappings" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:3eb483577ed25d02927072e7762bb22a0ddacde5e2003d0503910e70de9deefb
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:933d12d2cff8da0f2ce2d1075829bdcc01f68024336e0c322b0f0929a487c48f
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:35bff26aca93e54208c63eed896055ccbb75f71beed56ff879eb3654557033d2
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "intervalMins" INTEGER NOT NULL DEFAULT 30;

-- arr-schema-atom column:83df7fd68075e44a1081d86a2662e035b0f306fba170e32aa23724f28045fac2
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "stalledEnabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:6a22f5085e18b544959e0f4c0db16236b4ad91980eff6934ea97c19ce4a0e23e
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "stalledThresholdMins" INTEGER NOT NULL DEFAULT 60;

-- arr-schema-atom column:53116cb8ff800e5def5eb07d2a95c6534b61f45250d52a237a6bd0e3a53fe2ea
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "failedEnabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:ad5135afe847dad422ca1dd15362edcbbdc012533599551389962d873d3d219c
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "slowEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:3f601fcd61f9ae971b956f7e021ddf08655cfde9b8ede41930d7f78c593b534d
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "slowSpeedThreshold" INTEGER NOT NULL DEFAULT 100;

-- arr-schema-atom column:f347a2fe64a2023f9644fdd5ef08d131a7fc5cc3dd5f1710b21248b152439f2c
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "slowGracePeriodMins" INTEGER NOT NULL DEFAULT 30;

-- arr-schema-atom column:84fc1b515f69710d0e5d3cd46420577a9073e17c6085c79118db00131c2f5ebc
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "errorPatternsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:6ecff883c0609b2b6677a23473baf8aa5f3fc9eb49052687d9206d4051d9e7b1
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "errorPatterns" TEXT;

-- arr-schema-atom column:70e0e517e3373633f58a9446142aea0720343c09fe7307c1c54b49a91ce87dcc
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "fileExtensionAllowlistEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:085ce3959d37dfea4cc651f53344999444a4de246063b2e6197a1901719a5a14
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "allowedFileExtensions" TEXT;

-- arr-schema-atom column:c9247fa6760338d9e0aa317a6220c1bbf29a615718944906a2021f2997db96a7
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "removeFromClient" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:63a0ced604a30620ce72e95ca73499a475e6af37c901849fa85f7acd47704ebb
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "addToBlocklist" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:d5296d6a42ce117c68393f5dfac65b83a508def6e166fff25c21532824887e73
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "searchAfterRemoval" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:5631d302c01599379921ff486fd5f7d1b40b9e38155e2a3a6e482f38c6af28d6
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "quiAwareMode" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:82269fed6de3338d890958f52ab3ce0255787fdcb31fdca26bfb2918dd6fe906
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "lastSeedProtection" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:da408e316cb2eb53fbee4dcddf3fe7ab4f4ee4e0e0a9eb216e109f403021e8bf
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "changeCategoryEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:6a5c1d804ce57eb5707e98cbf16c0245cdafbc5e53b32aad29c2527637d175cf
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "dryRunMode" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:e8e9b0d18dda51b9a2858e7ca4350e21d686b9d4548abbec3730e8fa63b24da7
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "maxRemovalsPerRun" INTEGER NOT NULL DEFAULT 10;

-- arr-schema-atom column:b1e9b54a9841b14cc3ac7d311d212501879df2b442f344fcdaa68cc96397c476
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "minQueueAgeMins" INTEGER NOT NULL DEFAULT 5;

-- arr-schema-atom column:e99707f3ffa45921111dc623fc2dc8f64798ada328db70122466898e554c97d2
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "strikeSystemEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:0158cf67793a113a30157e1a6297d69fa856e8c03f7a10053efb7b9acd730e57
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "maxStrikes" INTEGER NOT NULL DEFAULT 3;

-- arr-schema-atom column:439bbb61a5092deadfc515f3b4190de957fd8dbb7995fe34d322aa91510edf1e
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "strikeDecayHours" INTEGER NOT NULL DEFAULT 24;

-- arr-schema-atom column:fa91ca7db4613df1dcc48855a701a3b7fd95e4a6fb00d1862f23ea6a44d3457a
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "seedingTimeoutEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:0e830403dfb968f9ca8a1d6e37470822decba1657f5050a3bbf72b0e98633f51
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "seedingTimeoutHours" INTEGER NOT NULL DEFAULT 72;

-- arr-schema-atom column:05adb0857856c7c452e70985dbd443ab620636d3224f033cf83ceba8d14e4c4d
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "estimatedCompletionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:9a77360ebef7210cc65dcccd82d6556fb2d6fc9e94cd3b56066adc7547cd14fe
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "estimatedCompletionMultiplier" REAL NOT NULL DEFAULT 2.0;

-- arr-schema-atom column:6ff831cdc7950af1f5b0cf7ad4c235e50b1bd580bd4c83ad047e83281998b844
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "importPendingEnabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:ebdd8c8e85b6e90e0eda9a1a74e0e41abeb8dd5ab00c39ec39e84a7189539dd4
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "importPendingThresholdMins" INTEGER NOT NULL DEFAULT 60;

-- arr-schema-atom column:b41270bdbb4d41f60402ac2f7bb83cc497cdda2cdad69b79b8c6a12f40821e10
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "importBlockCleanupLevel" TEXT NOT NULL DEFAULT 'safe';

-- arr-schema-atom column:b8915f8f55d36d1528778999755c0ed4b4e9542b239ba6a384aa0ed35cef97db
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "importBlockPatternMode" TEXT NOT NULL DEFAULT 'defaults';

-- arr-schema-atom column:b977344dd92181e0b19c7746fa46fa5c38efa7e432628e98b7d9f92c496fc0eb
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "importBlockPatterns" TEXT;

-- arr-schema-atom column:8c74daea5c1aef7ce73d61d8b4c68b94b263add51dbb94f9d7b403542b015c4c
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "autoImportEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:c6f1cc0f6ff469d38e323bb57c37c44ef80bd9b513f7f9e4651b78be18cb5866
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "autoImportMaxAttempts" INTEGER NOT NULL DEFAULT 2;

-- arr-schema-atom column:7b02adfa7106a7b3431ec9e2938d84a5cee729cd13fbe30aa072889977fe25bb
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "autoImportCooldownMins" INTEGER NOT NULL DEFAULT 30;

-- arr-schema-atom column:eccce958b899ebcfc72499d1c2f8482cdcf19bb0f5e03cec363bb64431bf2160
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "autoImportSafeOnly" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:75a6d6445e053189310a0eea28ebef5e22f0411bbc6f981c379ed278e75a2744
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "autoImportCustomPatterns" TEXT;

-- arr-schema-atom column:86ab4c5407de18359e413a4b3b2d8c253f2f29ad1c58d8acefa8fe64de3776ec
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "autoImportNeverPatterns" TEXT;

-- arr-schema-atom column:a24c782e7cf01fae050b798f916f8a49c7332c85c8838095be45a375eb996fbc
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "tagFilterEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:7ebc361b88ea53fab897a3b0fe3b4ec42774722d8ff42808954dea4ea4995aae
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "includeTags" TEXT;

-- arr-schema-atom column:6c6ef80a8cb6754eab261af454cb331fd61b2b0a6366697b6d4062bc66359368
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "excludeTags" TEXT;

-- arr-schema-atom column:d1db3a5b113503eb6796acac3fd5dc4e03498146c47e03917134fada64b95aa8
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "profileFilterEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:9ebed4e54739ad0923973fa18b0902183cafb3f83ce4e47e2a1fc8c07d3e13ff
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "includeProfiles" TEXT;

-- arr-schema-atom column:40d2000e01200532cda50e789d28078a05db387c524a1499c647ae59b352192b
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "excludeProfiles" TEXT;

-- arr-schema-atom column:42118333e901060bbe3d7eeb06804ee081f9a39fed1f8a0b1cb3d6deab9c4f43
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "skipFutureEpisodes" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:10543529d6e3fa7348217631e9f404920cf3c191e3ef24fc77fca0007f63b526
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "whitelistEnabled" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:2770692ca8ed7e76bef7a71bc11f9ad90a458a5f13feaf7651f16309d539b70f
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "whitelistPatterns" TEXT;

-- arr-schema-atom column:fc4ccdfa898ad29fb3b210f5d0457a04c3c2cd08f5145e10fbd51d643bcc6b2d
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "lastRunAt" DATETIME;

-- arr-schema-atom column:5b9ca0165c31ed424b26ba5fd5df65f619910ff1a2f43deeb2bfab6b455bf9b2
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "lastRunItemsCleaned" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:5afe4749fc5a348d6a5a1936fb57330e3d93b11f96d9d9112654c7dc486f3ccf
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "lastRunItemsSkipped" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:5df5bec358694b0996ae19867ae892f7cce4194df0c304b003a0172454bb4f4d
ALTER TABLE "queue_cleaner_configs" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:8d52914f5d95235674a4576d6da9253bd0ef681693a3925af0a550a3ee5d58a8
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:7381a6a76d8bc0e0a92b9f9601a53cd33c0d087be80530dedb4d388bc6c7bf5d
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "downloadKey" TEXT NOT NULL;

-- arr-schema-atom column:897850ac1ce0b08376cd36466e5f36d0e42b97dbbaecfbc12fec257b9e1bc0e7
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "queueId" INTEGER NOT NULL;

-- arr-schema-atom column:213bdec349b707b45398d659c2dc3e2bc1f3e33649446497e21b6abc0a99bd51
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "downloadTitle" TEXT NOT NULL;

-- arr-schema-atom column:b69eebd9b9521505a3662651b52df74c385920f1b72327436f9e2d275d26485d
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "connectionFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:0b48a6ece307777610917af778a5be882d63184d219afd611a089d644833432c
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "commandFingerprint" TEXT NOT NULL;

-- arr-schema-atom column:66c41634a7799e4f6ebf88e093cd479012f86020390ebb225787182acf3fe00b
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "commandId" INTEGER;

-- arr-schema-atom column:e6ac37d2c542ec699284df903c50f8075c8506edd85d33bdb3255189ae78e480
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "state" TEXT NOT NULL;

-- arr-schema-atom column:9b3335737af4b15976481dc3fbc02ad0133a0fa06441f6d1e1729178b825b0e1
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "lastAttemptAt" DATETIME NOT NULL;

-- arr-schema-atom column:38d6de41cf7948ecc08b54fcbe1362099f72ce35b3ef8f920df1f5ce639601d3
ALTER TABLE "queue_cleaner_import_receipts" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:378019b801fc2293c6908bfafc7d4645c8e1088f31bcba9b865c59b5820dac3f
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:5f135aa5232c00e00ecd65ccc366ca4c036aa9051c4bcc4d3bf1927a1fc3d556
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "itemsCleaned" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:202e47b3b9cb864fe974433204db290d6f7b6707c31860aab54b917f4f50be6a
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "itemsSkipped" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:d1f30a96c99fa907f13fc3e8578200d610dcf298dc9db7a601872fc2aac7cc24
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "itemsWarned" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:d7f88c35ac013bd037db72096aea597da726fba769bb90b1bf941fcfa4b576b5
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "isDryRun" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:93d6d80f8510d1b7e74abbbbc77bc6799e2c16f414f097a199f6601b289dde0b
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "cleanedItems" TEXT;

-- arr-schema-atom column:1d56129813496ffd7c4c48cd94b262b23974598fafe6504f3be32f35ac24d057
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "skippedItems" TEXT;

-- arr-schema-atom column:9a325c4ea401d25f053cb35937088b47848a03110bfad17b2964ce07644d4fb8
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "warnedItems" TEXT;

-- arr-schema-atom column:10a938cdea0e9c757ac3313389896d518f97919a68f7db101aacbf14cd9c5d45
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "status" TEXT NOT NULL;

-- arr-schema-atom column:b1be724f0b5310b3337508869356c7950c1f1aa42304efcd3bfe20411c3f7c06
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "message" TEXT;

-- arr-schema-atom column:820aaf8ed2221fa5c4b718c44506c711e87267b9757c1ed2f2cabf8cb39a814d
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "durationMs" INTEGER;

-- arr-schema-atom column:fab74334483cf06a5001d53a20ca0a18c95ef83cee4c29044d8cb31ca37f2309
ALTER TABLE "queue_cleaner_logs" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:a46bdb27f055d468954ff0c3dc3ec3e691fdcc451c429d01e0ac4962382875d6
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:fb2b337e84cc441031adf6e984a4a89a5ed7db837f7b77758c422900194b86ec
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "downloadId" TEXT NOT NULL;

-- arr-schema-atom column:de5d44fb1123aebf10b8ffd2d9abb7d1a6d0c62b44f7c2d7e99fa21fd9d71036
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "downloadTitle" TEXT NOT NULL;

-- arr-schema-atom column:02bffe299cda3d82b3fe7ed6bb90a6f42168ea8eb9632f886d4ad5bf97d5d898
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "downloadHash" TEXT;

-- arr-schema-atom column:53f30366b9ef3de12fab6d98a822a510ff49dfc85831a666d217eaf5748ba611
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "downloadFingerprint" TEXT;

-- arr-schema-atom column:fd48f71110abb06dffcec287fbb6b1241651cb9369808f462f6dd328f2c10d51
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "strikeCount" INTEGER NOT NULL DEFAULT 1;

-- arr-schema-atom column:504e784425f8938fec898202d4ec446cdcf419389d0a531b3ecbf54d010eabdc
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "lastRule" TEXT NOT NULL;

-- arr-schema-atom column:a7881a17489dd50a888eb524e7882739bd352d86329bd139a237746e4d33f3fb
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "lastReason" TEXT NOT NULL;

-- arr-schema-atom column:55ee55bed1d4b26399bc1d79635e29881a59b8626326f67229a8a6adfee158aa
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "importAttempts" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:bb3b668d318bf097dff809409865453dfc2a72547aef02bc65e99b399d6f3499
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "lastImportAttempt" DATETIME;

-- arr-schema-atom column:90850297923cb4947585b176e28bf2865ad3399853c8ffeb05467747775cafe4
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "lastImportError" TEXT;

-- arr-schema-atom column:e34a03548d7e0b2d442fd7ca38e1ab8fee73532ab0cc2728e608ef5ffaaeb9f5
ALTER TABLE "queue_cleaner_strikes" ADD COLUMN "lastStrikeAt" DATETIME NOT NULL;

-- arr-schema-atom column:beca24e3da89f63912b7d3b216d124a7134da588446830917546dcc0a6a0069e
ALTER TABLE "qui_action_claims" ADD COLUMN "attemptId" TEXT NOT NULL;

-- arr-schema-atom column:474bc2f0e59c65443ef1966092ff4ee4ab93b8da7f45e771bf110d2fa5dcb03a
ALTER TABLE "qui_action_logs" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:e858939feeee7812ffceb4fa2351efedbbd9f028eb019322add24539f1dd3369
ALTER TABLE "qui_action_logs" ADD COLUMN "serviceInstanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:6db5709333acd55242d4f29859116ccb633eaaaaa66764140effa61cc73e20ca
ALTER TABLE "qui_action_logs" ADD COLUMN "qbitInstanceId" INTEGER NOT NULL;

-- arr-schema-atom column:3656106ef53b404573d0d3cb5f54183e47741de32a2add56d56c068862d55d9e
ALTER TABLE "qui_action_logs" ADD COLUMN "torrentHash" TEXT NOT NULL;

-- arr-schema-atom column:612e4ab8f872187dfc4ef8a626a1986c4ca42921ca31cc5276b6a04c8a3446a8
ALTER TABLE "qui_action_logs" ADD COLUMN "action" TEXT NOT NULL;

-- arr-schema-atom column:33ae56cfdd329156995a9565faaefa0d4fd5c32fe72b095f8645640b2973596b
ALTER TABLE "qui_action_logs" ADD COLUMN "payload" TEXT;

-- arr-schema-atom column:95f603639fcf01c2998dcce36f2e089b4df4474aa50912a2874e2e951ecf405a
ALTER TABLE "qui_action_logs" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';

-- arr-schema-atom column:6a9c6fdc219c84088fba522d4bb7d130f613c3305a1f0e723381068535875bc0
ALTER TABLE "qui_action_logs" ADD COLUMN "error" TEXT;

-- arr-schema-atom column:30e5151226e8e76e15056456f328090e74c59d0dc15ad3edeebaec463f558aa8
ALTER TABLE "qui_action_logs" ADD COLUMN "attemptId" TEXT;

-- arr-schema-atom column:541118925e7c22bfe25d908ccfcac377a04d1c0b3bd1bbec76eba3c1a93e4381
ALTER TABLE "qui_action_logs" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:9d7a517824869b6a4a9e630341d99c4f260ec9c8a3d1eabfecbcaae9884dc0aa
ALTER TABLE "qui_activity_logs" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:fb45b6158a5ee9194ab778522698bbc5c779f1b689af06e39f28fd2ca69347ee
ALTER TABLE "qui_activity_logs" ADD COLUMN "eventType" TEXT NOT NULL;

-- arr-schema-atom column:d18892021a649f14f16eba6e530b791fb28d90e98b7e277319307b2d6f647d4b
ALTER TABLE "qui_activity_logs" ADD COLUMN "details" TEXT NOT NULL;

-- arr-schema-atom column:4e9b549f96fe8803567676d96774939ee452b94307051f9eb5b0c41853312854
ALTER TABLE "qui_activity_logs" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ok';

-- arr-schema-atom column:9260e2beb4085e976a8fa90aef3dddc6ee1a335a356a2652088deab6680ccf20
ALTER TABLE "qui_event_logs" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:f822d25123660698a1d16a6386b42a59601c192aab0552dbbc0941ba0277a63d
ALTER TABLE "qui_event_logs" ADD COLUMN "serviceInstanceId" TEXT REFERENCES "ServiceInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- arr-schema-atom column:47eaf3c7c54f6e1ff00a8c38fa153e597f8c3dcf04c4d95a951f1c3af35c63f0
ALTER TABLE "qui_event_logs" ADD COLUMN "eventType" TEXT NOT NULL;

-- arr-schema-atom column:721c2625183cee9bbb533eafa6d872d5b80fe0de40287ac9d1a8d8fecb637aaf
ALTER TABLE "qui_event_logs" ADD COLUMN "torrentHash" TEXT;

-- arr-schema-atom column:6379f8d0132ad285c51d5106e7322ddd57de3b274db3d4a561be0eed15f76c3b
ALTER TABLE "qui_event_logs" ADD COLUMN "payload" TEXT NOT NULL;

-- arr-schema-atom column:8fb3fa20a42af35c8c881c73f355eff5a5795aba066526ed86cba1bcc4fd58f8
ALTER TABLE "qui_observation_publications" ADD COLUMN "generation" TEXT NOT NULL;

-- arr-schema-atom column:15d858490d89b514a25c67a7d8d4b8e2d2e99d511421ab93763731c46550fa6a
ALTER TABLE "qui_observation_publications" ADD COLUMN "topologyDigest" TEXT NOT NULL;

-- arr-schema-atom column:41a5bf8f9960bcc1410071c479146c819ab5c9dbdef4e63d28011ff7ca20fdec
ALTER TABLE "qui_observation_publications" ADD COLUMN "observedAt" DATETIME;

-- arr-schema-atom column:45938cd582e68c1e6b48712e979e1bcdcb014e99d45b3a97cf08c7832f87e20e
ALTER TABLE "qui_observation_publications" ADD COLUMN "rowCount" INTEGER NOT NULL;

-- arr-schema-atom column:746596a9c59a3a0b9975ff700eb38e6b220f2b570612f15bc0ac6aa2ea454cf0
ALTER TABLE "qui_observation_publications" ADD COLUMN "complete" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:1bc473779e1947b55dae61e25dc22db002073ac8b34ed5baa86938b7fb2f70e5
ALTER TABLE "qui_torrent_observations" ADD COLUMN "state" TEXT NOT NULL;

-- arr-schema-atom column:0bca86f22b97be86bc0ef8b90655636ae8427086723abf6e4daf131c78acd345
ALTER TABLE "qui_torrent_observations" ADD COLUMN "ratio" REAL;

-- arr-schema-atom column:9b44e44871b151d0d7a65080c183e4dd6f6b88d29b0564dc7003385f6dfc4cca
ALTER TABLE "seerr_action_logs" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:3ab7286aabff930b97908a238d03ef8c7e3215a6f6813d576a3558ef1ed71042
ALTER TABLE "seerr_action_logs" ADD COLUMN "userId" TEXT NOT NULL;

-- arr-schema-atom column:eee4172acaa5975b022c607c2c596858f672ca6696cc76c9dff0bb5b9636ddd6
ALTER TABLE "seerr_action_logs" ADD COLUMN "action" TEXT NOT NULL;

-- arr-schema-atom column:df796f698edeaceb2e5f6cc0a9d21fef36b8a111d1a6952b8934fd08877472ad
ALTER TABLE "seerr_action_logs" ADD COLUMN "targetType" TEXT NOT NULL;

-- arr-schema-atom column:8b355dfea95afb9e41f461699b248dcfc1e60b3528253ba087014537fcde042c
ALTER TABLE "seerr_action_logs" ADD COLUMN "targetId" TEXT NOT NULL;

-- arr-schema-atom column:7489e6142651ae295cfce5f36a011a19d0b3619b5a3970cb8d768539dce3e15b
ALTER TABLE "seerr_action_logs" ADD COLUMN "detail" TEXT;

-- arr-schema-atom column:1bfabfab80a668a7062189aa84c0c8953e43ef023ea469ba6a74288d4694ec32
ALTER TABLE "seerr_action_logs" ADD COLUMN "success" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:bc4fc165b82097e6d08e49f44b855f300496cefc04b18c5f31dc29d792d037bd
ALTER TABLE "session_snapshots" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:65a271cc707efe450b588ce1a4700fe08e36bde93b48efc9e7ef139631c29484
ALTER TABLE "session_snapshots" ADD COLUMN "concurrentStreams" INTEGER NOT NULL;

-- arr-schema-atom column:257f0c5ac1deb45e3a6b1d344307a5bfe55468bcf3c5e672a82f8ab65771d51b
ALTER TABLE "session_snapshots" ADD COLUMN "totalBandwidth" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:a46e12eb7b354031d23288c0f56ec828ee79f8860c519ef867f2c70f1b54555b
ALTER TABLE "session_snapshots" ADD COLUMN "lanBandwidth" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:59b60ba2ac89bd07cb9eb301b2639acf5540f26c6655fc67a0c6b541b4796fe4
ALTER TABLE "session_snapshots" ADD COLUMN "wanBandwidth" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:1a40cf31eb5efd4bde14ee272a23727e3ca5271df9792ba202a2f79116cca383
ALTER TABLE "session_snapshots" ADD COLUMN "directPlayCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:bf73af0128418cb50cf159e9855e177dc2c2c33f5b254a33f48d2017374be9da
ALTER TABLE "session_snapshots" ADD COLUMN "transcodeCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:a7388a996e4be718bea1d99670b429d53b799b3b644468faa6e42de6fbb3457b
ALTER TABLE "session_snapshots" ADD COLUMN "directStreamCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:b6fd9ea2c5833961ce63a19651b72879af0bb0bc7cbab4978c9dd865e0bd4ec0
ALTER TABLE "session_snapshots" ADD COLUMN "sessionsJson" TEXT NOT NULL;

-- arr-schema-atom column:d4fbe397e6a4afc8befd8fa739bf2b4c5e52ed17eea6afd912f3e7f5e65b60fe
ALTER TABLE "session_snapshots" ADD COLUMN "measurementJson" TEXT;

-- arr-schema-atom column:726dcbaae755664d6455057a086bbb9c2ada73c2a630385bf9a06a9c69d8d850
ALTER TABLE "sessions" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:9ab5bbe36237e06f0e55ef2ab45d181df4979fc79dac7adc7274387f8aa2bd5a
ALTER TABLE "sessions" ADD COLUMN "expiresAt" DATETIME NOT NULL;

-- arr-schema-atom column:dbf17563d9d1d3354ecbff2fafcdd779f9c24bd6a82d14ff424cd14b3c8d00e2
ALTER TABLE "sessions" ADD COLUMN "userAgent" TEXT;

-- arr-schema-atom column:67151d51d5d7a1ed174b3ea8671c89e63817f4c0e667866cfc59d553a4fb12d2
ALTER TABLE "sessions" ADD COLUMN "ipAddress" TEXT;

-- arr-schema-atom column:7ed35b21a74f1188a3994f6c07ac0fc58d05d868185b272662b9686947be848c
ALTER TABLE "standalone_cf_deployments" ADD COLUMN "userId" TEXT NOT NULL;

-- arr-schema-atom column:fee54ef8fbfeb80d25bf4eb0ddf6107951efd93b79448474bd6956961d1f740a
ALTER TABLE "standalone_cf_deployments" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:ac9d477c87d03a1358d485b21d18346171bfacfab7e8e4bf83618de5705df407
ALTER TABLE "standalone_cf_deployments" ADD COLUMN "cfTrashId" TEXT NOT NULL;

-- arr-schema-atom column:748788af5775f2a2cf3876554b0a9736f454af995a3ca05cf8a30c0c9e042789
ALTER TABLE "standalone_cf_deployments" ADD COLUMN "cfName" TEXT NOT NULL;

-- arr-schema-atom column:a4c4da0478ae76c91ef66943f9ed90e20ba3cd224547674267f9ea2dbc9f9fab
ALTER TABLE "standalone_cf_deployments" ADD COLUMN "serviceType" TEXT NOT NULL;

-- arr-schema-atom column:f466a9974fc64e680ae3a6d0fa7a1f69df01dce1508ccd787549d8c70f3cbf3f
ALTER TABLE "standalone_cf_deployments" ADD COLUMN "commitHash" TEXT NOT NULL;

-- arr-schema-atom column:3072c345afc44a370be4e54a8af88df9301948e092530029f4c9221e0b4594dc
ALTER TABLE "system_settings" ADD COLUMN "apiPort" INTEGER NOT NULL DEFAULT 3001;

-- arr-schema-atom column:d7465e12a583d91948f52501adae95f01183fe3cc598da2452a48adf9649a829
ALTER TABLE "system_settings" ADD COLUMN "webPort" INTEGER NOT NULL DEFAULT 3000;

-- arr-schema-atom column:bc773225500719e26d6f0c0ca32941f938dbeb2ba026ba9a100e77881582a8ca
ALTER TABLE "system_settings" ADD COLUMN "listenAddress" TEXT NOT NULL DEFAULT '0.0.0.0';

-- arr-schema-atom column:d26c0fab8f5ee264031adc14d2bc09666ee7399200a7a59f523bb6a1d6a96349
ALTER TABLE "system_settings" ADD COLUMN "appName" TEXT NOT NULL DEFAULT 'Arr Dashboard';

-- arr-schema-atom column:517141320eb0eb18135098339fdc7001b4f812635e7e23996eadf59ec0000c0b
ALTER TABLE "system_settings" ADD COLUMN "trustProxy" BOOLEAN DEFAULT false;

-- arr-schema-atom column:a09ad57cc4c40000617fae386fedcdb4022adfd1e299675ed47445bfffa5e1fa
ALTER TABLE "system_settings" ADD COLUMN "secureCookies" BOOLEAN;

-- arr-schema-atom column:4aaa8c052db9729a1dab90cb97df56a0751ad3e6d35dc29c6fcad550f0e81f48
ALTER TABLE "system_settings" ADD COLUMN "notificationLogRetentionDays" INTEGER NOT NULL DEFAULT 90;

-- arr-schema-atom column:e1f1953936ae0c3c748f6dff16701e67cfa7229a3af31d44397859ab04b13e97
ALTER TABLE "system_settings" ADD COLUMN "externalUrl" TEXT;

-- arr-schema-atom column:4e15fdff43136492f5363c4c972f2e881f32035f94e49f3f9541baff3a839af1
ALTER TABLE "system_settings" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:7e24c1cc54f8551f0d2a671b3a1ae16d5b00d2a93a0a7316f287b700f5008ccc
ALTER TABLE "tautulli_cache" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:6460d1eb07baf807394fdf8272a01df8135f5cbd55b7b914792a454860b66f85
ALTER TABLE "tautulli_cache" ADD COLUMN "tmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:52852f3e265c9bef6e3318773479c99d07413cb33d60ee46e779234bcde4d0b7
ALTER TABLE "tautulli_cache" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:ec2f6e7d0f43d056f59d9e148999564c263fd4bfda41b60258c2af41c54fefff
ALTER TABLE "tautulli_cache" ADD COLUMN "lastWatchedAt" DATETIME;

-- arr-schema-atom column:0cc1a8234c4a28433f7bd528dd1ae3d057ece6d55f53993c9af3621dc415e1ac
ALTER TABLE "tautulli_cache" ADD COLUMN "watchCount" INTEGER NOT NULL;

-- arr-schema-atom column:09e33ee5a18d243084a665999996378109a3f0d2d674317613feb31cadd3d7dd
ALTER TABLE "tautulli_cache" ADD COLUMN "watchedByUsers" TEXT NOT NULL;

-- arr-schema-atom column:7789724a30c85f4a40712c7876eea9d4da5099316ba5ef77262ee740caf1291e
ALTER TABLE "tautulli_cache" ADD COLUMN "connectionGeneration" INTEGER;

-- arr-schema-atom column:a1cdc0c7002f0f203650a7a79495802b1ea60c66d7c9df00c59e6fe901f38e69
ALTER TABLE "tautulli_cache" ADD COLUMN "identityGeneration" INTEGER;

-- arr-schema-atom column:24f1bdbd58006def0a6622c8d09321abbda457e9525420d5406ed37e4f9d995c
ALTER TABLE "template_deployment_history" ADD COLUMN "templateId" TEXT NOT NULL REFERENCES "trash_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:f60e0aa4fd20ed37d3cfae19404a154da7163c43d99b0d70170beb421c9b372c
ALTER TABLE "template_deployment_history" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:8afe115c7c4e13020cdefaa365faa04eae5e2d9d547a9b1c0be08828ad5861db
ALTER TABLE "template_deployment_history" ADD COLUMN "userId" TEXT NOT NULL;

-- arr-schema-atom column:24ad77193eed4f16de628c7ace8b9bf5c656334f84f7a6b9b3a7ac3ef9e260f1
ALTER TABLE "template_deployment_history" ADD COLUMN "deployedBy" TEXT NOT NULL;

-- arr-schema-atom column:92c4ff1690dfe477fb1048cd6018d352e3672471618c88b1c99d4963d0318ed7
ALTER TABLE "template_deployment_history" ADD COLUMN "duration" INTEGER;

-- arr-schema-atom column:42eb5620ad07ef858e7c2a9c65e737c697dc4586fd5f9c644f0d98803d2adfdb
ALTER TABLE "template_deployment_history" ADD COLUMN "status" TEXT NOT NULL;

-- arr-schema-atom column:b4eb8ec091e6c6de31ba42a948782f60ba6cae4e0bf039a72996925076cff396
ALTER TABLE "template_deployment_history" ADD COLUMN "appliedCFs" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:c48b2cabc278ac9916e5141a940c673f0686005f64c1fe60026e268f88b4229c
ALTER TABLE "template_deployment_history" ADD COLUMN "failedCFs" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:b54b0d172f7172e677050c9c005e9c1186d790a08891cbcd3a6e571b7054a1cd
ALTER TABLE "template_deployment_history" ADD COLUMN "totalCFs" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:3a597ba0d5ac6931f5ac524499caad5a6f5770447f037030635c37d34fc4d3b3
ALTER TABLE "template_deployment_history" ADD COLUMN "conflictsCount" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:418134cd91cefbb80f752132830a7558de3fb2d7d90ef3d13cd0efa60e76b8c8
ALTER TABLE "template_deployment_history" ADD COLUMN "appliedConfigs" TEXT;

-- arr-schema-atom column:67e541d1f5f16124252090995dd614a403ec175070d4aeb21f38910363ce44cb
ALTER TABLE "template_deployment_history" ADD COLUMN "failedConfigs" TEXT;

-- arr-schema-atom column:0088df2f787986d6f8eb3e2e7cefb4e53630a55eb3fbeaf4a6d583635682aa7a
ALTER TABLE "template_deployment_history" ADD COLUMN "conflictResolutions" TEXT;

-- arr-schema-atom column:0107c6e2522d7bcbadb3f9a39311c1547198cb29df96f5cd0227cb4a6bbbff88
ALTER TABLE "template_deployment_history" ADD COLUMN "errors" TEXT;

-- arr-schema-atom column:4c677e6c1f2fb263b6d02ec8cef5c252c5aeb0e12b78529385b8dc40d0d97773
ALTER TABLE "template_deployment_history" ADD COLUMN "warnings" TEXT;

-- arr-schema-atom column:1720c249f71a13bab55c66b6046236bf67948356ab578239ce655e2e4f12b6bc
ALTER TABLE "template_deployment_history" ADD COLUMN "backupId" TEXT REFERENCES "trash_backups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- arr-schema-atom column:cc82de7ee966dc3c042d7840ac62e83fc344874e9e500f1fcadbe2659ecee9e3
ALTER TABLE "template_deployment_history" ADD COLUMN "canRollback" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:cb5ee0ca492e53eede84e51d8a816eaaee3afb1d0d58168b0f3f8f24e7b2506b
ALTER TABLE "template_deployment_history" ADD COLUMN "rolledBack" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:1c857ebd8cbe8219656b4080a3164e063d956fe4fc11b7c8094564c748ba1068
ALTER TABLE "template_deployment_history" ADD COLUMN "rolledBackAt" DATETIME;

-- arr-schema-atom column:1c48f8202d71ad7ee2cf4c3db475be20304c6367ba6f599e25d4e5276bfb3463
ALTER TABLE "template_deployment_history" ADD COLUMN "rolledBackBy" TEXT;

-- arr-schema-atom column:ad9053fc1903a6ba066972e7b5220e2c7fc976190e1f68468eca0104c33fecb9
ALTER TABLE "template_deployment_history" ADD COLUMN "undeployStatus" TEXT;

-- arr-schema-atom column:e50b8037f030e5ef0ebd7f491cbef2d8467f48853922a2f2211b94d1423e3cdb
ALTER TABLE "template_deployment_history" ADD COLUMN "undeployAttemptedAt" DATETIME;

-- arr-schema-atom column:54bf67ec8e2c7c02425833c3670603b8c8387f92d69180372614ef8d63867664
ALTER TABLE "template_deployment_history" ADD COLUMN "undeployProgress" TEXT;

-- arr-schema-atom column:bbed77098b69026710949252e7326028f43f8fc0a6585b57a14925ee628413ca
ALTER TABLE "template_deployment_history" ADD COLUMN "deploymentNotes" TEXT;

-- arr-schema-atom column:c33e0dcfcd370bab4fa8a6b4b7026cc165dc7f7ee5c79891f021d8de6bc233c3
ALTER TABLE "template_deployment_history" ADD COLUMN "templateSnapshot" TEXT;

-- arr-schema-atom column:1a057fb3a43fc4ebb37ec50f7c65f8126d0df8b8f52b61ff6af27ae0364de4bd
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "templateId" TEXT NOT NULL REFERENCES "trash_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:1bb55ef0f20a44e7ce06b0aafe4bdddfa2d166b0edf4f549b7be32ec26015d37
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:ed6cb5f993a1c51085675e8dc3e88d94f98ce6ca1f9c4d3fdf74e34bc8f14398
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "qualityProfileId" INTEGER NOT NULL;

-- arr-schema-atom column:9740a9fc3f862fa16829dab51b3c4cbea46f299c51d8b15e5fab489a31817404
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "qualityProfileName" TEXT NOT NULL;

-- arr-schema-atom column:1ccf9abe9952cbfbba21ecf5d4738369a3a29dd9bb616fc2341450f9a34bf87c
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "connectionGeneration" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:1242edd1f331e134e2e3e8a51d036d9aa4cab7dec5d7a6ed39f90b7641276b89
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "connectionStateToken" TEXT;

-- arr-schema-atom column:4ec452cf3cb600bd63c0bd1eb4704710fc3033707fe118412bacdf7c2632c3c3
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "managedCustomFormats" TEXT;

-- arr-schema-atom column:a4482882586d40c8c61b0f27221de0cdd20cc360ee206f771df7c65a8c7a9228
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "managedCustomFormatsCaptured" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:4abe9ac852ed7c937c6ca8e5dd330bd6de5f590a75adc301960f57afdfebee0b
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:66744e5645b162f8c5ba08c87ad2fe15fcbcfc9e7528e80df64641ecc4bdcb2a
ALTER TABLE "template_quality_profile_mappings" ADD COLUMN "syncStrategy" TEXT NOT NULL DEFAULT 'notify';

-- arr-schema-atom column:e29b90b5e50f2246e4c499fde5b43fbe4fd71d06214576fce1cf9dbff69a883b
ALTER TABLE "tmdb_list_cache" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:4bd92a1ada7ef97e7bdd46e67514adf5c9c00c0cfcfae2fafc6cfe7cb8448bdc
ALTER TABLE "tmdb_list_cache" ADD COLUMN "listId" TEXT NOT NULL;

-- arr-schema-atom column:94b51a5a00047c727f775e50b759774601c9a2e2c53e0a4dedbc4b769a8e414e
ALTER TABLE "tmdb_list_cache" ADD COLUMN "tmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:2f08cd433e2ac0d653c02914895c3b80d943f77a725941b2e1d31f52f7e32337
ALTER TABLE "tmdb_list_cache" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:7a2b491b200dac41ed50eb359c90db467b8048b1695c85a12d4acfb5c7bd2bc5
ALTER TABLE "tmdb_list_cache" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:358befdd7eb0c9f41ed629ca9b714b9330b22d0e3acdb577936e1d5e4c52dfce
ALTER TABLE "tmdb_list_cache" ADD COLUMN "generation" TEXT NOT NULL DEFAULT 'legacy';

-- arr-schema-atom column:98941abe19d316c7ba601338898cc960af060ac77b7b03a33aa483fcac77c9ab
ALTER TABLE "trakt_list_cache" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:9cf8f5d9c8e60de1566da519f9700363a1ce68c09492ed0ae584fe175e8cebef
ALTER TABLE "trakt_list_cache" ADD COLUMN "listSlug" TEXT NOT NULL;

-- arr-schema-atom column:aa8583817c948bad9e4b3e3c5d47def6b4fb79ae8fa69aaa8e88c8aa55dfc563
ALTER TABLE "trakt_list_cache" ADD COLUMN "tmdbId" INTEGER NOT NULL;

-- arr-schema-atom column:ababb3d5195c07189ccb256b4803e58227a9ebd420a1f0868bf0973303a2d67c
ALTER TABLE "trakt_list_cache" ADD COLUMN "mediaType" TEXT NOT NULL;

-- arr-schema-atom column:210edb290774ee5054f99de7f40da40fe946069d4cbb5b061b0c5206f3126c93
ALTER TABLE "trakt_list_cache" ADD COLUMN "title" TEXT NOT NULL;

-- arr-schema-atom column:b527f6af35b3c2a0c068a8974b2d86b171de0a977374f6b1db975124c04ad90e
ALTER TABLE "trakt_list_cache" ADD COLUMN "generation" TEXT NOT NULL DEFAULT 'legacy';

-- arr-schema-atom column:50277a6b087b5c50983e1e74e5b340c51717af5d89a2b86b71afb5d095e2e13d
ALTER TABLE "trash_backups" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:b72b25c32ac1de3dd90733e823b4828f335c90d0a29decc7ec6bed6a906c5354
ALTER TABLE "trash_backups" ADD COLUMN "userId" TEXT NOT NULL;

-- arr-schema-atom column:2e53729d99f731c7c09d55a242ff4b514e79394f67e5fad0ecd66215cb03e380
ALTER TABLE "trash_backups" ADD COLUMN "backupData" TEXT NOT NULL;

-- arr-schema-atom column:a2ec43f67b79910e10d313ef3dd92806e781006dcd0ae40693b99a9e8118c7c9
ALTER TABLE "trash_backups" ADD COLUMN "expiresAt" DATETIME;

-- arr-schema-atom column:59b3324b535c41d80f5ae48354b8352c9f9ac95dfea115ba18ab4b4b6333329c
ALTER TABLE "trash_cache" ADD COLUMN "serviceType" TEXT NOT NULL;

-- arr-schema-atom column:7ccf234917087e0fe3f193c9882da8c4a1afcd88e58ec6b65cb7d87f96f61536
ALTER TABLE "trash_cache" ADD COLUMN "configType" TEXT NOT NULL;

-- arr-schema-atom column:39c1451eb9972ffdbaa9663aff0dc89f8a3ba4428611791b010a62ec22ff656c
ALTER TABLE "trash_cache" ADD COLUMN "data" TEXT NOT NULL;

-- arr-schema-atom column:5470a6a9514002dfdec1cc0efdb79cab4a8a2f43b2afc41fdc3304a740112870
ALTER TABLE "trash_cache" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- arr-schema-atom column:1b4d097f6da4272c348e391fff488634467113ab26ecdaa338fca585dc765b01
ALTER TABLE "trash_cache" ADD COLUMN "commitHash" TEXT;

-- arr-schema-atom column:fc37a26ff92742021445e7d80de1338b537f1f137857d021272c881df338adb1
ALTER TABLE "trash_cache" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:6903437963f03d40acb7b7ce73ccc65d7f1ff51b1ebb4986c8d5aa35681b37e4
ALTER TABLE "trash_settings" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:0d460c9c9734c1c76f000a2d84735b5ba7c80b263c12b894e3949840286d0d1b
ALTER TABLE "trash_settings" ADD COLUMN "checkFrequency" INTEGER NOT NULL DEFAULT 12;

-- arr-schema-atom column:291c6c25f31734949bda0d8c1f2e8f8cd3a4a8cc5e4d0e3cbc73cfdac5e85c82
ALTER TABLE "trash_settings" ADD COLUMN "autoRefreshCache" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:3bf1312cf82d4f53afa0d98bc50907f3ec7c44b74e61b7210174bdd231a4ecd0
ALTER TABLE "trash_settings" ADD COLUMN "notifyOnUpdates" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:1f1793f05e775b61e7b53f73dfe33cdd9b34d010f273e1a74c2325c8d22605f4
ALTER TABLE "trash_settings" ADD COLUMN "notifyOnSyncFail" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:72478974516ad101c6ffff77c6d4c314f7c956aaf17fc726ae1342a4945b5279
ALTER TABLE "trash_settings" ADD COLUMN "backupRetention" INTEGER NOT NULL DEFAULT 10;

-- arr-schema-atom column:ad003dcf98d895d8f3bfdb273fa92466df641212610eeb97fd370517b814726c
ALTER TABLE "trash_settings" ADD COLUMN "backupRetentionDays" INTEGER NOT NULL DEFAULT 30;

-- arr-schema-atom column:85214ab5ffefeddf27ed54b2e2c4a829b93898f8dbd2b94e18c4949e1926ba56
ALTER TABLE "trash_settings" ADD COLUMN "customRepoOwner" TEXT;

-- arr-schema-atom column:44bbaf4c12d577cbad89aba852a2a2238e4155d4ce2d3d352373dc17edaee9fd
ALTER TABLE "trash_settings" ADD COLUMN "customRepoName" TEXT;

-- arr-schema-atom column:32028bcef357d1be2b6e33a2c928b3cbe73caaef2bd40b80e66197c68b4e9b19
ALTER TABLE "trash_settings" ADD COLUMN "customRepoBranch" TEXT;

-- arr-schema-atom column:a3c704fa1402c957be85ec3b707d8e03a1d0a24d57682a13aea2345d4b2f884d
ALTER TABLE "trash_settings" ADD COLUMN "customRepoMode" TEXT NOT NULL DEFAULT 'fork';

-- arr-schema-atom column:3bc3e26f7697e2a16d2094a4cb7fabc4b9931bb97486d9857e38ed68bd9806f8
ALTER TABLE "trash_settings" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:3419e766f7d0a66d1406e9ec2e5109b3453481a031c312e0d197150a45befcfd
ALTER TABLE "trash_sync_history" ADD COLUMN "instanceId" TEXT NOT NULL REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:1d5f9d99bfa10b99ceb0a40011276fb2360157833bf8041a8367dfff3d614aee
ALTER TABLE "trash_sync_history" ADD COLUMN "templateId" TEXT REFERENCES "trash_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- arr-schema-atom column:53753c93713367196ba5ec758bd42ffebbdcdfcf170c3dfe2722d74c65f39e47
ALTER TABLE "trash_sync_history" ADD COLUMN "userId" TEXT NOT NULL;

-- arr-schema-atom column:41bdbf272b026b4cb976b5439596ec1a5e1d2dcf2d1df5d8ff92c72198c49fbd
ALTER TABLE "trash_sync_history" ADD COLUMN "syncType" TEXT NOT NULL;

-- arr-schema-atom column:068b0ea361f51dea03a9638672e9c321eccac7e0f76d6ac4cb40065063be5edb
ALTER TABLE "trash_sync_history" ADD COLUMN "status" TEXT NOT NULL;

-- arr-schema-atom column:d549bc8d52aa0696ef3b5f6110e173855e9544fbea035f0b6d719b2f1a33f2ed
ALTER TABLE "trash_sync_history" ADD COLUMN "completedAt" DATETIME;

-- arr-schema-atom column:809f444c4b3a15c5c02f5769de04924193e9bf8c3f95bd47a5f8e0fed555050c
ALTER TABLE "trash_sync_history" ADD COLUMN "duration" INTEGER;

-- arr-schema-atom column:1e9fe8a1df9ea03a97cfa0c56347a1dac9a42898724455da584d04e82ef32d63
ALTER TABLE "trash_sync_history" ADD COLUMN "configsApplied" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:41d517e87974a514032732cd3231a361d578a5fa0c89e0aca26a112a707817fc
ALTER TABLE "trash_sync_history" ADD COLUMN "configsFailed" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:68efcfadaa445f99adc5a02277284961543082744ab717885dbc05c6930deac9
ALTER TABLE "trash_sync_history" ADD COLUMN "configsSkipped" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:73cf49f36bbc733827776f8c4236a1e08446a416443a390c3552466e25b99bba
ALTER TABLE "trash_sync_history" ADD COLUMN "appliedConfigs" TEXT NOT NULL;

-- arr-schema-atom column:013566a722aff458e92acfad5990678899bbac2d18f01d3aea55e949cdbfd841
ALTER TABLE "trash_sync_history" ADD COLUMN "failedConfigs" TEXT;

-- arr-schema-atom column:c91720be4363236d4d819ccbb523a6fa52cfe1707e4f486a43384cce8d3a092d
ALTER TABLE "trash_sync_history" ADD COLUMN "errorLog" TEXT;

-- arr-schema-atom column:f77621322fca9ebed38df0ec7715206b151744a4a9bae3b4a5de991d31b50cd9
ALTER TABLE "trash_sync_history" ADD COLUMN "backupId" TEXT REFERENCES "trash_backups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- arr-schema-atom column:a83cc4b2ab8e7ad610f32da5993689b593a60fd23520bd32a77f3966e92afbf2
ALTER TABLE "trash_sync_history" ADD COLUMN "rolledBack" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:c974fde0b2b6a4531f0e1600fa4eef671cbc6168a3d53682c8d6a85afd4e3c6c
ALTER TABLE "trash_sync_history" ADD COLUMN "rolledBackAt" DATETIME;

-- arr-schema-atom column:6c767e0dda5dbc621b0cc38478a0973483753dee9d49238c3cfadad1cf559376
ALTER TABLE "trash_sync_history" ADD COLUMN "rollbackStatus" TEXT;

-- arr-schema-atom column:f72a7031a65bfaae6704a13c66bcc7acc4cc3d83b71f4694ccc95122cd8cf6ce
ALTER TABLE "trash_sync_history" ADD COLUMN "rollbackAttemptedAt" DATETIME;

-- arr-schema-atom column:63f6be665cbc555d072e68b18d6519673b86bf29838e7bdc91709cc7c4d9593f
ALTER TABLE "trash_sync_history" ADD COLUMN "rollbackProgress" TEXT;

-- arr-schema-atom column:8f730cfd01aa80292c59b5c8d0d1fde50b4dbd8326b87967d6e6079328b7c2e5
ALTER TABLE "trash_sync_schedules" ADD COLUMN "instanceId" TEXT REFERENCES "ServiceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:c4a954baf3dbc1d2c0229b3475d26398a02b661f362d0161f4acded96b38b987
ALTER TABLE "trash_sync_schedules" ADD COLUMN "templateId" TEXT REFERENCES "trash_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:22f21bfdf906732191049975843e22d88fdc0e24698de0f95d7388523cd8f63e
ALTER TABLE "trash_sync_schedules" ADD COLUMN "userId" TEXT NOT NULL;

-- arr-schema-atom column:dd3c54bb6da1f417a0585875b383baeb4213cf0d80ecd5e0864557f6b7a16b43
ALTER TABLE "trash_sync_schedules" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:976c4eb6d68f0c0e7b55a567b34e894dd84574416cc44adecbf3aaa491289a04
ALTER TABLE "trash_sync_schedules" ADD COLUMN "frequency" TEXT NOT NULL;

-- arr-schema-atom column:bcfa7e6c78b4311bf725e7d9c6fcb38d1be7e9195c135eaf9e50638ea4d04fe5
ALTER TABLE "trash_sync_schedules" ADD COLUMN "lastRunAt" DATETIME;

-- arr-schema-atom column:bd03d36a13ed1b9ad600cc8083d93852743070046c467b477afb036c0b4c68f3
ALTER TABLE "trash_sync_schedules" ADD COLUMN "nextRunAt" DATETIME;

-- arr-schema-atom column:2260d61c8e208a6eb2da2168983235ce292a38678d94a24be8e551d82f5c6ed8
ALTER TABLE "trash_sync_schedules" ADD COLUMN "autoApply" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:dad8e09a72db87d31fecbb089a894eb338d92779e26683aab65ab30f97822a41
ALTER TABLE "trash_sync_schedules" ADD COLUMN "notifyUser" BOOLEAN NOT NULL DEFAULT true;

-- arr-schema-atom column:2fa955c993797fa4655b27ab0831c6e0f75f3f2e9a66466156394ba5c7336078
ALTER TABLE "trash_sync_schedules" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:449823c6ed58c2addc657562d4c126a804420a141e10e4cf49c3068991a49588
ALTER TABLE "trash_templates" ADD COLUMN "userId" TEXT NOT NULL;

-- arr-schema-atom column:1cde2de3ba66524db2012e0df8b30608ac02db3728e9e6f0939a265681c8c9f8
ALTER TABLE "trash_templates" ADD COLUMN "name" TEXT NOT NULL;

-- arr-schema-atom column:82e1a94fc68158a2ffc86c8905d603e06048694155b6fce69188c01689c80c50
ALTER TABLE "trash_templates" ADD COLUMN "description" TEXT;

-- arr-schema-atom column:3349837f9506e5d2f8765a246d1bf31fd69e1d7b3c9f1798bd93aafac37d0d82
ALTER TABLE "trash_templates" ADD COLUMN "serviceType" TEXT NOT NULL;

-- arr-schema-atom column:95956dd66c2a739b627e1862942f5ce881d0e84c3f728d51c7a947231fbf75c0
ALTER TABLE "trash_templates" ADD COLUMN "configData" TEXT NOT NULL;

-- arr-schema-atom column:85697b3844b0ca87879f98ee8162b439f1f0994123cfe310a9af8cc4626cf108
ALTER TABLE "trash_templates" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:35d0c6f316ece46fcd367848f1cf80049d4f7a48ec65b0b2bd8ac41cf4cda2af
ALTER TABLE "trash_templates" ADD COLUMN "deletedAt" DATETIME;

-- arr-schema-atom column:c432646ee1af84a48d30b7a6c8632bfe3c93a82815be67283f6600311e8b2d3e
ALTER TABLE "trash_templates" ADD COLUMN "sourceQualityProfileTrashId" TEXT;

-- arr-schema-atom column:140268064a0af2a26f840e9bc91b5a5b595271293106e7ea87840d67aae845ee
ALTER TABLE "trash_templates" ADD COLUMN "sourceQualityProfileName" TEXT;

-- arr-schema-atom column:148bb3e0fa72728cb00017e0b56fb56f9bbd2e3a6ba1ddf526616a48368afa2c
ALTER TABLE "trash_templates" ADD COLUMN "trashGuidesCommitHash" TEXT;

-- arr-schema-atom column:1d31750919a74cec302cf65d5c2689ba51eda01a16f2ae88bcd8d93f7fc1d137
ALTER TABLE "trash_templates" ADD COLUMN "trashGuidesVersion" TEXT;

-- arr-schema-atom column:e3b2e7b3943ab877243360b1c6d1946c94a5c74989a426f56d1728cbe1c3752f
ALTER TABLE "trash_templates" ADD COLUMN "lastSyncedAt" DATETIME;

-- arr-schema-atom column:8c3f5e836ec600c1414776cb71609810b5b3684aa6fe8a2bd5c94dd1eb12f29b
ALTER TABLE "trash_templates" ADD COLUMN "hasUserModifications" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:c051f2b49cc869bc288fde7508c98ec86caa8eac885525c527e358e805442b9c
ALTER TABLE "trash_templates" ADD COLUMN "modifiedFields" TEXT;

-- arr-schema-atom column:5058467427eafdb8ca2ee748fa0da8f8555edb047272347459a2576f79c98b83
ALTER TABLE "trash_templates" ADD COLUMN "lastModifiedAt" DATETIME;

-- arr-schema-atom column:464903903c5c964519602492ff9ab3185d22ff0827c23dc84f05a8558a5e615a
ALTER TABLE "trash_templates" ADD COLUMN "lastModifiedBy" TEXT;

-- arr-schema-atom column:1134c4f1e2a01ac5fdaa64f14c9e557e3c5fc3c17f08ad91a2389403a0f7136e
ALTER TABLE "trash_templates" ADD COLUMN "changeLog" TEXT;

-- arr-schema-atom column:639ee835157a33c83fa7e9ef30ba2ea34867ac558b60ee3b8ced31d1830703fd
ALTER TABLE "trash_templates" ADD COLUMN "instanceOverrides" TEXT;

-- arr-schema-atom column:1a1c48e766fd740c716100eada7bd02e1a1e3a33489802b7b665d1aaf0959dcd
ALTER TABLE "user_custom_formats" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:fa3c5cf95e4832283edd4bd53e4316d517732d9780022cf3174ae6f284968cb1
ALTER TABLE "user_custom_formats" ADD COLUMN "name" TEXT NOT NULL;

-- arr-schema-atom column:6861599d083fe08dc0328556eec9f7ff37ac9c7773bbf172837d13a288873ba6
ALTER TABLE "user_custom_formats" ADD COLUMN "serviceType" TEXT NOT NULL;

-- arr-schema-atom column:75bf447713199e99b931fea4c56aaacd936ad3646813d5d764fcee7a54aaa5b3
ALTER TABLE "user_custom_formats" ADD COLUMN "description" TEXT;

-- arr-schema-atom column:f8112c5ee3c8b0ce8714c4690b980706c1c957462ef08da0cdfbfbc3e1cb8a37
ALTER TABLE "user_custom_formats" ADD COLUMN "includeCustomFormatWhenRenaming" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:494e67547a8516320e60e64249de058c75049bfdc777eed1b70417bee564cdef
ALTER TABLE "user_custom_formats" ADD COLUMN "specifications" TEXT NOT NULL;

-- arr-schema-atom column:3052d117f28dabce1372f86c4b2cdd8f8686a96ab5bb07fc3ee8872d2ba67362
ALTER TABLE "user_custom_formats" ADD COLUMN "defaultScore" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:a8ea6149582dd4d515e75d99e3122759939a065d8de990602e53900515257b0b
ALTER TABLE "user_custom_formats" ADD COLUMN "sourceInstanceId" TEXT;

-- arr-schema-atom column:534172a71cc11c2dbacd845d43d3aaac9c81b2604c0a6711ff9f20b4b670fdbb
ALTER TABLE "user_custom_formats" ADD COLUMN "sourceCFId" INTEGER;

-- arr-schema-atom column:6183047ae28c14f9af46782f13b8d8695fdeb6585f8b38ddcc02c37943b7d165
ALTER TABLE "user_custom_formats" ADD COLUMN "updatedAt" DATETIME NOT NULL;

-- arr-schema-atom column:1c1cb7bd51ba53ec160e425540b9c2fe922fd114ff6c4457af13e0183b09f296
ALTER TABLE "vapid_keys" ADD COLUMN "publicKey" TEXT NOT NULL;

-- arr-schema-atom column:d82cea90c1a7a77d86245e653b608a6b0bb50c3b5401c7c56d2c92e20f05ee6f
ALTER TABLE "vapid_keys" ADD COLUMN "encryptedPrivateKey" TEXT NOT NULL;

-- arr-schema-atom column:9cbe40d74031c396b70e6d6d60bd7f37bb831055b6607a58f895601cb62dd639
ALTER TABLE "vapid_keys" ADD COLUMN "privateKeyIv" TEXT NOT NULL;

-- arr-schema-atom column:8dbdc4ec25f398b71bd244504ade822ea43c68f8c1517dcf217cf958a2b15992
ALTER TABLE "webauthn_credentials" ADD COLUMN "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- arr-schema-atom column:fbbb787915dd1c2f9a14d98fb97dd91503467d695023623ee1d4be6362a37f34
ALTER TABLE "webauthn_credentials" ADD COLUMN "publicKey" TEXT NOT NULL;

-- arr-schema-atom column:08cfb505ef81c089b9142ac06b1ab59fe6090faf6f8bdc83e8624778f55cc859
ALTER TABLE "webauthn_credentials" ADD COLUMN "counter" INTEGER NOT NULL DEFAULT 0;

-- arr-schema-atom column:68452123e83ea008ecda0b85895e991b0fc8293ddd0b36469d8f1550008ac9c3
ALTER TABLE "webauthn_credentials" ADD COLUMN "transports" TEXT;

-- arr-schema-atom column:3651ddc775da31e6243a18e0db5f29d6229f56bc790a95628d94a40f05296102
ALTER TABLE "webauthn_credentials" ADD COLUMN "backedUp" BOOLEAN NOT NULL DEFAULT false;

-- arr-schema-atom column:d180a74e168df8b1b809d6f69e553ffae4ab1c4b6770c91918707f9b189f3983
ALTER TABLE "webauthn_credentials" ADD COLUMN "friendlyName" TEXT;

-- arr-schema-atom index:72ce2da256dd5c1de12165caedad188aba723edb256e37caca876ea403da8e16
CREATE UNIQUE INDEX "NotificationOutboxDelivery_eventId_channelId_key" ON "NotificationOutboxDelivery"("eventId", "channelId");

-- arr-schema-atom index:facefdaee2d370045ad4ed2927089f9f79563c8bf742ac03abcee338c93a9912
CREATE INDEX "NotificationOutboxDelivery_userId_eventId_idx" ON "NotificationOutboxDelivery"("userId", "eventId");

-- arr-schema-atom index:a798b7cada94c5550a277b5d256d877b11122f4dc4d934db59b5c08444214a28
CREATE INDEX "NotificationOutboxDelivery_userId_state_nextAttemptAt_idx" ON "NotificationOutboxDelivery"("userId", "state", "nextAttemptAt");

-- arr-schema-atom index:1f63524d4bad469490fc8168a0047253f61307d64171d3a2c960e1732035d08a
CREATE UNIQUE INDEX "NotificationOutboxEvent_id_userId_key" ON "NotificationOutboxEvent"("id", "userId");

-- arr-schema-atom index:09741d4151e2e7131ade2adef0d8625b0ffc58cd547bbcac0bf55fbc19f67276
CREATE INDEX "NotificationOutboxEvent_userId_dedupFingerprint_acceptedAt_idx" ON "NotificationOutboxEvent"("userId", "dedupFingerprint", "acceptedAt");

-- arr-schema-atom index:22276b82bd7eb6155cced213eab12569e783b1915f3d83600c3cea437038a977
CREATE INDEX "NotificationOutboxEvent_userId_scopeFingerprint_stage_idx" ON "NotificationOutboxEvent"("userId", "scopeFingerprint", "stage");

-- arr-schema-atom index:5824697163da2011e107270afd9633c0438a4b0aa5e69c2426885dfaf1557a49
CREATE INDEX "NotificationOutboxEvent_userId_stage_dueAt_idx" ON "NotificationOutboxEvent"("userId", "stage", "dueAt");

-- arr-schema-atom index:0fa00488783cb5b14b9d8c4b329321e7f60fefd4aca61a795020efb1041e305e
CREATE UNIQUE INDEX "SearchGrabAttempt_id_userId_key" ON "SearchGrabAttempt"("id", "userId");

-- arr-schema-atom index:71637aaaabeaf347890490ede5b0da318286eb66e50bae873be7c9d7c5553ff6
CREATE UNIQUE INDEX "SearchGrabAttempt_userId_intentId_key" ON "SearchGrabAttempt"("userId", "intentId");

-- arr-schema-atom index:62f024341de6cbc9a66fb8df48693dc40aeae3bf2b1b48b257d6cba8b202297f
CREATE INDEX "SearchGrabAttempt_userId_serviceInstanceId_targetHash_idx" ON "SearchGrabAttempt"("userId", "serviceInstanceId", "targetHash");

-- arr-schema-atom index:d326dc551fff61e5f71528d1c2d29815d87bdf9ef27313b13ef31c6d21a43010
CREATE INDEX "SearchGrabAttempt_userId_state_workerEpoch_idx" ON "SearchGrabAttempt"("userId", "state", "workerEpoch");

-- arr-schema-atom index:c16a401590757c1d6377ca34e70aba8c55e1d9a6c2abfe629d4aaeceb842edef
CREATE UNIQUE INDEX "SearchGrabClaim_attemptId_userId_key" ON "SearchGrabClaim"("attemptId", "userId");

-- arr-schema-atom index:ecdad5c977261024c42a8fb3fb1d1cd8c3ffe4b310bf7b5eef5a071d7fac923d
CREATE UNIQUE INDEX "ServiceInstance_id_userId_key" ON "ServiceInstance"("id", "userId");

-- arr-schema-atom index:77c5418601e6bcd2d7677c9ee41ed8a57a831d0a49f2fce5bd6c6645c2abb516
CREATE INDEX "ServiceInstance_service_enabled_identityStatus_idx" ON "ServiceInstance"("service", "enabled", "identityStatus");

-- arr-schema-atom index:f0273d9d57ae91d2db2adcbeb12bf0754c7a0059f2b34b2158bdb8c11b9f96e9
CREATE INDEX "ServiceInstance_service_idx" ON "ServiceInstance"("service");

-- arr-schema-atom index:d73c51306f80826f1453dbffdfb3c0dfdcfef84c7bc31e1add3bfb076ff4a1b7
CREATE INDEX "ServiceInstance_userId_idx" ON "ServiceInstance"("userId");

-- arr-schema-atom index:436d6942b8ae4d42dafb0d70c50676c48932c6ab1a6078702c95a80e1260604a
CREATE UNIQUE INDEX "ServiceTag_name_key" ON "ServiceTag"("name");

-- arr-schema-atom index:efe1272fb375deb8af63aba424476c222ab0c64aa8c0be7ef50e5bfb6ec874ef
CREATE UNIQUE INDEX "User_hashedQuiWebhookSecret_key" ON "User"("hashedQuiWebhookSecret");

-- arr-schema-atom index:baed54fa364c46ff30ce958cbdb9ec1d6795f7f19489f5a87d9f7be7561bba34
CREATE UNIQUE INDEX "User_hashedWebhookSecret_key" ON "User"("hashedWebhookSecret");

-- arr-schema-atom index:3cbcd2b77b5ed46bce576f9fccc42e57bb0b996b2cf3313a37b32a9ae2e10f12
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- arr-schema-atom index:f2ba984e958ffedd66e06b3b22d1105d72a63fded6aace1c8436a6f86aeb5e59
CREATE INDEX "arr_import_file_proofs_downloadKey_operationId_idx" ON "arr_import_file_proofs"("downloadKey", "operationId");

-- arr-schema-atom index:1db2a1fd588f93ba45ff48a3e6b290677ec010c4876ed18c15d2ef36354ae1ed
CREATE UNIQUE INDEX "arr_import_file_proofs_operationId_fileFingerprint_key" ON "arr_import_file_proofs"("operationId", "fileFingerprint");

-- arr-schema-atom index:a3346c7f9074c0e7ce126f74b9a3b485525c2b64caa187e8018702db94aa7da4
CREATE UNIQUE INDEX "arr_import_operations_legacyReceiptId_key" ON "arr_import_operations"("legacyReceiptId");

-- arr-schema-atom index:b870c0aa40126a9c5afcb1dbcb874455adabea815097f64c6d56ba46526a289e
CREATE INDEX "arr_import_operations_state_nextCheckAt_idx" ON "arr_import_operations"("state", "nextCheckAt");

-- arr-schema-atom index:21f6afa99e04dc731ebf6eda4e50db785da92ed7bd4b8289c221907663ecd287
CREATE UNIQUE INDEX "arr_import_operations_userId_idempotencyKey_key" ON "arr_import_operations"("userId", "idempotencyKey");

-- arr-schema-atom index:c67ac7e7b434f69867790e3ccc665cb2339839af8c4dc80600cf691767de681b
CREATE INDEX "arr_import_operations_userId_instanceId_state_idx" ON "arr_import_operations"("userId", "instanceId", "state");

-- arr-schema-atom index:83677ba4d83b1822b7da367a7057529aac647310a35fd6b69d102def5d6b00ac
CREATE INDEX "arr_import_source_claims_userId_activeOperationId_idx" ON "arr_import_source_claims"("userId", "activeOperationId");

-- arr-schema-atom index:f471a5891063374374e98542358094b1f2545a5ab4128115df6e6247a82334fd
CREATE UNIQUE INDEX "arr_import_source_claims_userId_downloadKey_key" ON "arr_import_source_claims"("userId", "downloadKey");

-- arr-schema-atom index:48cb2f902daed3d1e126d3e70e6b64d65713dd1bb166d385106286251fa224c9
CREATE INDEX "auto_tag_rules_userId_idx" ON "auto_tag_rules"("userId");

-- arr-schema-atom index:e9682fee459aca071944c5e8612642ca5b3e56396c6d135c3f2b3641aa5f754a
CREATE UNIQUE INDEX "cache_refresh_status_instanceId_cacheType_key" ON "cache_refresh_status"("instanceId", "cacheType");

-- arr-schema-atom index:ff15b1bc2c85011c26d1db71d3f3d0d371e0647a28c462137aa31a25429a1d80
CREATE INDEX "cache_refresh_status_instanceId_connectionGeneration_identityGeneration_idx" ON "cache_refresh_status"("instanceId", "connectionGeneration", "identityGeneration");

-- arr-schema-atom index:4af88bc5f52466bcf84b0516232a5c11633190891f49ee2bab40c403bd6ca9e7
CREATE INDEX "dashboard_statistics_snapshots_retryAt_idx" ON "dashboard_statistics_snapshots"("retryAt");

-- arr-schema-atom index:2a3c0d068d5e9e81d26e6f810fdb44e1e629dd29d1d031611ae5b35e4ef538d1
CREATE INDEX "episode_file_cache_infoHash_idx" ON "episode_file_cache"("infoHash");

-- arr-schema-atom index:7c5b22fcf2c6f8da46a33ddf5b9f801ab5082118c903e68d91a2665f43cdfc0c
CREATE INDEX "episode_file_cache_infoHashSource_idx" ON "episode_file_cache"("infoHashSource");

-- arr-schema-atom index:fc16ba7c280bfbbdbfd6c3e6b90e13036e0833751cb989e7e3456cc6551bc84f
CREATE INDEX "episode_file_cache_inodeBackfillRetryAfter_idx" ON "episode_file_cache"("inodeBackfillRetryAfter");

-- arr-schema-atom index:0ed1cdb83abc5f3573d4ac1aa5c0b7a120ff8e632b809a045a4c38df44985424
CREATE UNIQUE INDEX "episode_file_cache_instanceId_arrEpisodeFileId_key" ON "episode_file_cache"("instanceId", "arrEpisodeFileId");

-- arr-schema-atom index:0ae0721f1ca27cb99ca69c79cbd522d777cd02c42ee90a38f240cd876ea87566
CREATE INDEX "episode_file_cache_instanceId_arrSeriesId_idx" ON "episode_file_cache"("instanceId", "arrSeriesId");

-- arr-schema-atom index:7d30014fc94eff4183ce42e651ba46f0e031a599da86f9b0e22e2fd35a1daa82
CREATE UNIQUE INDEX "history_collection_leases_claimToken_key" ON "history_collection_leases"("claimToken");

-- arr-schema-atom index:7af6899ce93ad898cf5a5422deacb54e46566dba599d94910f9830a7c65f7edf
CREATE INDEX "history_observations_eventAt_id_idx" ON "history_observations"("eventAt", "id");

-- arr-schema-atom index:0fd41a66c7f50eb0f95313593bd863f68dd1628aba8f7005db456256d7c47164
CREATE INDEX "history_observations_instanceId_connectionGeneration_eventAt_id_idx" ON "history_observations"("instanceId", "connectionGeneration", "eventAt", "id");

-- arr-schema-atom index:2b827f1c0147cb3e2606cc9f00eb8911ba8d1787a804c48872074905c1b2d5ac
CREATE INDEX "history_observations_instanceId_connectionGeneration_firstObservedAt_id_idx" ON "history_observations"("instanceId", "connectionGeneration", "firstObservedAt", "id");

-- arr-schema-atom index:fe3f217f6df19f49203bed6179bfdb67b58ac8a392b0af2d832aee5267f40e8a
CREATE UNIQUE INDEX "history_observations_instanceId_connectionGeneration_providerEventId_key" ON "history_observations"("instanceId", "connectionGeneration", "providerEventId");

-- arr-schema-atom index:606b0b417ab3728366b67450f3fc7038ef0d4124d50b49e408ebe39b75615baf
CREATE UNIQUE INDEX "hunt_configs_instanceId_key" ON "hunt_configs"("instanceId");

-- arr-schema-atom index:758f9b6f946fa2c5810503aee03c980d04c635ed42d32c6149179f5344f45f3e
CREATE INDEX "hunt_configs_lastMissingHunt_idx" ON "hunt_configs"("lastMissingHunt");

-- arr-schema-atom index:f65b1e953aaabc6b13c241661161347656fcdb8ed0af8d47585b4ed7954b3851
CREATE INDEX "hunt_configs_lastUpgradeHunt_idx" ON "hunt_configs"("lastUpgradeHunt");

-- arr-schema-atom index:94e6f898d968794c0fc08a1b5c269fb457eb1e3138119187bb5def55afb651ad
CREATE INDEX "hunt_logs_instanceId_huntType_startedAt_idx" ON "hunt_logs"("instanceId", "huntType", "startedAt");

-- arr-schema-atom index:9fc38c50a02349a64c62d1a0f269db303f8598c36c1b59c66ff7bff1d8d832bd
CREATE INDEX "hunt_logs_startedAt_idx" ON "hunt_logs"("startedAt");

-- arr-schema-atom index:783b85dba9d5cdfa9721951e7dc23fbaf9a1c618824ce5f12b3ea8f31f9f5866
CREATE UNIQUE INDEX "hunt_search_history_configId_huntType_mediaType_mediaId_seasonNumber_key" ON "hunt_search_history"("configId", "huntType", "mediaType", "mediaId", "seasonNumber");

-- arr-schema-atom index:4a21a201759f11881a7af50e35c823cbd2e8f6145a76ef53bd699993deb6d5c9
CREATE INDEX "hunt_search_history_configId_huntType_searchedAt_idx" ON "hunt_search_history"("configId", "huntType", "searchedAt");

-- arr-schema-atom index:35d3c5e83c33dfd69a928099facdbfc0e72aec9b53dc58646816a7498b68fb71
CREATE INDEX "hunt_search_history_searchedAt_idx" ON "hunt_search_history"("searchedAt");

-- arr-schema-atom index:2e57d05a47fe35d8b228c5e16ed5af1e73d9c2790b4ca12d1f92b2cb6e0e98d7
CREATE UNIQUE INDEX "inode_index_cache_instanceId_key" ON "inode_index_cache"("instanceId");

-- arr-schema-atom index:74227ac40266655ca932e2955698066f05d37315aaa31341f304ee11a84e295e
CREATE INDEX "instance_quality_profile_overrides_instanceId_idx" ON "instance_quality_profile_overrides"("instanceId");

-- arr-schema-atom index:1acb15c1482f5d787d5b38458fb8fe637ace603fec18fee92c4ee9faefba3b73
CREATE UNIQUE INDEX "instance_quality_profile_overrides_instanceId_qualityProfileId_customFormatId_key" ON "instance_quality_profile_overrides"("instanceId", "qualityProfileId", "customFormatId");

-- arr-schema-atom index:009ec51e1178ef155cd31edf3294bf0aae97d2741ca7c35b3b8efef25964135a
CREATE INDEX "instance_quality_profile_overrides_instanceId_qualityProfileId_idx" ON "instance_quality_profile_overrides"("instanceId", "qualityProfileId");

-- arr-schema-atom index:14e0a3234a4954147f0d53374a98f0425f48a4b3bf5c1817eef76f975447218d
CREATE INDEX "jellyfin_cache_instanceId_connectionGeneration_identityGeneration_idx" ON "jellyfin_cache"("instanceId", "connectionGeneration", "identityGeneration");

-- arr-schema-atom index:5ab70735c6ee4ef51bf6425945212c8b2da2d77de36d398b04688597b6711e23
CREATE INDEX "jellyfin_cache_instanceId_idx" ON "jellyfin_cache"("instanceId");

-- arr-schema-atom index:dcfb1e94f873c327b34ef891253aa38755a3d708ea872e496a276abb774c75b3
CREATE UNIQUE INDEX "jellyfin_cache_instanceId_tmdbId_mediaType_libraryId_key" ON "jellyfin_cache"("instanceId", "tmdbId", "mediaType", "libraryId");

-- arr-schema-atom index:c4f6c6360d7fc3c1b9e07bbbf179b592b6f5331cf954b35729fc4862ecc53b57
CREATE INDEX "jellyfin_episode_cache_instanceId_connectionGeneration_identityGeneration_idx" ON "jellyfin_episode_cache"("instanceId", "connectionGeneration", "identityGeneration");

-- arr-schema-atom index:e32fae7cfe881b59809c9c097bae28a10bfb18f5c462a00fd282805bcb0fe456
CREATE INDEX "jellyfin_episode_cache_instanceId_idx" ON "jellyfin_episode_cache"("instanceId");

-- arr-schema-atom index:7d8c77e46b361393106519182a4726a9be954a7c0e27f0fce41ff33ad80d4460
CREATE UNIQUE INDEX "jellyfin_episode_cache_instanceId_showTmdbId_seasonNumber_episodeNumber_key" ON "jellyfin_episode_cache"("instanceId", "showTmdbId", "seasonNumber", "episodeNumber");

-- arr-schema-atom index:e26635ca37dc5a4ee3d8cde0b9c38167c8106a0f92fbfd345aacb9368b00aaec
CREATE INDEX "jellyfin_episode_generation_rows_instanceId_generationId_showTmdbId_idx" ON "jellyfin_episode_generation_rows"("instanceId", "generationId", "showTmdbId");

-- arr-schema-atom index:0f56feb773a6a10a2c5ba9bdb9f7d2b7e92d8afbde2201a9e6a378272c31ef59
CREATE UNIQUE INDEX "jellyfin_episode_generation_rows_instanceId_generationId_showTmdbId_seasonNumber_episodeNumber_key" ON "jellyfin_episode_generation_rows"("instanceId", "generationId", "showTmdbId", "seasonNumber", "episodeNumber");

-- arr-schema-atom index:3c8763393e944717653817e81f6a85c8af7c909e4e9db88fae8d285fc0361f43
CREATE INDEX "jellyfin_episode_generation_show_receipts_instanceId_generationId_idx" ON "jellyfin_episode_generation_show_receipts"("instanceId", "generationId");

-- arr-schema-atom index:7667478c41f819f7807bdedb1542819a8b6c480c2b784366fdad9dff5fa04b7c
CREATE UNIQUE INDEX "jellyfin_episode_generation_show_receipts_instanceId_generationId_showTmdbId_key" ON "jellyfin_episode_generation_show_receipts"("instanceId", "generationId", "showTmdbId");

-- arr-schema-atom index:47ba11e0cf898dd3451b97c9522a7d40c54fbbd4948ffe84e13aaa34b2422fe0
CREATE UNIQUE INDEX "jellyfin_episode_observation_exclusions_runId_pass_userKeyDigest_jellyfinId_key" ON "jellyfin_episode_observation_exclusions"("runId", "pass", "userKeyDigest", "jellyfinId");

-- arr-schema-atom index:6f106cdcb71a6d62e6f2ad7716ffc414889cabc6cc94b21ab39da7a08c76a9e6
CREATE INDEX "jellyfin_episode_observation_exclusions_runId_unitId_idx" ON "jellyfin_episode_observation_exclusions"("runId", "unitId");

-- arr-schema-atom index:1b08477f2d9fad054742968d826c2a92a2494fa6f0b6a1ec3274ab6e635020ac
CREATE UNIQUE INDEX "jellyfin_episode_observation_stage_runId_pass_userKeyDigest_jellyfinId_key" ON "jellyfin_episode_observation_stage"("runId", "pass", "userKeyDigest", "jellyfinId");

-- arr-schema-atom index:282d412e29be868bd5d488265c57e283571acd48e6d511977eeabbc6b2d07582
CREATE INDEX "jellyfin_episode_observation_stage_runId_seriesId_idx" ON "jellyfin_episode_observation_stage"("runId", "seriesId");

-- arr-schema-atom index:89d57a4052b6f680024a055811dd6613f340647f160d4e8c1ef77dbd9e3c6881
CREATE INDEX "jellyfin_episode_observation_stage_runId_unitId_idx" ON "jellyfin_episode_observation_stage"("runId", "unitId");

-- arr-schema-atom index:0c98f5c8aabd6b7e99e4d2d243fda346bd36d61e5403288cf1aed7ba3ae48352
CREATE UNIQUE INDEX "jellyfin_episode_preparations_instanceId_generationId_key" ON "jellyfin_episode_preparations"("instanceId", "generationId");

-- arr-schema-atom index:f0d9524e52fb53f6547d2bd03c21983696abaced2238d98ad4a8d1d84dc0aa3f
CREATE INDEX "jellyfin_episode_preparations_instanceId_state_leaseExpiresAt_idx" ON "jellyfin_episode_preparations"("instanceId", "state", "leaseExpiresAt");

-- arr-schema-atom index:ede1785391398089d180ee7cb76ed20d6b1331a21a4824af7fa251b725baed67
CREATE INDEX "jellyfin_native_watch_rows_instanceId_runId_jellyfinId_idx" ON "jellyfin_native_watch_rows"("instanceId", "runId", "jellyfinId");

-- arr-schema-atom index:04b42bc944ee41324e287e3885a999fb2b48bd2c8be8365c2971e60223a4eb71
CREATE UNIQUE INDEX "jellyfin_native_watch_rows_instanceId_runId_userKeyDigest_libraryId_jellyfinId_key" ON "jellyfin_native_watch_rows"("instanceId", "runId", "userKeyDigest", "libraryId", "jellyfinId");

-- arr-schema-atom index:9fa027a2db0745efed2d505be6844e921733509d63b32b19f9660d6ade0cf727
CREATE INDEX "jellyfin_native_watch_scope_receipts_instanceId_runId_idx" ON "jellyfin_native_watch_scope_receipts"("instanceId", "runId");

-- arr-schema-atom index:acb9ecbab8cfcc54e4c15948b75eb9f04f81728900d01c59501e0f9a1fa01ad3
CREATE UNIQUE INDEX "jellyfin_native_watch_scope_receipts_instanceId_runId_userKeyDigest_libraryId_key" ON "jellyfin_native_watch_scope_receipts"("instanceId", "runId", "userKeyDigest", "libraryId");

-- arr-schema-atom index:9fadb880a66d360bdc3f53669e528079aaea40ae2f64b6cf83908d2853399e46
CREATE INDEX "jellyfin_positive_watch_rows_instanceId_generationId_jellyfinId_idx" ON "jellyfin_positive_watch_rows"("instanceId", "generationId", "jellyfinId");

-- arr-schema-atom index:b135bf7d9238a285a674326aabc5c94c2437cdef52b72114ebb0e61d170d7e76
CREATE UNIQUE INDEX "jellyfin_positive_watch_rows_instanceId_generationId_userKeyDigest_libraryId_jellyfinId_key" ON "jellyfin_positive_watch_rows"("instanceId", "generationId", "userKeyDigest", "libraryId", "jellyfinId");

-- arr-schema-atom index:4dd1fc26ef0956e2cd92b4b3e8e2c94a97de6774cd1240a8598244e94e6d5497
CREATE UNIQUE INDEX "label_sync_mutation_attempts_activeOperationKey_key" ON "label_sync_mutation_attempts"("activeOperationKey");

-- arr-schema-atom index:3090e629e8e892a1ee914e8f93077e449846f06119c8a1a994ba60867a40f627
CREATE INDEX "label_sync_mutation_attempts_destinationInstanceId_status_idx" ON "label_sync_mutation_attempts"("destinationInstanceId", "status");

-- arr-schema-atom index:d10f76f80143ce701b8309f71bf54edfcbf8e1a5c8b1dd017e285c1fb6e324f7
CREATE INDEX "label_sync_mutation_attempts_ruleId_status_idx" ON "label_sync_mutation_attempts"("ruleId", "status");

-- arr-schema-atom index:a050cfbacae245470091761ccc0e94b3cc9e02638d88db3450508cca5d7d0334
CREATE INDEX "label_sync_mutation_attempts_userId_status_idx" ON "label_sync_mutation_attempts"("userId", "status");

-- arr-schema-atom index:c5078b212f0d25303df6ac47d3975243257dbe5a37466970000aa7a21aabd236
CREATE INDEX "label_sync_mutation_attempts_userId_updatedAt_idx" ON "label_sync_mutation_attempts"("userId", "updatedAt");

-- arr-schema-atom index:2d2136e2f155380258d1f3f3400363b84cf5eb84aeae03b09dcd1aee39fa8fcc
CREATE INDEX "label_sync_rules_userId_idx" ON "label_sync_rules"("userId");

-- arr-schema-atom index:6461ded303259adc2ed751942bc68cc10e4534863d6c5254eda0a1faa66f63f8
CREATE INDEX "library_cache_cutoffUnmet_idx" ON "library_cache"("cutoffUnmet");

-- arr-schema-atom index:71901aed1f4e307c3106da965eb084695e2bf2b178a1e4bd4a2dc94ecc5aa8bb
CREATE INDEX "library_cache_hasFile_idx" ON "library_cache"("hasFile");

-- arr-schema-atom index:0a4ae6b7215fc8830a018d97828157a47aa29fda094b1802a50f9e0257075a2e
CREATE UNIQUE INDEX "library_cache_instanceId_arrItemId_itemType_key" ON "library_cache"("instanceId", "arrItemId", "itemType");

-- arr-schema-atom index:7a60058701d9a71a412204b7af6be9ce4e23eb77ce4693d530f75256c6066f59
CREATE INDEX "library_cache_instanceId_episodeFileInventoryAttemptedAt_idx" ON "library_cache"("instanceId", "episodeFileInventoryAttemptedAt");

-- arr-schema-atom index:c481b8015580ae1a700ec9aad7e2efb5d8c163e6f465f144240ff3eb58fb779a
CREATE INDEX "library_cache_instanceId_idx" ON "library_cache"("instanceId");

-- arr-schema-atom index:3cc054f82b2ee125464d8ac9710badec106adb75c9254cb69feefcb857b43b8b
CREATE INDEX "library_cache_monitored_idx" ON "library_cache"("monitored");

-- arr-schema-atom index:1f3eafd858f7b8a9780dda8149331d94b80c25e6e94d0332d75607b1e453dea6
CREATE INDEX "library_cache_pathBackfillRetryAfter_idx" ON "library_cache"("pathBackfillRetryAfter");

-- arr-schema-atom index:86539b79f966c3be4ce6b82bd78a7e35dbae2569d6020eedd71b29401f9fe3d4
CREATE INDEX "library_cache_qualityProfileId_idx" ON "library_cache"("qualityProfileId");

-- arr-schema-atom index:dfa01ecf3910b3e5342e9f87978878afefe2ba10aa55fec7bcdc9fb4cf677d90
CREATE INDEX "library_cache_sizeOnDisk_idx" ON "library_cache"("sizeOnDisk");

-- arr-schema-atom index:809db80f28fe06ca576a1b706641f81c7b87d3b3d1eae238200cae62c9178206
CREATE INDEX "library_cache_sortTitle_idx" ON "library_cache"("sortTitle");

-- arr-schema-atom index:9dac4275f97062f76aab104c692b6d24239458e257a8f32711f05f85486d0a4a
CREATE INDEX "library_cache_status_idx" ON "library_cache"("status");

-- arr-schema-atom index:cfa21d260340885a49419e6db6414d85e2cad19ebd2f08d747667dd788e071f1
CREATE INDEX "library_cache_title_idx" ON "library_cache"("title");

-- arr-schema-atom index:07cb3c7bf543b630eb7e7836fc48646a558c4a023937d89b1ec1ae0d7302e6b0
CREATE INDEX "library_cache_torrentState_idx" ON "library_cache"("torrentState");

-- arr-schema-atom index:79718c0826ee785e95197959e37e30f179468dfd44236d5a1a60e4fbd7e2d76a
CREATE INDEX "library_cache_year_idx" ON "library_cache"("year");

-- arr-schema-atom index:333b505444e7b1c1e3b0333209ba190a8261bc8654e0037aabcc9b66891e710e
CREATE INDEX "library_cleanup_approvals_configId_status_idx" ON "library_cleanup_approvals"("configId", "status");

-- arr-schema-atom index:4715d0df8376a0bf4ef3b6186da702836e0475fe791954f279729ce29d921374
CREATE INDEX "library_cleanup_approvals_expiresAt_idx" ON "library_cleanup_approvals"("expiresAt");

-- arr-schema-atom index:5abead6421ae9f84b47a9b36bf3e36180475dd35da27efcb3bf1536c2365ab90
CREATE INDEX "library_cleanup_approvals_status_terminalAuditRecordedAt_terminalAuditRecoveryAttemptedAt_id_idx" ON "library_cleanup_approvals"("status", "terminalAuditRecordedAt", "terminalAuditRecoveryAttemptedAt", "id");

-- arr-schema-atom index:8f92eed045c9ce081e494ae1f4c1c08fe3e0da85cb2952fc175bf6550239b0cc
CREATE INDEX "library_cleanup_audit_events_approvalId_idx" ON "library_cleanup_audit_events"("approvalId");

-- arr-schema-atom index:1a751539b71677e61c0d39e7e04fe97b41b6fc645a8c804e4e871e2946506d07
CREATE INDEX "library_cleanup_audit_events_configId_actionId_sequence_idx" ON "library_cleanup_audit_events"("configId", "actionId", "sequence");

-- arr-schema-atom index:cd197683e4306ca20fc95e75aa6d3babe191dbebf727d5249e116aa52b9784c2
CREATE INDEX "library_cleanup_audit_events_configId_createdAt_idx" ON "library_cleanup_audit_events"("configId", "createdAt");

-- arr-schema-atom index:557f48edd8d83ab354ced2cc2dd9e450aad189580053fafbfad76ccd83cf3b5a
CREATE UNIQUE INDEX "library_cleanup_audit_events_eventKey_key" ON "library_cleanup_audit_events"("eventKey");

-- arr-schema-atom index:a7daa46e0e460391daf3c63fb32c16ff20d8e7ad5d3a1b724cab78bcfecf9a78
CREATE UNIQUE INDEX "library_cleanup_configs_userId_key" ON "library_cleanup_configs"("userId");

-- arr-schema-atom index:533da7bbea16001ec984ec97f74ef4854f36e32d6dc40975439ab39aab5de8d6
CREATE INDEX "library_cleanup_logs_configId_startedAt_idx" ON "library_cleanup_logs"("configId", "startedAt");

-- arr-schema-atom index:2d2387dce90c711f0bb4c3d53b49db9ea33508680fc98e310f1d1b370ba6555f
CREATE UNIQUE INDEX "library_cleanup_media_server_scan_leases_executionToken_key" ON "library_cleanup_media_server_scan_leases"("executionToken");

-- arr-schema-atom index:0bb8c6afe675aa02667774053686718aa0d39e9f6ee2b5e5ab58edc074e624c0
CREATE INDEX "library_cleanup_media_server_scan_leases_userId_updatedAt_idx" ON "library_cleanup_media_server_scan_leases"("userId", "updatedAt");

-- arr-schema-atom index:78c9ee2d32f9015606d00db90a39acf71387cb2d0f75339e0a41f2164d9213d5
CREATE INDEX "library_cleanup_media_server_scans_approvalId_status_idx" ON "library_cleanup_media_server_scans"("approvalId", "status");

-- arr-schema-atom index:841bf787dc728d54d042629bbd0c12e78a76c88ff0cf03007a5c204aacd197d9
CREATE UNIQUE INDEX "library_cleanup_media_server_scans_approvalId_targetKey_key" ON "library_cleanup_media_server_scans"("approvalId", "targetKey");

-- arr-schema-atom index:3975f5b547ed836a5a0b8505e786a1d7ef5761f79f572453dd09d2aeb7023fec
CREATE INDEX "library_cleanup_media_server_scans_status_nextAttemptAt_updatedAt_idx" ON "library_cleanup_media_server_scans"("status", "nextAttemptAt", "updatedAt");

-- arr-schema-atom index:d1f52453ae84f4804277c53e9333ad583a496e8733043ebb168354bae33ae60a
CREATE INDEX "library_cleanup_rules_configId_idx" ON "library_cleanup_rules"("configId");

-- arr-schema-atom index:4ef3be56e6c2d2f123a2d4a9592fba3c741da043aa91ff24fead41ce95287dee
CREATE UNIQUE INDEX "library_sync_status_instanceId_key" ON "library_sync_status"("instanceId");

-- arr-schema-atom index:7c92845547e577f05519fdb90f7718b7e7c95fb76042ad9043b4e8dbdb83a3de
CREATE INDEX "library_sync_status_lastFullSync_idx" ON "library_sync_status"("lastFullSync");

-- arr-schema-atom index:b59e8312357e2741c170f8093391e7a67faccc2dee4f095173c5f75d35f330d2
CREATE INDEX "library_sync_status_pollingEnabled_idx" ON "library_sync_status"("pollingEnabled");

-- arr-schema-atom index:a0dc6ebec0acc1ea2cbf1db0a20f77213e046fdd3797212823dc3347cf80a723
CREATE INDEX "list_cache_refresh_status_userId_provider_idx" ON "list_cache_refresh_status"("userId", "provider");

-- arr-schema-atom index:71899fc837ba2969bfb515aacd0befbd7571e13185f07e32b43a313f0e41ddff
CREATE UNIQUE INDEX "list_cache_refresh_status_userId_provider_listKey_key" ON "list_cache_refresh_status"("userId", "provider", "listKey");

-- arr-schema-atom index:88cf2e09e14c3524588ccf291e089d616d18b8b977002f5c11d01bacd226cd2a
CREATE UNIQUE INDEX "naming_configs_instanceId_key" ON "naming_configs"("instanceId");

-- arr-schema-atom index:89f5359333e772d8099fa20f3c1471fc886785be488f4a26657afa293870ffe1
CREATE INDEX "naming_configs_userId_idx" ON "naming_configs"("userId");

-- arr-schema-atom index:628a1afbd338b2fd5774100dfa710c5022ebf37531559f28f700f4ce7e34701e
CREATE INDEX "naming_deploy_history_instanceId_deployedAt_idx" ON "naming_deploy_history"("instanceId", "deployedAt");

-- arr-schema-atom index:bed34ad07633a867780ce99bf21535e49b621a73542c832887e5bc51a6051182
CREATE INDEX "naming_deploy_history_userId_idx" ON "naming_deploy_history"("userId");

-- arr-schema-atom index:7db2789635338fa524137fb1ad92a78c8439d1a612ecafbbcf32eac80f08f559
CREATE UNIQUE INDEX "notification_aggregation_configs_userId_eventType_key" ON "notification_aggregation_configs"("userId", "eventType");

-- arr-schema-atom index:c96fa075d2dd36e981bdf6adee91a433422b97cfa2be4b720b28300cc1de9902
CREATE INDEX "notification_channels_userId_idx" ON "notification_channels"("userId");

-- arr-schema-atom index:ec89db4880ebabf73b0211d3825bed9f7f422968a3056a2192314cc3d1812138
CREATE INDEX "notification_logs_channelId_eventType_status_sentAt_idx" ON "notification_logs"("channelId", "eventType", "status", "sentAt");

-- arr-schema-atom index:7d7b179661995855ed4a53a6c12e98dc579706de70f8e5885a77445054e0972f
CREATE INDEX "notification_logs_channelId_idx" ON "notification_logs"("channelId");

-- arr-schema-atom index:4a97da061f3a84219a93539093c41ef44f7048ca4102936ab34902e7ace4aa92
CREATE INDEX "notification_logs_eventType_idx" ON "notification_logs"("eventType");

-- arr-schema-atom index:d70f76087c8423f2b0d846a34943cf5fdc06005a08abda6de72accd42e2a29c6
CREATE INDEX "notification_logs_sentAt_idx" ON "notification_logs"("sentAt");

-- arr-schema-atom index:6430c33863232582d04d49d5deab91fb382ced8edc4bf7aae8a2f72a9088fcf8
CREATE INDEX "notification_rules_userId_idx" ON "notification_rules"("userId");

-- arr-schema-atom index:6989851d59500cefc451f1be66f711eb6751f07fb036eabe57faa28ded2ff920
CREATE UNIQUE INDEX "notification_subscriptions_channelId_eventType_key" ON "notification_subscriptions"("channelId", "eventType");

-- arr-schema-atom index:b07d033a560b7746ac2f2e074502d55b45c11ea3535b23e9519e66a9a64cdc48
CREATE UNIQUE INDEX "oidc_accounts_providerUserId_key" ON "oidc_accounts"("providerUserId");

-- arr-schema-atom index:c23286ba60140577b972f5f08631927414b1e80ae49f2bedddf4f63942bc1b13
CREATE INDEX "oidc_accounts_userId_idx" ON "oidc_accounts"("userId");

-- arr-schema-atom index:9f2fe3f67abd61618c1e8785f0e862b0163ed68b9fc9cffa3d982274db67ce9f
CREATE INDEX "plex_cache_instanceId_connectionGeneration_identityGeneration_idx" ON "plex_cache"("instanceId", "connectionGeneration", "identityGeneration");

-- arr-schema-atom index:a20858cb9526ea7d9432df1d87a6cb510a041d8107a2b16c5ab3919cca204985
CREATE INDEX "plex_cache_instanceId_idx" ON "plex_cache"("instanceId");

-- arr-schema-atom index:e48c4547f2b0f6c943e78b52b3785c1cbd5de3589f4060d5aa098bdd56749740
CREATE UNIQUE INDEX "plex_cache_instanceId_tmdbId_mediaType_sectionId_key" ON "plex_cache"("instanceId", "tmdbId", "mediaType", "sectionId");

-- arr-schema-atom index:73d09cf9ee95f0ac6fc5db0a5b8c9f8db3a8fe95a0d8055029f19c7b2eddb591
CREATE INDEX "plex_episode_cache_instanceId_connectionGeneration_identityGeneration_idx" ON "plex_episode_cache"("instanceId", "connectionGeneration", "identityGeneration");

-- arr-schema-atom index:e5aac8dd98907de5ca496701326620a9ab8b0887dc3182fec6c49dc4a79a4f0c
CREATE INDEX "plex_episode_cache_instanceId_idx" ON "plex_episode_cache"("instanceId");

-- arr-schema-atom index:5e7a15e7089d4b48677b634b3e603d462afbb4ffed115a12feefb8bcbcab655c
CREATE UNIQUE INDEX "plex_episode_cache_instanceId_showTmdbId_seasonNumber_episodeNumber_key" ON "plex_episode_cache"("instanceId", "showTmdbId", "seasonNumber", "episodeNumber");

-- arr-schema-atom index:35f4fa4575573faef5039131f10465ce6afb4ff278b69a7bc7ac4ea07997e307
CREATE UNIQUE INDEX "plex_episode_observation_stage_runId_parentRatingKey_seasonNumber_episodeNumber_key" ON "plex_episode_observation_stage"("runId", "parentRatingKey", "seasonNumber", "episodeNumber");

-- arr-schema-atom index:573c32398ab0448190f3bdce37803f60fe083944e656a79eb31e2e1d63d58779
CREATE INDEX "plex_episode_observation_stage_runId_unitId_idx" ON "plex_episode_observation_stage"("runId", "unitId");

-- arr-schema-atom index:14c1d66f2bed1be24143cca1f95cce4540d9ec1a14fc0bf28d31b80fb8c5d6c1
CREATE INDEX "plex_generation_targets_instanceId_generationId_idx" ON "plex_generation_targets"("instanceId", "generationId");

-- arr-schema-atom index:7d6e485fa282210c5840d1aaca5d4458f31dd34cad3eb971ab37741aa37a926a
CREATE INDEX "plex_generation_targets_instanceId_generationId_mediaType_tmdbId_idx" ON "plex_generation_targets"("instanceId", "generationId", "mediaType", "tmdbId");

-- arr-schema-atom index:4543cd955a77964a517cedc043b0c0082fecce9aa402bbe4cdc95523c8fabab2
CREATE UNIQUE INDEX "plex_generation_targets_instanceId_generationId_ratingKey_key" ON "plex_generation_targets"("instanceId", "generationId", "ratingKey");

-- arr-schema-atom index:76b447afddbb6a7fabdf8882d92a030b2b3d50d663fb65679ff9147cdd8f519b
CREATE INDEX "provider_native_inventory_items_snapshotId_mediaType_idx" ON "provider_native_inventory_items"("snapshotId", "mediaType");

-- arr-schema-atom index:ec84ae1a43010a3f256a6c90f8c28d1f15c704b2f31cb3b0ec561b9dcc8fa19f
CREATE UNIQUE INDEX "provider_native_inventory_items_snapshotId_nativeId_key" ON "provider_native_inventory_items"("snapshotId", "nativeId");

-- arr-schema-atom index:b71be9e8b322959c1b00e7f5800c76cafbe1d816100f518633d717b2dd9ac7d9
CREATE UNIQUE INDEX "provider_native_inventory_page_receipts_passId_domain_scopeKey_pageKey_key" ON "provider_native_inventory_page_receipts"("passId", "domain", "scopeKey", "pageKey");

-- arr-schema-atom index:f95481a734938ef8b0a5dba8cddb6cb125ac552941cb554703c34f5d790179a7
CREATE INDEX "provider_native_inventory_page_receipts_passId_domain_scopeKey_startIndex_idx" ON "provider_native_inventory_page_receipts"("passId", "domain", "scopeKey", "startIndex");

-- arr-schema-atom index:6f009b988bd37f8c741bb47f9384ee43656acce8a18af2691557cc0a282ce4ab
CREATE UNIQUE INDEX "provider_native_inventory_passes_runId_ordinal_key" ON "provider_native_inventory_passes"("runId", "ordinal");

-- arr-schema-atom index:631740171f28339f36b81becf7ed952d4c9f13e43533253e030d9d77d568026d
CREATE UNIQUE INDEX "provider_native_inventory_runs_activeSlotKey_key" ON "provider_native_inventory_runs"("activeSlotKey");

-- arr-schema-atom index:6fd2e3611ca9776493b10e91b9445acb759ae4e9398af7efcb16c222ea6f878d
CREATE INDEX "provider_native_inventory_runs_instanceId_workKey_createdAt_idx" ON "provider_native_inventory_runs"("instanceId", "workKey", "createdAt");

-- arr-schema-atom index:27001384abe3ef0cdd46e55a3659dc0b2a3961e78ec3c0fa803aea3b68b8ebf0
CREATE INDEX "provider_native_inventory_runs_instanceId_workKey_state_idx" ON "provider_native_inventory_runs"("instanceId", "workKey", "state");

-- arr-schema-atom index:6da419c237e49e60544eaa015eaacd03493a8d58921c3d87c510bd59a464abb2
CREATE UNIQUE INDEX "provider_native_inventory_seen_items_passId_domain_scopeKey_nativeId_key" ON "provider_native_inventory_seen_items"("passId", "domain", "scopeKey", "nativeId");

-- arr-schema-atom index:f866573aff49efbd8c930c29b5f8ab67154d0d8d4b781821dafc2224c1652fa2
CREATE INDEX "provider_native_inventory_seen_items_passId_nativeId_idx" ON "provider_native_inventory_seen_items"("passId", "nativeId");

-- arr-schema-atom index:b5080c108c7331569dc8c5a7d9e93420e0f6546bd686b85742ecfc04ebb19112
CREATE INDEX "provider_native_inventory_snapshots_instanceId_domain_generationId_idx" ON "provider_native_inventory_snapshots"("instanceId", "domain", "generationId");

-- arr-schema-atom index:10350663c700d5d65aa452279264baa6fc8dbe38f6dd591db284fde1eb31f6f5
CREATE UNIQUE INDEX "provider_native_inventory_snapshots_instanceId_domain_key" ON "provider_native_inventory_snapshots"("instanceId", "domain");

-- arr-schema-atom index:8b0f03bcec364f153e62a31ca71ae47bf1796cc37c5e62dcdf1493228aaa0ff0
CREATE INDEX "provider_native_inventory_stage_items_passId_domain_idx" ON "provider_native_inventory_stage_items"("passId", "domain");

-- arr-schema-atom index:391a2ca252cb6f205dfa872f0c0b70d92caa96ae313bcb435ae5aec9b815aec2
CREATE UNIQUE INDEX "provider_native_inventory_stage_items_passId_domain_nativeId_key" ON "provider_native_inventory_stage_items"("passId", "domain", "nativeId");

-- arr-schema-atom index:a499fb6e82069f26d305517825ecd3c37dd854d3db07bf0232d8ec319b16eed3
CREATE UNIQUE INDEX "provider_observation_runs_activeSlotKey_key" ON "provider_observation_runs"("activeSlotKey");

-- arr-schema-atom index:f13f7f9cb03cb272c4b8dee05a6783eb74a46fac49f16eee99a04d6c3f0bc102
CREATE INDEX "provider_observation_runs_authorityKey_createdAt_idx" ON "provider_observation_runs"("authorityKey", "createdAt");

-- arr-schema-atom index:4e52ba236688f9d74465e4c6d8ddb19477f378a56a9502df2c6d32144b12893e
CREATE INDEX "provider_observation_runs_instanceId_cacheType_state_nextAttemptAt_idx" ON "provider_observation_runs"("instanceId", "cacheType", "state", "nextAttemptAt");

-- arr-schema-atom index:42e5f9f10a53f84f7b796880f5c6c0af64277003e0ebe4e2e3f0f53805b7d1d9
CREATE UNIQUE INDEX "provider_observation_units_runId_id_key" ON "provider_observation_units"("runId", "id");

-- arr-schema-atom index:a556424ac28cc98f963811c73fe92e2b7b6b8984bd477a8d00b32e470ef7d852
CREATE UNIQUE INDEX "provider_observation_units_runId_ordinal_key" ON "provider_observation_units"("runId", "ordinal");

-- arr-schema-atom index:3e1bd6a1291c77fbf8548db5b5765c44cf40f69129330309ec276cd7ff30cf9a
CREATE UNIQUE INDEX "provider_observation_units_runId_scopeKey_key" ON "provider_observation_units"("runId", "scopeKey");

-- arr-schema-atom index:6e2229bf3a7c44b6917b756d209321c73d08809e6dfc06763baef222f4ee6b2c
CREATE INDEX "provider_observation_units_runId_state_nextAttemptAt_ordinal_idx" ON "provider_observation_units"("runId", "state", "nextAttemptAt", "ordinal");

-- arr-schema-atom index:04de20d2f63234d7d87660b5ac79000d72b00b51ba8355f05e9fcff9cbe84084
CREATE UNIQUE INDEX "quality_size_mappings_instanceId_key" ON "quality_size_mappings"("instanceId");

-- arr-schema-atom index:d44d54970caa20a202942b5b8b7ca566f1a1ef01b6621a10633a55fc5274fd1f
CREATE INDEX "quality_size_mappings_syncStrategy_idx" ON "quality_size_mappings"("syncStrategy");

-- arr-schema-atom index:c53736acbf5f0a8173cdbee12898d5b4d86e5aafe5b0347b64c7a03e5b5ba5a3
CREATE INDEX "quality_size_mappings_userId_idx" ON "quality_size_mappings"("userId");

-- arr-schema-atom index:38289f10e12eb8ba83260a0517aeef12f06542f707275d8874124efe1313f19d
CREATE UNIQUE INDEX "queue_cleaner_configs_instanceId_key" ON "queue_cleaner_configs"("instanceId");

-- arr-schema-atom index:e0d34e611b281a3193522499b5923d6f76486579433e06b65d8b5931d126ecc0
CREATE INDEX "queue_cleaner_configs_lastRunAt_idx" ON "queue_cleaner_configs"("lastRunAt");

-- arr-schema-atom index:4bbed5d07c8b1c83568744c33defa1db148ad7592e13831e538386f8d2272631
CREATE UNIQUE INDEX "queue_cleaner_import_receipts_instanceId_downloadKey_key" ON "queue_cleaner_import_receipts"("instanceId", "downloadKey");

-- arr-schema-atom index:64adb876caf0994e47b48df56db8290ae76a06b729f1f2cfff27919d46b41480
CREATE INDEX "queue_cleaner_import_receipts_instanceId_state_idx" ON "queue_cleaner_import_receipts"("instanceId", "state");

-- arr-schema-atom index:dad6a27146da267ab45ac9a8801e938055ffee2f0e1b895d415a8c1ff71b0504
CREATE INDEX "queue_cleaner_logs_instanceId_startedAt_idx" ON "queue_cleaner_logs"("instanceId", "startedAt");

-- arr-schema-atom index:2123d6e42bbca7841a4d77df0054bd01a7a9bce5402b17cfa40ddcab4f1f8137
CREATE INDEX "queue_cleaner_logs_startedAt_idx" ON "queue_cleaner_logs"("startedAt");

-- arr-schema-atom index:6dba16fb4179b713297bc7c227354a579db1a1828ab7f46a5ffa30e028f3c699
CREATE UNIQUE INDEX "queue_cleaner_strikes_instanceId_downloadId_key" ON "queue_cleaner_strikes"("instanceId", "downloadId");

-- arr-schema-atom index:d8311939c9e36d3faa1f0dbd1e4e427bfb450ad3272fdf13fc39ce32c2134176
CREATE INDEX "queue_cleaner_strikes_instanceId_lastStrikeAt_idx" ON "queue_cleaner_strikes"("instanceId", "lastStrikeAt");

-- arr-schema-atom index:fb9f1e411eab8818fa91682226e253c657627991449351f8755ebc45cd03fc92
CREATE INDEX "qui_action_claims_attemptId_idx" ON "qui_action_claims"("attemptId");

-- arr-schema-atom index:e48b34a25bd8b533a10e209a80f094aecebf850953364f1ad570ea9f8f6b4046
CREATE UNIQUE INDEX "qui_action_claims_torrentHash_key" ON "qui_action_claims"("torrentHash");

-- arr-schema-atom index:cce98b05503c224532b31ea2465c655ad9b42695efe3ce4ec0c75c91c238aa46
CREATE INDEX "qui_action_logs_attemptId_idx" ON "qui_action_logs"("attemptId");

-- arr-schema-atom index:13e060f30070235ab4b84c2abbf7705a8208f0e80e849879d58003512c85d731
CREATE INDEX "qui_action_logs_serviceInstanceId_torrentHash_idx" ON "qui_action_logs"("serviceInstanceId", "torrentHash");

-- arr-schema-atom index:35495f25c668f2dbc986e75d7171ca0b7f9874eb85bb49f8331c575d2710fc4e
CREATE INDEX "qui_action_logs_userId_requestedAt_idx" ON "qui_action_logs"("userId", "requestedAt");

-- arr-schema-atom index:ff566227e45f40078b24c5192cc8ff912c9cea02bc9f181b18a969b755831c83
CREATE INDEX "qui_activity_logs_eventType_createdAt_idx" ON "qui_activity_logs"("eventType", "createdAt");

-- arr-schema-atom index:bcf61b6e030eb26b19f1fec0bb66c14f8292d36703d4fb99284f13d6f40b9cba
CREATE INDEX "qui_activity_logs_userId_createdAt_idx" ON "qui_activity_logs"("userId", "createdAt");

-- arr-schema-atom index:c5c4f7b8076e278cab5672b903013217ba0bad45c0cc92febf95d3845e4de4e4
CREATE INDEX "qui_event_logs_serviceInstanceId_eventType_idx" ON "qui_event_logs"("serviceInstanceId", "eventType");

-- arr-schema-atom index:0dd6889ea42eb1fe385e64169650865f6bab3db280a4eb657c1cecf68c3b3bd0
CREATE INDEX "qui_event_logs_userId_receivedAt_idx" ON "qui_event_logs"("userId", "receivedAt");

-- arr-schema-atom index:fad3e245883c0a773c815e2bd4572108a8f0c80e6afda54e11ea97d5524eda5e
CREATE INDEX "seerr_action_logs_createdAt_idx" ON "seerr_action_logs"("createdAt");

-- arr-schema-atom index:e46e080a16eb02fc3adb47743a2dff973597e41c7c3328b62827451766ba10af
CREATE INDEX "seerr_action_logs_instanceId_createdAt_idx" ON "seerr_action_logs"("instanceId", "createdAt");

-- arr-schema-atom index:6830fb837c42e9da54eedcc58dfd813766f7f0d894e453d7350385edfe217270
CREATE INDEX "seerr_action_logs_userId_createdAt_idx" ON "seerr_action_logs"("userId", "createdAt");

-- arr-schema-atom index:e20960c5c328ef95a3c6dbf50e2ecef0167d2ea3542d55997c4209fff669b754
CREATE INDEX "session_snapshots_capturedAt_idx" ON "session_snapshots"("capturedAt");

-- arr-schema-atom index:d9c0cec40f664a7146e09c46b81536a7e98bc8eb84dd04f8a246d658b0f075da
CREATE INDEX "session_snapshots_instanceId_capturedAt_idx" ON "session_snapshots"("instanceId", "capturedAt");

-- arr-schema-atom index:d846d75ac688adf3b16c5dbe91a1068c73f05a872197d77ec80fc973cdb8994b
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- arr-schema-atom index:a2dc3f828b13679d5272fa26bf7145b680d4573274cef8c899b6d709665aa911
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- arr-schema-atom index:5df203228821eaae518097e233a0a761896d8854041bc3fd38bdae1efc3f6b79
CREATE INDEX "standalone_cf_deployments_commitHash_idx" ON "standalone_cf_deployments"("commitHash");

-- arr-schema-atom index:5852e7552f8a52b3161dd9c4da7ad0e36ae170a502ea77acd7564e285090a431
CREATE UNIQUE INDEX "standalone_cf_deployments_instanceId_cfTrashId_key" ON "standalone_cf_deployments"("instanceId", "cfTrashId");

-- arr-schema-atom index:4e62d9404b0b28f4356da85dcf2ef4da023df24d837b4083be01e3aa88922686
CREATE INDEX "standalone_cf_deployments_instanceId_idx" ON "standalone_cf_deployments"("instanceId");

-- arr-schema-atom index:2cacebe7d58567b1ef2037749f741563b449d448b0854f754f34caaea2eea444
CREATE INDEX "standalone_cf_deployments_userId_idx" ON "standalone_cf_deployments"("userId");

-- arr-schema-atom index:1cf656dc079c2c58716dddffc11609e5b8b9907927fc2c6f03893d0b3778a4df
CREATE INDEX "tautulli_cache_instanceId_connectionGeneration_identityGeneration_idx" ON "tautulli_cache"("instanceId", "connectionGeneration", "identityGeneration");

-- arr-schema-atom index:f92f75e110b1d149c8f469fcb838c3a02950f517fbfe83f75d159bddfc29b39e
CREATE INDEX "tautulli_cache_instanceId_idx" ON "tautulli_cache"("instanceId");

-- arr-schema-atom index:30e624106ff3b25bc37dfb558eece808c2c27f36a5b3caf7ea6ee21ca0278a68
CREATE UNIQUE INDEX "tautulli_cache_instanceId_tmdbId_mediaType_key" ON "tautulli_cache"("instanceId", "tmdbId", "mediaType");

-- arr-schema-atom index:daabf406f03dfbb8643d60dac29ee998ac0c925f0215134b9991f2c1d5947d53
CREATE INDEX "template_deployment_history_deployedAt_idx" ON "template_deployment_history"("deployedAt");

-- arr-schema-atom index:1f0384e9c2f802503e2a2e691e42ea61cae6f56067da5251d4948ed7482b66ae
CREATE INDEX "template_deployment_history_instanceId_idx" ON "template_deployment_history"("instanceId");

-- arr-schema-atom index:77d74607fc35e1d440c5229f22242442e803b1e4f37e47dfff86ac398f653706
CREATE INDEX "template_deployment_history_status_idx" ON "template_deployment_history"("status");

-- arr-schema-atom index:ed6c219295a38a6d42ee3e15f189affe7686da255b7ba0fdd1db44109609c223
CREATE INDEX "template_deployment_history_templateId_idx" ON "template_deployment_history"("templateId");

-- arr-schema-atom index:3b4193db1a11d9f6706f1bac581d9d051520420b071e300ae14f0acb59b621c6
CREATE INDEX "template_deployment_history_userId_idx" ON "template_deployment_history"("userId");

-- arr-schema-atom index:b8539b66e82168aecf95b212317a29a2103314c4db18b0921d182a752725be0e
CREATE INDEX "template_quality_profile_mappings_instanceId_idx" ON "template_quality_profile_mappings"("instanceId");

-- arr-schema-atom index:6a1a035ce8c69171c052686d4e2a8a012c207617788fc816366d5b6f6626521c
CREATE UNIQUE INDEX "template_quality_profile_mappings_instanceId_qualityProfileId_key" ON "template_quality_profile_mappings"("instanceId", "qualityProfileId");

-- arr-schema-atom index:2ee975bf1da6faf9264325de1a6fbaaf4b541302e2a4dd51068269846c6d98be
CREATE INDEX "template_quality_profile_mappings_templateId_idx" ON "template_quality_profile_mappings"("templateId");

-- arr-schema-atom index:80736f544684a8a44b06b0c3a6da7ccdcdbc372adc2c58db1b0ef5876fe69c1c
CREATE INDEX "template_quality_profile_mappings_templateId_instanceId_idx" ON "template_quality_profile_mappings"("templateId", "instanceId");

-- arr-schema-atom index:1757b88e3b2ee58f138f42f3972f9eb099eb1a02d8c4b1f1f73eca9fd87e7494
CREATE INDEX "tmdb_list_cache_userId_listId_generation_idx" ON "tmdb_list_cache"("userId", "listId", "generation");

-- arr-schema-atom index:7b8b2187090743e21a655ff484efd43ceffc479909837d556847fc8f7bb1f707
CREATE INDEX "tmdb_list_cache_userId_listId_idx" ON "tmdb_list_cache"("userId", "listId");

-- arr-schema-atom index:f4f37d67686e36b7f557e4f680e63f0bb9f0887701a5b94535c7e87f41cad164
CREATE UNIQUE INDEX "tmdb_list_cache_userId_listId_mediaType_tmdbId_key" ON "tmdb_list_cache"("userId", "listId", "mediaType", "tmdbId");

-- arr-schema-atom index:158eb7dfdd4368c864fbf2af96d5d4e8cd3e6dcb599846d17ed2a6b1e5f45200
CREATE INDEX "trakt_list_cache_userId_listSlug_generation_idx" ON "trakt_list_cache"("userId", "listSlug", "generation");

-- arr-schema-atom index:039dbbf87e84d68c88afbc581b16418e43e79bb64897df9f75cb03803f14b3f1
CREATE INDEX "trakt_list_cache_userId_listSlug_idx" ON "trakt_list_cache"("userId", "listSlug");

-- arr-schema-atom index:cb337cb766a4229eee375292da440d6b0684b5d5f77a28359c844749ec00816c
CREATE UNIQUE INDEX "trakt_list_cache_userId_listSlug_mediaType_tmdbId_key" ON "trakt_list_cache"("userId", "listSlug", "mediaType", "tmdbId");

-- arr-schema-atom index:b9a549f26152aa303046eed8e3c1d496f9d00eaf7ede7b2261b280e1fc684e03
CREATE INDEX "trash_backups_createdAt_idx" ON "trash_backups"("createdAt");

-- arr-schema-atom index:f90c16fa04f5b83b54b5109f152a6533c89487e7f0201cb968a0ed5e3675abb8
CREATE INDEX "trash_backups_expiresAt_idx" ON "trash_backups"("expiresAt");

-- arr-schema-atom index:f8f87e7762ae10748edf854083ea05fdad52982110b3ce1c65a123ebd36736ac
CREATE INDEX "trash_backups_instanceId_idx" ON "trash_backups"("instanceId");

-- arr-schema-atom index:678e764be81916616ceb2130323189ef8619a8892a373945b0b70b7686ad3f5e
CREATE INDEX "trash_cache_commitHash_idx" ON "trash_cache"("commitHash");

-- arr-schema-atom index:594cd4bb2c391104a0e368132b228b41eb6689d554783636c7437eb682b67718
CREATE INDEX "trash_cache_serviceType_configType_idx" ON "trash_cache"("serviceType", "configType");

-- arr-schema-atom index:3feb7c39d95183afc7994adfbbaab5833f5700b7eed1b894817677904e148795
CREATE UNIQUE INDEX "trash_cache_serviceType_configType_key" ON "trash_cache"("serviceType", "configType");

-- arr-schema-atom index:0dc2d764e530613ccb96406749a7f3906de64ec9dfabfcb0b06c7a4b85556b7e
CREATE UNIQUE INDEX "trash_settings_userId_key" ON "trash_settings"("userId");

-- arr-schema-atom index:e84763bb24a6d86665a857f0d51e8b14c949bccd7f918e405f67c54ee89554c2
CREATE INDEX "trash_sync_history_instanceId_idx" ON "trash_sync_history"("instanceId");

-- arr-schema-atom index:6ba63bf0e4898b284535d0139a22b77aff1e4451d2909aea38d184675affd9bc
CREATE INDEX "trash_sync_history_startedAt_idx" ON "trash_sync_history"("startedAt");

-- arr-schema-atom index:16624293c1c09ca66d3d14e53ebe9f2defd1b27652e2430ff85e7b1ecaed9f91
CREATE INDEX "trash_sync_history_templateId_idx" ON "trash_sync_history"("templateId");

-- arr-schema-atom index:f749daf6798ff3504513419dbe96811f331aff9ad92fca7514d319bbeeda1fb4
CREATE INDEX "trash_sync_history_userId_idx" ON "trash_sync_history"("userId");

-- arr-schema-atom index:f75eed947bfa36798efef0b7a84a71f46bca1b873bb49169d584566db35405cb
CREATE INDEX "trash_sync_schedules_instanceId_idx" ON "trash_sync_schedules"("instanceId");

-- arr-schema-atom index:de5dde4bcdd742fbbb0bcceccde00ba8d5b550f4420802f6946ab10f0765dd41
CREATE INDEX "trash_sync_schedules_nextRunAt_idx" ON "trash_sync_schedules"("nextRunAt");

-- arr-schema-atom index:a30547e81156a01438a9a47fab182aaec4697866a9a876369d332754021ba5cf
CREATE INDEX "trash_sync_schedules_templateId_idx" ON "trash_sync_schedules"("templateId");

-- arr-schema-atom index:9a423c8b991b3b39775998539012cdd4e4de4d05c1ab4aeaa432d19862b5965d
CREATE INDEX "trash_templates_deletedAt_idx" ON "trash_templates"("deletedAt");

-- arr-schema-atom index:e4290e1db5c25cd0dfb4e3bee15e54e66f70ed47370f7078792e7dd338d0c23c
CREATE INDEX "trash_templates_lastSyncedAt_idx" ON "trash_templates"("lastSyncedAt");

-- arr-schema-atom index:9f0078a12c507a606bbb2855fb05a475131b4d9b60bd6042c9e1305a4d36787e
CREATE INDEX "trash_templates_serviceType_idx" ON "trash_templates"("serviceType");

-- arr-schema-atom index:c34713c62b34eb3be49a6c473a8944a98752d5d467df16b669b844e661a97989
CREATE INDEX "trash_templates_trashGuidesCommitHash_idx" ON "trash_templates"("trashGuidesCommitHash");

-- arr-schema-atom index:9f9d77dd1837598d15bb57cac29413db93243b3475c40b3773b6a091c501febb
CREATE INDEX "trash_templates_userId_idx" ON "trash_templates"("userId");

-- arr-schema-atom index:e2d977d7ffa67bbd56a3747793c266f2f42ebb56a3f65e938efa8c05e3c30883
CREATE UNIQUE INDEX "user_custom_formats_userId_name_serviceType_key" ON "user_custom_formats"("userId", "name", "serviceType");

-- arr-schema-atom index:466ed1fb303b3abf1752fd64035669fad3d3fc63a48d5c0076e1c1c276eb9900
CREATE INDEX "user_custom_formats_userId_serviceType_idx" ON "user_custom_formats"("userId", "serviceType");

-- arr-schema-atom index:0b6c816a8568fe85321fc8c576d60c10a88379537a425add118303ba11a0fb9e
CREATE INDEX "webauthn_credentials_userId_idx" ON "webauthn_credentials"("userId");

-- arr-schema-atom predecessor-index:815263676c34cd71927a6e38f9440c694b4b3d93fc356b419602b7ac13d0188b
DROP INDEX "tmdb_list_cache_userId_listId_tmdbId_key";

-- arr-schema-atom predecessor-index:01cae8e8ca1d3175a71b65844a63af49a7b70e9f6d47ab6a68bf88adc5a555e4
DROP INDEX "trakt_list_cache_userId_listSlug_tmdbId_key";
