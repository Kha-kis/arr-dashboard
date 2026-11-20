# Backup inventory

> [!WARNING]
> Backup creation, scheduling, download, and deletion remain available. Restore
> is temporarily disabled and returns HTTP 503 before reading the supplied
> backup or changing filesystem/database state. Internal destination-key
> preparation and disposable transaction tests do not establish exclusive
> admission or crash-safe publication. The maintenance barrier is
> not shared across API processes. Issue #815 remains open for a durable,
> restart-reconciled recovery protocol and provider-backed exclusive lease.

The inventory below documents the complete export format and the safety
contract a future restore implementation must satisfy. It does not mean that
restore is enabled in this version.

Arr Dashboard backup format **1.6** emits complete, explicit coverage for the
durable configuration and authentication state needed to recreate an
installation. Every collection is represented as an array, including an empty
array. Encrypted values are copied with their ciphertext and IV unchanged.

## What format 1.6 contains

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
- Accepted notification work: `notificationOutboxEvents` and
  `notificationOutboxDeliveries`, including encrypted payloads, exact recipient
  references, aggregation lineage, remaining retries and unconfirmed outcomes.
  Both arrays are explicit and uncapped, even when delivery History is excluded.
- Library sync configuration: `librarySyncSettings` contains only
  `instanceId`, `pollingEnabled`, and `pollingIntervalMins`. Volatile sync
  status is excluded and resets to database defaults.
- Cleanup coordination: active `libraryCleanupApproval` rows, executed
  approvals still awaiting terminal audit, and active
  `libraryCleanupMediaServerScan` rows are included; an active scan also
  carries its parent approval even when that approval is already executed.
  Nonportable terminal-audit and recovery-attempt timestamps are reset so the
  restored scheduler can record fresh audit evidence.
- Bounded operational history: `trashSyncHistory`,
  `templateDeploymentHistory`, `namingDeployHistory`, `huntLogs`, and
  `huntSearchHistory`.
- Uncapped safety evidence: `arrImportOperations`, `arrImportFileProofs`,
  `arrImportSourceClaims`, `queueCleanerImportReceipts`, `quiActionClaims`,
  exactly linked and pending/uncertain `quiActionLogs`, and
  `labelSyncMutationAttempts`, `searchGrabAttempts`, and `searchGrabClaims`. Import command identity, submission markers,
  positive file proofs, unknown outcomes and source holds bypass history caps
  and scheduled/update history exclusion.

The shared TypeScript shape keeps later-added properties optional so 1.0 and
1.1 files remain representable. Runtime `validateBackup` is authoritative:
formats 1.2–1.6 reject any missing array in their respective complete contracts, including an
array that would otherwise be safely interpreted as empty. The
`oidcProviders`, `systemSettings`, `backupSettings`, and `vapidKeys` arrays may
each contain at most one record; an ambiguous payload is rejected before
secrets or database state can change.

Every portable collection is read sequentially inside one serializable Prisma
transaction. This keeps the bounded-heap query order while ensuring related
parents, children, and encrypted configuration come from one database
snapshot. Active naming recovery rows and their service authority are checked
again after that snapshot closes so a change at the publication boundary makes
backup creation fail closed and retry.

History is capped according to the backup retention option and may be omitted
for scheduled/update backups. The exception is safety coordination: every
nonterminal TRaSH rollback/undeploy row and its referenced `trashBackups` row
is always included. Active naming recovery rows are also included even when
history is omitted or capped. These rows preserve resumability and are checked
for equality against current state during restore.

## Prisma model inventory

The enforced schema-wide model and encrypted-field inventory is
[`backup-portability.ts`](../apps/api/src/lib/backup/backup-portability.ts).
`RestoreRuntimeControl` is a destination-local recovery journal, excluded from
portable backups and explicitly preserved by internal prepared replacement.
Ordinary installation-local worker leases are still discarded. An empty journal
is not initialized implicitly by a schema upgrade or a destructive boundary.
Its internal commit helper uses a complete-snapshot compare-and-set, but this
core alone does not establish provider ownership, crash-safe runtime admission,
or enable public Restore.
The following table describes the major model groups. “Included” means copied by format
1.6; “conditional” means only the bounded coordination rows described above
are copied.

| Model | Classification | Backup status |
| --- | --- | --- |
| `RestoreRuntimeControl` | destination-local recovery coordination | excluded; only this local journal is preserved across internal prepared Restore |
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
| `NotificationOutboxEvent` | accepted work/safety evidence | included, uncapped, with encrypted aggregation-member lineage |
| `NotificationOutboxDelivery` | accepted work/safety evidence | included, uncapped; imported pending work is never replayed |
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
| `LibrarySyncStatus` | mixed durable config and disposable cache | `pollingEnabled` and `pollingIntervalMins` included as `librarySyncSettings`; sync timestamps, progress, duration, errors, and item counts excluded and reset |
| `QueueCleanerStrike` | audit/history | excluded |
| `QueueCleanerLog` | audit/history | excluded |
| `QueueCleanerImportReceipt` | safety evidence | included, uncapped |
| `ArrImportOperation` | safety evidence | included, uncapped; encrypted lookup translated during preparation |
| `ArrImportFileProof` | safety evidence | included with exact operation identity |
| `ArrImportSourceClaim` | safety evidence | included; durable hold retained |
| `LibraryCleanupApproval` | coordination | active statuses and executed rows awaiting terminal audit included; terminal-audit markers reset |
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
| `QuiActionLog` | safety evidence/history | pending/uncertain and exactly claimed evidence included; unrelated terminal history excluded |
| `QuiActionClaim` | safety evidence | composite target identity and hold included |
| `SearchGrabAttempt` | safety evidence | every intent and outcome included, uncapped; encrypted minimal target translated |
| `SearchGrabClaim` | safety evidence | exact target hold included; never replay authority |
| `QuiEventLog` | audit/history | excluded |
| `LabelSyncMutationAttempt` | safety evidence | included, uncapped, with explicit nullable restore evidence; uncertain restored work stays held |

