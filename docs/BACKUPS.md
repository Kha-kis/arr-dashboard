# Backup inventory

Arr Dashboard backup format **1.2** emits complete, explicit coverage for the
durable configuration and authentication state needed to recreate an
installation. Every collection is represented as an array, including an empty
array. Encrypted values are copied with their ciphertext and IV unchanged.

## What format 1.2 contains

The payload contains all of these arrays:

- Authentication and services: `users`, `sessions`, `serviceInstances`,
  `serviceTags`, `serviceInstanceTags`, `oidcProviders`, `oidcAccounts`, and
  `webAuthnCredentials`.
- Singleton/configuration state: `systemSettings`, `backupSettings`, and
  `vapidKeys`.
- TRaSH configuration: `trashTemplates`, `trashSettings`,
  `trashSyncSchedules`, `templateQualityProfileMappings`,
  `instanceQualityProfileOverrides`, `standaloneCFDeployments`, and
  `qualitySizeMappings`.
- Hunting configuration: `huntConfigs`.
- Durable feature configuration: `notificationChannel`,
  `notificationSubscription`, `notificationRule`,
  `notificationAggregationConfig`, `autoTagRule`, `labelSyncRule`,
  `queueCleanerConfig`, `libraryCleanupConfig`, `libraryCleanupRule`,
  `namingConfig`, and `userCustomFormat`.
- Cleanup coordination: active `libraryCleanupApproval` rows and active
  `libraryCleanupMediaServerScan` rows are included; an active scan also
  carries its parent approval even when that approval is already executed.
- Bounded operational history: `trashSyncHistory`,
  `templateDeploymentHistory`, `namingDeployHistory`, `huntLogs`, and
  `huntSearchHistory`.

The shared TypeScript shape keeps later-added properties optional so 1.0 and
1.1 files remain representable. Runtime `validateBackup` is authoritative:
format 1.2 rejects any missing array in the complete contract, including an
array that would otherwise be safely interpreted as empty.

History is capped according to the backup retention option and may be omitted
for scheduled/update backups. The exception is safety coordination: every
nonterminal TRaSH rollback/undeploy row and its referenced `trashBackups` row
is always included. Active naming recovery rows are also included even when
history is omitted or capped. These rows preserve resumability and are checked
for equality against current state during restore.

## Prisma model inventory

This is the current model classification. “Included” means copied by format
1.2; “conditional” means only the bounded coordination rows described above
are copied.

