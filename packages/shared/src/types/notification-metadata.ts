import { z } from "zod";
import type { NotificationEventType } from "./notifications";

// ============================================================================
// Per-event-type metadata schema registry
// ============================================================================
//
// Notification event metadata was historically free-form
// (`Record<string, unknown>`) populated ad-hoc by each emitter. This registry
// is the single source of truth for which metadata keys each event type
// actually carries on the wire — verified against every emit site in
// apps/api/src (2026-06-10).
//
// Consumers:
// - The rule composer (Operator Console) enumerates these descriptors to
//   offer `metadata.*` condition fields per event type instead of
//   guess-the-key free text (design doc §5.2).
// - NotificationService validates outgoing payloads against the derived
//   Zod schemas (warn-only — a mismatch is registry drift to fix, never a
//   reason to drop a notification).
//
// Registry rules:
// - Descriptors document the ACTUAL wire shape, not the ideal one (e.g.
//   VALIDATION_HEALTH_DEGRADED stringifies failureCount — recorded as
//   "string", not "number").
// - `optional: true` means the key is absent on at least one emit path.
//   This matters to rule authors: an absent field fails EVERY operator,
//   including `not_equals` (see apps/api/src/lib/notifications/
//   condition-matcher.ts) — the composer surfaces that caveat from this
//   flag.
// - The Record over NotificationEventType is the exhaustiveness gate: a
//   new event type does not compile until it declares its metadata here
//   (an empty array is a valid declaration meaning "no metadata").

/** Wire type of one metadata value. */
export type NotificationMetadataFieldType = "string" | "number" | "boolean" | "string_array";

/** Describes one metadata key an event type may carry. */
export interface NotificationMetadataField {
	key: string;
	type: NotificationMetadataFieldType;
	/** Key is absent on at least one emit path (variant shapes, conditional emitters). */
	optional?: boolean;
	/** Value may be null when the key is present. */
	nullable?: boolean;
	/** Human-readable description, shown in the composer's field picker. */
	description: string;
}

// Shared descriptor fragments for emitters that stamp instance context.
const INSTANCE_FIELDS: readonly NotificationMetadataField[] = [
	{ key: "instance", type: "string", description: "Instance label the event originated from" },
	{
		key: "service",
		type: "string",
		description: "Service type of the instance (e.g. sonarr, radarr)",
	},
];

// Hunting emits one shared meta object on success paths; the thrown-error
// path emits a reduced shape (instance/service/huntType/durationMs only).
const HUNT_BASE_FIELDS: readonly NotificationMetadataField[] = [
	...INSTANCE_FIELDS,
	{ key: "huntType", type: "string", description: 'Hunt type: "missing" or "upgrade"' },
	{ key: "durationMs", type: "number", description: "Hunt run duration in milliseconds" },
];

const HUNT_RESULT_FIELDS: readonly NotificationMetadataField[] = [
	{ key: "itemsSearched", type: "number", description: "Items the hunt searched" },
	{ key: "itemsGrabbed", type: "number", description: "Items the hunt grabbed" },
	{ key: "apiCalls", type: "number", description: "*arr API calls the hunt made" },
	{
		key: "grabbedItems",
		type: "string_array",
		description: "Titles of grabbed items (first 5; empty array when nothing grabbed)",
	},
];

