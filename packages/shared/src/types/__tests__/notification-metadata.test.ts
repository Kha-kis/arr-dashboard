import { describe, expect, it } from "vitest";
import {
	describeEventMetadata,
	eventMetadataSchemaMap,
	NOTIFICATION_EVENT_METADATA,
} from "../notification-metadata";
import { notificationEventTypeSchema } from "../notifications";

describe("NOTIFICATION_EVENT_METADATA registry", () => {
	it("has an entry for every notification event type", () => {
		// The Record type already enforces this at compile time; this pins it
		// at runtime too so a future type-level loosening can't slip through.
		for (const eventType of notificationEventTypeSchema.options) {
			expect(NOTIFICATION_EVENT_METADATA[eventType]).toBeDefined();
		}
		expect(Object.keys(NOTIFICATION_EVENT_METADATA).sort()).toEqual(
			[...notificationEventTypeSchema.options].sort(),
		);
	});

	it("declares unique keys per event type", () => {
		for (const eventType of notificationEventTypeSchema.options) {
			const keys = NOTIFICATION_EVENT_METADATA[eventType].map((f) => f.key);
			expect(new Set(keys).size).toBe(keys.length);
		}
	});

	it("gives every field a non-empty description (composer field-picker copy)", () => {
		for (const eventType of notificationEventTypeSchema.options) {
			for (const field of NOTIFICATION_EVENT_METADATA[eventType]) {
				expect(field.description.length, `${eventType}.${field.key}`).toBeGreaterThan(0);
			}
		}
	});
});

describe("eventMetadataSchemaMap (derived schemas)", () => {
	it("rejects keys not declared in the registry (drift detection)", () => {
		const result = eventMetadataSchemaMap.ACCOUNT_LOCKED.safeParse({
			username: "admin",
			ip: "10.0.0.1",
			failedAttempts: 5,
			lockedMinutes: 15,
			smuggled: "nope",
		});
		expect(result.success).toBe(false);
	});

	it("rejects wrong value types", () => {
		const result = eventMetadataSchemaMap.CLEANUP_ITEMS_FLAGGED.safeParse({
			itemsFlagged: "four",
		});
		expect(result.success).toBe(false);
	});

	it("rejects missing required keys", () => {
		const result = eventMetadataSchemaMap.SERVICE_CONNECTION_FAILED.safeParse({
			service: "sonarr",
		});
		expect(result.success).toBe(false);
	});

	it("honors optional fields (variant shapes parse without them)", () => {
		const minimalHuntFailure = eventMetadataSchemaMap.HUNT_FAILED.safeParse({
			instance: "Sonarr Main",
			service: "sonarr",
			huntType: "missing",
			durationMs: 1200,
		});
		expect(minimalHuntFailure.success).toBe(true);
	});

	it("honors nullable fields (qui oldState is null on first sight)", () => {
		const result = eventMetadataSchemaMap.QUI_TORRENT_ERRORED.safeParse({
			aggregate: false,
			kind: "errored",
			infoHash: "abc123",
			torrentTitle: "Some Show S01E01",
			instanceLabel: "qui main",
			oldState: null,
			newState: "error",
		});
		expect(result.success).toBe(true);
	});

	it("accepts an empty object for no-metadata event types", () => {
		expect(eventMetadataSchemaMap.CACHE_REFRESH_STALE.safeParse({}).success).toBe(true);
		expect(eventMetadataSchemaMap.PLEX_CONCURRENT_PEAK.safeParse({ anything: 1 }).success).toBe(
			false,
		);
	});
});

describe("describeEventMetadata", () => {
	it("returns the registry entry for the event type", () => {
		expect(describeEventMetadata("BACKUP_FAILED")).toEqual([]);
		expect(describeEventMetadata("LOGIN_FAILED").map((f) => f.key)).toEqual([
			"username",
			"ip",
			"failedAttempts",
			"maxAttempts",
		]);
	});
});