| Model | Classification | Backup status |
| --- | --- | --- |
| `User` | durable config/auth-secret | included |
| `Session` | durable config/auth-secret | included |
| `ServiceTag` | durable config/auth-secret | included |
| `ServiceInstance` | durable config/auth-secret | included |
| `ServiceInstanceTag` | durable config/auth-secret | included |
| `OIDCProvider` | durable config/auth-secret | included |
| `OIDCAccount` | durable config/auth-secret | included |
| `WebAuthnCredential` | durable config/auth-secret | included |
| `BackupSettings` | durable config/auth-secret | included |
| `SystemSettings` | durable config/auth-secret | included |
| `TrashTemplate` | durable config/auth-secret | included |
| `TrashSyncSchedule` | durable config/auth-secret | included |
| `TrashSettings` | durable config/auth-secret | included |
| `TemplateQualityProfileMapping` | durable config/auth-secret | included |
| `InstanceQualityProfileOverride` | durable config/auth-secret | included; pending/uncertain intent is equality-checked |
| `StandaloneCFDeployment` | durable config/auth-secret | included |
| `QualitySizeMapping` | durable config/auth-secret | included |
| `HuntConfig` | durable config/auth-secret | included |
| `HuntLog` | audit/history | excluded for scheduled/update backups; bounded in manual backups |
| `HuntSearchHistory` | audit/history | excluded for scheduled/update backups; bounded in manual backups |
| `UserCustomFormat` | durable config/auth-secret | included |
| `QueueCleanerConfig` | durable config/auth-secret | included |
| `LibraryCleanupConfig` | durable config/auth-secret | included |
| `LibraryCleanupRule` | durable config/auth-secret | included |
| `NotificationChannel` | durable config/auth-secret | included |
| `NotificationSubscription` | durable config/auth-secret | included |
| `VapidKeys` | durable config/auth-secret | included |
| `NotificationRule` | durable config/auth-secret | included |
| `NotificationAggregationConfig` | durable config/auth-secret | included |
| `NamingConfig` | durable config/auth-secret | included |
| `LabelSyncRule` | durable config/auth-secret | included |
| `AutoTagRule` | durable config/auth-secret | included |
| `TrashSyncHistory` | coordination | conditional: nonterminal/uncertain rows always included |
| `TemplateDeploymentHistory` | coordination | conditional: nonterminal rows always included |
| `TrashBackup` | coordination | conditional: snapshots referenced by coordination always included |
| `NamingDeployHistory` | coordination | active recovery rows always included; other rows bounded |
| `TrashCache` | disposable/rebuildable cache | excluded |
| `InodeIndexCache` | disposable/rebuildable cache | excluded |
| `LibraryCache` | disposable/rebuildable cache | excluded |
| `EpisodeFileCache` | disposable/rebuildable cache | excluded |
| `LibrarySyncStatus` | disposable/rebuildable cache | excluded |
| `QueueCleanerStrike` | audit/history | excluded |
| `QueueCleanerLog` | audit/history | excluded |
| `LibraryCleanupApproval` | coordination | active statuses included; terminal audit excluded |
| `LibraryCleanupMediaServerScan` | coordination | pending/triggering/failed statuses included; terminal audit excluded |
| `LibraryCleanupMediaServerScanLease` | coordination | excluded; nonportable lease is recoverable from scan state |
| `LibraryCleanupLog` | audit/history | excluded |
| `LibraryCleanupAuditEvent` | audit/history | excluded |
| `NotificationLog` | audit/history | excluded |
| `PlexCache` | disposable/rebuildable cache | excluded |
| `PlexGenerationTarget` | disposable/rebuildable cache | excluded |
| `PlexEpisodeCache` | disposable/rebuildable cache | excluded |
| `JellyfinCache` | disposable/rebuildable cache | excluded |
| `JellyfinEpisodeCache` | disposable/rebuildable cache | excluded |
| `TautulliCache` | disposable/rebuildable cache | excluded |
| `CacheRefreshStatus` | disposable/rebuildable cache | excluded |
| `SessionSnapshot` | audit/history | excluded |
| `SeerrActionLog` | audit/history | excluded |
| `TmdbListCache` | disposable/rebuildable cache | excluded |
| `TraktListCache` | disposable/rebuildable cache | excluded |
| `ListCacheRefreshStatus` | disposable/rebuildable cache | excluded |
| `QuiActivityLog` | audit/history | excluded |
| `QuiActionLog` | audit/history | excluded |
| `QuiEventLog` | audit/history | excluded |

## Legacy restore behavior

Versions **1.0** and **1.1** remain readable. Their older optional arrays may
be absent, and a clean target may restore them. A legacy restore is rejected
with HTTP 409 when the target already contains a relational durable-configuration
row whose coverage is absent from the file. The check runs before the current
secrets file is changed and again inside the database transaction before any
delete, so an incomplete legacy backup cannot silently erase configuration.

The independent singleton rows (`BackupSettings`, `VapidKeys`, and other
singleton settings) are preserved when absent from a legacy file. A format 1.2
backup always carries those arrays and replaces them deterministically.

The compatibility response is intentionally bounded and does not include
secrets, URLs, names, or configuration contents. Snapshotless legacy partial
undeploy records are normalized to uncertain audit-only records; they are never
treated as resumable rollback authority.