// qui torrent-state events share one builder with two variants discriminated
// by `aggregate` (storm rollup vs individual transition) — see
// apps/api/src/lib/qui/torrent-state-notifier.ts.
const QUI_TORRENT_FIELDS: readonly NotificationMetadataField[] = [
	{
		key: "aggregate",
		type: "boolean",
		description: "true = storm rollup of many transitions; false = single torrent",
	},
	{
		key: "kind",
		type: "string",
		description: 'Transition kind: "errored", "stalled" or "completed"',
	},
	{
		key: "count",
		type: "number",
		optional: true,
		description: "Number of torrents in the rollup (aggregate notifications only)",
	},
	{
		key: "sampleTitles",
		type: "string_array",
		optional: true,
		description: "Sample torrent titles (first 5; aggregate notifications only)",
	},
	{
		key: "infoHash",
		type: "string",
		optional: true,
		description: "Torrent info-hash (individual notifications only)",
	},
	{
		key: "torrentTitle",
		type: "string",
		optional: true,
		description: "*arr library title of the torrent (individual notifications only)",
	},
	{
		key: "instanceLabel",
		type: "string",
		optional: true,
		description: "qui instance label (individual notifications only)",
	},
	{
		key: "oldState",
		type: "string",
		optional: true,
		nullable: true,
		description: "Previous torrent state; null when first seen (individual notifications only)",
	},
	{
		key: "newState",
		type: "string",
		optional: true,
		description: "New torrent state (individual notifications only)",
	},
];

const LIBRARY_INSIGHT_FIELDS = (signal: string): readonly NotificationMetadataField[] => [
	{ key: "count", type: "number", description: "Number of items matching the insight" },
	{ key: "signal", type: "string", description: `Insight signal identifier (always "${signal}")` },
];

/**
 * The registry. One entry per notification event type; an empty array means
 * the event carries no metadata. Keep this in sync with the emit sites —
 * the api-side conformance test pins each emitter's shape against it.
 */
export const NOTIFICATION_EVENT_METADATA: Record<
	NotificationEventType,
	readonly NotificationMetadataField[]
