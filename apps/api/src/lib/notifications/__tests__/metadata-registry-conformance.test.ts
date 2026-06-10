/**
 * Emitter ↔ registry conformance suite.
 *
 * Every notification emit site in apps/api/src passes a metadata object
 * (or none); the per-event-type schema registry in @arr/shared
 * (notification-metadata.ts) documents those shapes. These fixtures mirror
 * the EXACT metadata literals at each emit site (verified 2026-06-10) so
 * that drift in either direction — an emitter adding a key without a
 * registry entry, or a registry edit that no emitter satisfies — fails
 * here instead of warn-spamming production logs.
 *
 * When this test fails after you changed an emitter: update the registry
 * AND the fixture together. The registry documents the wire, not the ideal.
 *
 * qui torrent-state events are validated through the real payload builder
 * (buildNotificationPayloads) instead of hand-copied fixtures.
 */

import { eventMetadataSchemaMap, type NotificationEventType } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { buildNotificationPayloads } from "../../qui/torrent-state-notifier.js";

/** One fixture per emit-site shape: [description, eventType, metadata]. */
const EMIT_SITE_FIXTURES: Array<[string, NotificationEventType, Record<string, unknown>]> = [
	// apps/api/src/index.ts — startup notification
	[
		"index.ts startup",
		"SYSTEM_STARTUP",
		{
			version: "3.0.0-alpha.2",
			nodeVersion: "v22.11.0",
			database: "sqlite",
			host: "0.0.0.0",
			port: 3001,
		},
	],
	// apps/api/src/routes/auth.ts
	[
		"auth.ts lockout",
		"ACCOUNT_LOCKED",
		{ username: "admin", ip: "203.0.113.7", failedAttempts: 5, lockedMinutes: 15 },
	],
	[
		"auth.ts failed login",
		"LOGIN_FAILED",
		{ username: "admin", ip: "203.0.113.7", failedAttempts: 3, maxAttempts: 5 },
	],
	// apps/api/src/routes/services.ts — connection test failure
	[
		"services.ts connection test",
		"SERVICE_CONNECTION_FAILED",
		{ service: "sonarr", baseUrl: "http://sonarr.example:8989" },
	],
	// apps/api/src/routes/trash-guides/deployment-routes.ts — two shapes
	[
		"deployment-routes.ts single deploy",
		"TRASH_DEPLOY_FAILED",
		{ instance: "Sonarr Main", templateId: "tpl-1080p" },
	],
	[
		"deployment-routes.ts bulk deploy",
		"TRASH_DEPLOY_FAILED",
		{ totalInstances: 3, failedInstances: 1, templateId: "tpl-1080p" },
	],
	// apps/api/src/lib/backup/backup-scheduler.ts
	[
		"backup-scheduler.ts completed",
		"BACKUP_COMPLETED",
		{ nextRunAt: "2026-06-11T03:00:00.000Z", intervalType: "daily", retentionCount: 7 },
	],
	// apps/api/src/lib/library-cleanup/cleanup-scheduler.ts — two outcomes
	[
		"cleanup-scheduler.ts actions taken",
		"CLEANUP_ITEMS_REMOVED",
		{ itemsRemoved: 2, itemsUnmonitored: 1, itemsFilesDeleted: 1 },
	],
	["cleanup-scheduler.ts flag-only", "CLEANUP_ITEMS_FLAGGED", { itemsFlagged: 4 }],
	// apps/api/src/lib/library-sync/sync-scheduler.ts
	[
		"library-sync new downloads",
		"LIBRARY_NEW_CONTENT",
		{ instance: "Sonarr Main", service: "sonarr", itemCount: 2, items: ["Show A", "Show B"] },
	],
	// apps/api/src/lib/hunting/scheduler.ts — shared huntMeta (success paths
	// and the returned-error path) + the reduced thrown-error shape
	[
		"hunting full huntMeta (content found)",
		"HUNT_CONTENT_FOUND",
		{
			instance: "Radarr Main",
			service: "radarr",
			huntType: "missing",
			itemsSearched: 10,
			itemsGrabbed: 2,
			apiCalls: 12,
			durationMs: 5400,
			grabbedItems: ["Movie A", "Movie B"],
		},
	],
	[
		"hunting full huntMeta (completed, nothing grabbed)",
		"HUNT_COMPLETED",
		{
			instance: "Radarr Main",
			service: "radarr",
			huntType: "upgrade",
			itemsSearched: 10,
			itemsGrabbed: 0,
			apiCalls: 11,
			durationMs: 4100,
			grabbedItems: [],
		},
	],
	[
		"hunting returned-error result (full huntMeta)",
		"HUNT_FAILED",
		{
			instance: "Radarr Main",
			service: "radarr",
			huntType: "missing",
			itemsSearched: 0,
			itemsGrabbed: 0,
			apiCalls: 1,
			durationMs: 300,
			grabbedItems: [],
		},
	],
	[
		"hunting thrown-error path (reduced shape)",
		"HUNT_FAILED",
		{ instance: "Radarr Main", service: "radarr", huntType: "missing", durationMs: 300 },
	],
	// apps/api/src/lib/queue-cleaner/scheduler.ts
	[
		"queue-cleaner removals",
		"QUEUE_ITEMS_REMOVED",
		{
			instance: "Sonarr Main",
			service: "sonarr",
			itemsCleaned: 3,
			itemsSkipped: 1,
			durationMs: 800,
			cleanedItems: ["Show A (stalled)", "Show B (failed_import)"],
		},
	],
	[
		"queue-cleaner strikes",
		"QUEUE_STRIKES_ISSUED",
		{
			instance: "Sonarr Main",
			service: "sonarr",
			itemsWarned: 2,
			warnedItems: ["Show A (slow)", "Show B (stalled)"],
		},
	],
	[
		"queue-cleaner failure",
		"QUEUE_CLEANER_FAILED",
		{ instance: "Sonarr Main", service: "sonarr", durationMs: 120 },
	],
	// apps/api/src/lib/trash-guides/sync-scheduler.ts — three metadata shapes
	[
		"trash sync-scheduler validation failure",
		"TRASH_SYNC_ERROR",
		{ templateId: "tpl-1080p", instanceId: "inst-1", reason: "validation_failed" },
	],
	[
		"trash sync-scheduler sync failure",
		"TRASH_SYNC_ERROR",
		{ templateId: "tpl-1080p", instanceId: "inst-1" },
	],
	[
		"trash sync-scheduler scheduled sync success",
		"TRASH_PROFILE_UPDATED",
		{ templateId: "tpl-1080p", instanceId: "inst-1", syncId: "sync-42" },
	],
	// apps/api/src/lib/trash-guides/update-scheduler.ts — rollup shape
	[
		"trash update-scheduler rollup",
		"TRASH_PROFILE_UPDATED",
		{ templatesAutoSynced: 2, templatesNeedingAttention: 1, qualitySizeAutoSynced: 3 },
	],
	// apps/api/src/lib/validation/integration-health.ts — note the
	// stringified failureCount; the registry documents the wire reality.
	[
		"integration-health degradation",
		"VALIDATION_HEALTH_DEGRADED",
		{ integration: "plex", failureCount: "3", affectedCategories: "sessions, library" },
	],
	// apps/api/src/lib/notifications/insights-digest.ts
	[
		"insights-digest requested-unwatched",
		"LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
		{ count: 3, signal: "requested_unwatched" },
	],
	[
		"insights-digest watched-monitored",
		"LIBRARY_INSIGHT_WATCHED_MONITORED",
		{ count: 2, signal: "watched_monitored" },
	],
];