Excluded cache and refresh-status models start empty after restore. They are
repopulated by the application’s normal provider synchronization, list-cache,
and scheduled/manual refresh paths after the required application restart;
their absence from the backup is not treated as durable authority or success
evidence. Excluded notification delivery logs are cleared transactionally
before notification channels are replaced so post-snapshot history cannot be
reattached to a restored channel ID.

Backup creation uses the process-wide maintenance lease. Every
HTTP `POST`, `PUT`, `PATCH`, and `DELETE` handler registered under the API root
holds a shared operation lease for its full handler lifetime, so configuration
writes cannot overlap the export snapshot. Backup creation and destructive topology routes are
allowed to upgrade their request's sole shared lease to the existing stronger
maintenance or exclusive topology lease. An upgrade fails closed when any
other operation is active.
Background notification dispatch and retry publication participate in the same
barrier. Read-only routes remain available while a normal mutation is running.

This in-process barrier protects coherent export in the supported single-API
topology. It is not sufficient authority for restore, which remains disabled
until a provider-backed cross-process exclusion mechanism is available.

## Internal preparation and disposable transaction boundary

Authenticated preparation validates the encrypted envelope and complete safety
links, then translates all registry-listed schema ciphertext/IV pairs with the
resolved destination Encryptor. Each IV is fresh even for equal keys. Source
credentials and keys remain transient; no decrypted backup is written to disk.
The prepared value contains translated records and bounded binding evidence,
never envelope secrets or source sessions. A module-private immutable original
ciphertext witness is used only for conservation checks, never for insertion.

Preparation also migrates portable TRaSH mapping and score-override connection
tokens, schema-v2 recovery connection tokens and credential-dependent endpoint
keys, and verified cloned-profile source connection tokens. Each migration
first proves the original binding against the exact instance, owner, service,
and connection generation. Credential identity uses the source and destination
resolved Encryptors through the existing client-factory identity calculation.
Stale, conflicting, malformed, or unverifiable bindings reject preparation
before database mutation. Genuine legacy unbound mappings and cloned-source
metadata remain unbound; genuine legacy recovery snapshots are not upgraded to
schema v2. Resource-state proofs, managed formats, score intents, pending or
unknown recovery markers, and unrelated JSON fields are preserved. Translation
does not query a provider or authorize retry, rollback, or new upstream work.

The internal `restorePreparedDatabase` helper has no live service or route
caller. It accepts only genuinely prepared format 1.3–1.6 values for the same
destination installation, with complete safety coverage and no publication
blocker. It repeats compatibility and conservation checks inside the same
serializable transaction before deletion. Every current import operation,
proof, source claim and receipt must be exactly represented by the authenticated
original witness. qUI claims, their linked logs and pending/uncertain logs must
retain their exact identities, parents and original connection fingerprints.
Parent users must exist with the conserved owner ID; matching by username is
insufficient. Account/password and login metadata may differ because Restore
deliberately reinstates the authenticated backed-up account. Service parents
must preserve enabled state, storage grouping, local filesystem access/path
mapping, connection generation and provider identity fields/generation, in
addition to their exact owner, service and credential-bound fingerprint.
Presentation labels, external URLs, default flags and observation timestamps
may differ without rebinding a held action.
Dates compare canonically and JSON structurally. Missing, changed or
unverifiable evidence fails closed; current state is never merged into a stale
backup to make it pass. Existing naming, cleanup, TRaSH and label compatibility
gates remain in force. The plain `restoreDatabase` helper still refuses any
current unresolved label attempt. Only the branded internal prepared path can
replace that refusal with exact conservation of every current label attempt
against the authenticated original, including terminal outcomes, source claim
tokens, counters, request markers and restore evidence. Referenced rules retain
their execution fields; referenced destination and explicitly bound source
connections retain their owner, credential-bound identity and authority fields.
Presentation labels and rule run summaries are not execution authority.