> = {
	// Hunting — apps/api/src/lib/hunting/scheduler.ts
	HUNT_CONTENT_FOUND: [...HUNT_BASE_FIELDS, ...HUNT_RESULT_FIELDS],
	HUNT_COMPLETED: [...HUNT_BASE_FIELDS, ...HUNT_RESULT_FIELDS],
	HUNT_FAILED: [
		...HUNT_BASE_FIELDS,
		// Absent on the thrown-error path, present when a hunt returns an
		// error result after running.
		...HUNT_RESULT_FIELDS.map((f) => ({ ...f, optional: true })),
	],

	// Queue Cleaner — apps/api/src/lib/queue-cleaner/scheduler.ts
	QUEUE_ITEMS_REMOVED: [
		...INSTANCE_FIELDS,
		{ key: "itemsCleaned", type: "number", description: "Items removed from the queue" },
		{ key: "itemsSkipped", type: "number", description: "Items evaluated but skipped" },
		{ key: "durationMs", type: "number", description: "Cleaner run duration in milliseconds" },
		{
			key: "cleanedItems",
			type: "string_array",
			description: 'Removed items as "Title (rule)" strings (first 5)',
		},
	],
	QUEUE_STRIKES_ISSUED: [
		...INSTANCE_FIELDS,
		{ key: "itemsWarned", type: "number", description: "Items that received strikes" },
		{
			key: "warnedItems",
			type: "string_array",
			description: 'Warned items as "Title (rule)" strings (first 5)',
		},
	],
	QUEUE_CLEANER_FAILED: [
		...INSTANCE_FIELDS,
		{
			key: "durationMs",
			type: "number",
			description: "Run duration before failure in milliseconds",
		},
	],

	// qui torrent layer — apps/api/src/lib/qui/torrent-state-notifier.ts
	QUI_TORRENT_ERRORED: QUI_TORRENT_FIELDS,
	QUI_DOWNLOAD_STALLED: QUI_TORRENT_FIELDS,
	QUI_TORRENT_COMPLETED: QUI_TORRENT_FIELDS,

	// TRaSH Guides — two emitters with disjoint shapes:
	// scheduled per-template sync (sync-scheduler.ts) vs update-check rollup
	// (update-scheduler.ts). All keys optional; descriptions say which.
	TRASH_PROFILE_UPDATED: [
		{
			key: "templateId",
			type: "string",
			optional: true,
			description: "Synced template id (scheduled per-template sync only)",
		},
		{
			key: "instanceId",
			type: "string",
			optional: true,
			description: "Target instance id (scheduled per-template sync only)",
		},
		{
			key: "syncId",
			type: "string",
			optional: true,
			description: "Sync history id (scheduled per-template sync only)",
		},
		{
			key: "templatesAutoSynced",
			type: "number",
			optional: true,
			description: "Templates auto-synced (update-check rollup only)",
		},
		{
			key: "templatesNeedingAttention",
			type: "number",
			optional: true,
			description: "Templates needing attention (update-check rollup only)",
		},
		{
			key: "qualitySizeAutoSynced",
			type: "number",
			optional: true,
			description: "Quality-size definitions auto-synced (update-check rollup only)",
		},
	],
	TRASH_SYNC_ERROR: [
		// Four emit paths; two carry no metadata at all.
		{
			key: "templateId",
			type: "string",
			optional: true,
			description: "Template id (scheduled-sync failures only)",
		},
		{
			key: "instanceId",
			type: "string",
			optional: true,
			description: "Instance id (scheduled-sync failures only)",
		},
		{
			key: "reason",
			type: "string",
			optional: true,
			description: 'Failure reason code (e.g. "validation_failed"; validation failures only)',
		},
	],
	TRASH_DEPLOY_FAILED: [
		{ key: "templateId", type: "string", description: "Template that failed to deploy" },
		{
			key: "instance",
			type: "string",
			optional: true,
			description: "Instance label (single-instance deployments only)",
		},
		{
			key: "totalInstances",
			type: "number",
			optional: true,
			description: "Instances attempted (bulk deployments only)",
		},
		{
			key: "failedInstances",
			type: "number",
			optional: true,
			description: "Instances that failed (bulk deployments only)",
		},
	],

	// Backup — apps/api/src/lib/backup/backup-scheduler.ts
	BACKUP_COMPLETED: [
		{ key: "nextRunAt", type: "string", description: "Next scheduled backup (ISO timestamp)" },
		{ key: "intervalType", type: "string", description: "Backup interval setting" },
		{ key: "retentionCount", type: "number", description: "Number of backups retained" },
	],
	BACKUP_FAILED: [],

	// Library — sync-scheduler.ts / cleanup-scheduler.ts
	LIBRARY_NEW_CONTENT: [
		...INSTANCE_FIELDS,
		{ key: "itemCount", type: "number", description: "Newly downloaded items" },
		{ key: "items", type: "string_array", description: "Titles of new downloads (first 5)" },
	],
	CLEANUP_ITEMS_FLAGGED: [
		{ key: "itemsFlagged", type: "number", description: "Items flagged for review" },
	],
	CLEANUP_ITEMS_REMOVED: [
		{ key: "itemsRemoved", type: "number", description: "Items removed from the library" },
		{ key: "itemsUnmonitored", type: "number", description: "Items unmonitored" },
		{ key: "itemsFilesDeleted", type: "number", description: "Files deleted from disk" },
	],

	// Security — apps/api/src/routes/auth.ts
	ACCOUNT_LOCKED: [
		{ key: "username", type: "string", description: "Account that was locked" },
		{ key: "ip", type: "string", description: "Source IP of the failed attempts" },
		{ key: "failedAttempts", type: "number", description: "Consecutive failed attempts" },
		{ key: "lockedMinutes", type: "number", description: "Lockout duration in minutes" },
	],
	LOGIN_FAILED: [
		{ key: "username", type: "string", description: "Username of the failed attempt" },
		{ key: "ip", type: "string", description: "Source IP of the attempt" },
		{ key: "failedAttempts", type: "number", description: "Failed attempts so far" },
		{ key: "maxAttempts", type: "number", description: "Attempts before lockout" },
	],

	// Services — apps/api/src/routes/services.ts
	SERVICE_CONNECTION_FAILED: [
		{ key: "service", type: "string", description: "Service type that failed the connection test" },
		{ key: "baseUrl", type: "string", description: "Base URL that was tested" },
	],

	// Cache — plex-cache-scheduler.ts / plex-episode-cache-scheduler.ts
	CACHE_REFRESH_STALE: [],

	// Plex / Jellyfin analytics — session-snapshot-scheduler.ts (no metadata)
	PLEX_CONCURRENT_PEAK: [],
	PLEX_TRANSCODE_HEAVY: [],
	PLEX_NEW_DEVICE: [],
	JELLYFIN_CONCURRENT_PEAK: [],
	JELLYFIN_TRANSCODE_HEAVY: [],
	JELLYFIN_NEW_DEVICE: [],

	// System — apps/api/src/index.ts (channel test-senders emit this event
	// type with no metadata object at all, which is always legal).
	SYSTEM_STARTUP: [
		{ key: "version", type: "string", description: "arr-dashboard version" },
		{ key: "nodeVersion", type: "string", description: "Node.js runtime version" },
		{ key: "database", type: "string", description: "Database provider in use" },
		{ key: "host", type: "string", description: "API bind host" },
		{ key: "port", type: "number", description: "API port" },
	],
	SYSTEM_ERROR: [],
	VALIDATION_HEALTH_DEGRADED: [
		{ key: "integration", type: "string", description: "Integration whose validation degraded" },
		{
			key: "failureCount",
			type: "string",
			// Documents the wire reality: the emitter stringifies the number.
			description: "Consecutive validation failures (stringified number)",
		},
		{
			key: "affectedCategories",
			type: "string",
			description: 'Comma-joined affected categories, or "unknown"',
		},
	],

	// Library Insights — apps/api/src/lib/notifications/insights-digest.ts
	LIBRARY_INSIGHT_REQUESTED_UNWATCHED: LIBRARY_INSIGHT_FIELDS("requested_unwatched"),
	LIBRARY_INSIGHT_WATCHED_MONITORED: LIBRARY_INSIGHT_FIELDS("watched_monitored"),
};

