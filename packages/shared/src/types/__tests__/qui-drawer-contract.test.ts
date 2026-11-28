import { describe, expect, it } from "vitest";
import {
	coerceQuiLoggedOperation,
	quiActionPayloadSchemas,
	quiActionSchema,
	quiDrawerAuditSummarySchema,
	quiDrawerOperationSchema,
	quiLoggedOperationSchema,
	quiTrackerViewSchema,
} from "../qui.js";

describe("qUI drawer wire contract", () => {
	it("accepts explicit empty tag replacement without accepting missing or malformed tags", () => {
		expect(quiActionPayloadSchemas.setTags.parse({ tags: "" })).toEqual({ tags: "" });
		for (const payload of [
			{},
			{ tags: null },
			{ tags: [] },
			{ tags: 0 },
			{ tags: "x".repeat(2001) },
			{ tags: "", selectAll: true },
			{ tags: "", action: "delete" },
			{ tags: "", hashes: ["a".repeat(40)] },
		]) {
			expect(quiActionPayloadSchemas.setTags.safeParse(payload).success).toBe(false);
		}
		expect(quiActionPayloadSchemas.setTags.parse({ tags: "x".repeat(2000) }).tags).toHaveLength(
			2000,
		);
	});

	it("keeps drawer operations out of the bulk action vocabulary", () => {
		for (const action of ["renameTorrent", "addTrackers", "removeTrackers", "editTracker"]) {
			expect(quiDrawerOperationSchema.parse(action)).toBe(action);
			expect(quiLoggedOperationSchema.parse(action)).toBe(action);
			expect(quiActionSchema.safeParse(action).success).toBe(false);
			expect(coerceQuiLoggedOperation(action)).toBe(action);
		}
		expect(coerceQuiLoggedOperation("future-command")).toBe("unknown");
		expect(coerceQuiLoggedOperation("pause")).toBe("pause");
	});

	it("accepts only safe tracker view fields and opaque selectors", () => {
		const tracker = {
			trackerSelector: "a".repeat(64),
			hostname: "tracker.example.org",
			port: "443",
			tier: 2,
			status: 2,
			health: "working",
			numSeeds: 4,
			numLeeches: 1,
			numPeers: 5,
			selectable: true,
		};
		expect(quiTrackerViewSchema.parse(tracker)).toEqual(tracker);
		expect(
			quiTrackerViewSchema.safeParse({ ...tracker, url: "https://secret/announce?passkey=value" })
				.success,
		).toBe(false);
		expect(
			quiTrackerViewSchema.safeParse({ ...tracker, trackerSelector: "not-opaque" }).success,
		).toBe(false);
	});

	it("limits new drawer audit detail to a bounded safe count", () => {
		expect(quiDrawerAuditSummarySchema.parse({ trackerCount: 1 })).toEqual({ trackerCount: 1 });
		for (const trackerCount of [0, 51, 1.5]) {
			expect(quiDrawerAuditSummarySchema.safeParse({ trackerCount }).success).toBe(false);
		}
		expect(quiDrawerAuditSummarySchema.safeParse({ trackerCount: 1, url: "private" }).success).toBe(
			false,
		);
	});
});