Only translated records are inserted, with safety children deleted before
parents (including qUI's service-instance RESTRICT relation). Source worker
ownership is cleared only by the documented preparation dispositions, preserving
durable holds and outcomes. Destination sessions disappear atomically on success
and survive a rolled-back transaction. Restored `hashedPassword`, OIDC and
passkey records are conserved; successful eventual public Restore must require
fresh sign-in. The helper never writes destination encryption keys, cookie
secrets or installation identity and never dispatches or replays provider work.

Format 1.4 requires an explicit nullable `restoreEvidence` field on every label
attempt. Older formats remain readable for native attempts, but cannot carry
new `restored-held` or `reconciled` states or non-null restore evidence. Formats
1.3 and 1.4 retain their historical import/qUI/label safety coverage; bumping the
writer does not downgrade their readers. Format1.5 additionally requires explicit
Grab attempt and claim arrays. Preparation reports Grab coverage separately:
older formats remain `legacy-incomplete` for Grab, even when additive rows are
present. A historical backup cannot replace existing Grab evidence it omits.
Formats 1.0–1.2 remain incomplete for the older safety contract as well.

Format 1.6 independently requires both notification outbox arrays, including
explicit empty arrays. Preparation reports `notificationOutboxCoverage` as
`complete` only for 1.6; historical formats remain `legacy-incomplete` even when
additive outbox fields are present. This does not downgrade their historical
import, qUI, label or format-1.5 Grab coverage. Missing historical notification
coverage cannot erase unfinished or unconfirmed destination work.

Outbox preparation authenticates encrypted owner/event/recipient/policy bindings
and exact aggregation members, order and digest projection before translating
to destination keys. The prepared replacement conserves unfinished and
unconfirmed work and its connected aggregation graph before and inside the
transaction. Raw unprepared rows cannot bypass that conservation boundary.
Imported idle pending deliveries become canceled with the generic
`restored-not-replayed` disposition; imported submitting deliveries become
unconfirmed. They remain recorded but never automatically dispatch. Ordinary
restart recovery is distinct from Restore and still checks the destination
installation and last committed Restore binding. These internal rules do not
enable the public Restore route.

Grab attempts, predecessor links, acknowledged history and exact target claims
are included regardless of history exclusion or retention caps. Preparation
authenticates the encrypted minimal GUID/indexer tuple against its recorded owner,
instance, connection and target digest. After proving equivalent credentials,
matching connection and target digests are rebased together for destination
encryption. Stale historical proofs remain stale; they are not rebound to a
repointed connection. Imported worker epochs are cleared without relabeling an
uncertain outcome or releasing its hold. No selector or provider-send authority
is imported. Replacement conserves every current Grab record and claim both
before and inside the transaction; raw unprepared replacement cannot bypass this
gate. Predecessor nodes and edges are inserted atomically, independent of export
order. A failed insertion rolls back the replacement, including existing holds.

Preparation converts native claimed, sending and unknown label attempts to
`restored-held`, preserving the durable target hold, original send/check counts,
request marker and canonical bounded provenance. Historical worker tokens are
discarded. Re-preparing a held attempt preserves its original provenance and
current counters rather than nesting evidence or resetting history. Startup
never converts this held state into permission to send. A fresh fenced read-only
observation may mark the desired state `reconciled`; that means observed now,
not acknowledgment of the original send. Absent, ambiguous, stale or unavailable
evidence leaves the hold intact. No replay, expiry-based release or operator
override is introduced. Public Restore remains disabled independently of these
internal portability rules.

Disposable SQLite/PostgreSQL fixtures exercise transaction conservation,
refusal, stale preparation and rollback. Fresh helper processes reopen synthetic
databases and decrypt the registry-listed pairs using the unchanged effective destination
key. This is not full server startup, image/upgrade, crash/interruption,
cross-process exclusion or populated production QA evidence. Those gates and
public integration remain required before Restore can be enabled.

## Legacy direct-helper behavior

The rules in this section are retained as requirements and lower-level
validation coverage for a future restore implementation. Production restore
currently returns HTTP 503 before parsing either current or legacy files.

Versions **1.0** and **1.1** remain readable. Their older optional arrays may
be absent, and a clean target may restore them. A legacy restore is rejected
with HTTP 409 when the target already contains a relational durable-configuration
row whose coverage is absent from the file. The check runs before the current
secrets file is changed and again inside the database transaction before any
delete, so an incomplete legacy backup cannot silently erase configuration.
Format 1.2 also remains readable for authenticated credential preparation.
All formats 1.0–1.2 are marked `legacy-incomplete` by preparation and refused by
the prepared destructive helper. Its stricter conservation rules do not change
the older direct `restoreDatabase` helper's validation, sessions or callers.

Independent singleton rows are preserved when absent from a legacy file only
when that is safe. An incomplete legacy payload is rejected if the target has
stored backup-password state, VAPID private-key state, or an OIDC provider that
the file omits, because preserving that ciphertext while replacing the
installation encryption key would make it unusable. A default `BackupSettings`
row with neither password ciphertext nor IV remains compatible. When a legacy
file does carry `backupSettings` or `vapidKeys`, each array independently
authorizes deterministic replacement of that singleton even if an unrelated
newer configuration collection is absent. A format 1.2 backup always carries
both singleton arrays.

The compatibility response is intentionally bounded and does not include
secrets, URLs, names, or configuration contents. Snapshotless legacy partial
undeploy records are normalized to uncertain audit-only records; they are never
treated as resumable rollback authority.