// ============================================================================
// Derived Zod schemas (for emitter conformance validation)
// ============================================================================

function fieldToZodType(field: NotificationMetadataField): z.ZodType {
	let base: z.ZodType;
	switch (field.type) {
		case "string":
			base = z.string();
			break;
		case "number":
			base = z.number();
			break;
		case "boolean":
			base = z.boolean();
			break;
		case "string_array":
			base = z.array(z.string());
			break;
	}
	if (field.nullable) base = base.nullable();
	if (field.optional) base = base.optional();
	return base;
}

function buildEventMetadataSchema(fields: readonly NotificationMetadataField[]): z.ZodType {
	// strictObject so unknown keys fail — that failure IS the registry-drift
	// signal the warn-only validation in NotificationService exists to catch.
	return z.strictObject(Object.fromEntries(fields.map((f) => [f.key, fieldToZodType(f)])));
}

/**
 * Per-event-type metadata schemas derived from the registry. Strict: keys
 * not declared in the registry fail validation. Intended for warn-only
 * conformance checks — never to block a notification.
 */
export const eventMetadataSchemaMap: Record<NotificationEventType, z.ZodType> = Object.fromEntries(
	(Object.keys(NOTIFICATION_EVENT_METADATA) as NotificationEventType[]).map((eventType) => [
		eventType,
		buildEventMetadataSchema(NOTIFICATION_EVENT_METADATA[eventType]),
	]),
) as Record<NotificationEventType, z.ZodType>;

/**
 * Composer-facing accessor: the metadata fields a given event type may
 * carry. An empty array means the event has no metadata — the composer
 * should offer no `metadata.*` conditions for it.
 */
export function describeEventMetadata(
	eventType: NotificationEventType,
): readonly NotificationMetadataField[] {
	return NOTIFICATION_EVENT_METADATA[eventType];
}
