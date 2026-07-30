import { describe, expect, it } from "vitest";
import { serializeRule } from "../library-cleanup.js";

function makeRule(overrides: Record<string, unknown> = {}) {
	const timestamp = new Date("2026-07-30T00:00:00.000Z");
	return {
		id: "rule-1",
		name: "Cleanup",
		enabled: true,
		priority: 0,
		ruleType: "plex_watch_count",
		parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		serviceFilter: JSON.stringify(["SONARR"]),
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		action: "delete_files",
		operator: null,
		conditions: null,
		retentionMode: false,
		useGlobalRejectionMemory: true,
		rejectionMemoryDays: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	};
}

describe("library cleanup rule serialization", () => {
	it("falls back to series for rows created before target scope existed", () => {
		expect(serializeRule(makeRule()).targetScope).toBe("series");
	});

	it("preserves explicit episode scope", () => {
		expect(serializeRule(makeRule({ targetScope: "episode" })).targetScope).toBe("episode");
	});

	it("fails closed to series for an unknown persisted value", () => {
		expect(serializeRule(makeRule({ targetScope: "unexpected" })).targetScope).toBe("series");
	});
});