describe("emit-site metadata conforms to the registry schemas", () => {
	it.each(EMIT_SITE_FIXTURES)("%s", (_description, eventType, metadata) => {
		const result = eventMetadataSchemaMap[eventType].safeParse(metadata);
		expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
	});

	it("qui torrent-state payloads (real builder, individual variant)", () => {
		const payloads = buildNotificationPayloads([
			{
				kind: "errored",
				infoHash: "abc123",
				title: "Some Show S01E01",
				instanceLabel: "qui main",
				oldState: null,
				newState: "error",
			},
		]);
		expect(payloads).toHaveLength(1);
		for (const payload of payloads) {
			const result = eventMetadataSchemaMap[payload.eventType].safeParse(payload.metadata);
			expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
				true,
			);
		}
	});

	it("qui torrent-state payloads (real builder, aggregate variant)", () => {
		const transitions = Array.from({ length: 8 }, (_, i) => ({
			kind: "stalled" as const,
			infoHash: `hash-${i}`,
			title: `Torrent ${i}`,
			instanceLabel: "qui main",
			oldState: "downloading",
			newState: "stalled_dl",
		}));
		const payloads = buildNotificationPayloads(transitions);
		expect(payloads).toHaveLength(1); // storm rollup
		for (const payload of payloads) {
			const result = eventMetadataSchemaMap[payload.eventType].safeParse(payload.metadata);
			expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
				true,
			);
		}
	});
});
