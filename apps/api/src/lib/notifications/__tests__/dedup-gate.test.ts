/**
 * Unit tests for the DedupGate deduplication filter.
 *
 * Verifies that duplicate notification payloads are correctly suppressed
 * within the TTL window and allowed after expiry.
 */

import { describe, it, expect, afterEach } from "vitest";
import { DedupGate } from "../dedup-gate.js";

let gate: DedupGate;

describe("DedupGate", () => {
	afterEach(() => {
		gate.destroy();
	});

	it("marks second identical payload within TTL as duplicate", () => {
		gate = new DedupGate(5000);

		const payload = {
			eventType: "HUNT_COMPLETED" as const,
			title: "Hunt finished",
			body: "Found 3 items",
		};

		expect(gate.isDuplicate(payload)).toBe(false);
		expect(gate.isDuplicate(payload)).toBe(true);
	});

	it("allows payloads with different titles", () => {
		gate = new DedupGate(5000);

		const payload1 = {
			eventType: "HUNT_COMPLETED" as const,
			title: "Hunt finished",
			body: "Found 3 items",
		};
		const payload2 = {
			eventType: "HUNT_COMPLETED" as const,
			title: "Hunt started",
			body: "Found 3 items",
		};

		expect(gate.isDuplicate(payload1)).toBe(false);
		expect(gate.isDuplicate(payload2)).toBe(false);
	});

	it("allows payloads with different bodies", () => {
		gate = new DedupGate(5000);

		const payload1 = {
			eventType: "HUNT_COMPLETED" as const,
			title: "Hunt finished",
			body: "Found 3 items",
		};
		const payload2 = {
			eventType: "HUNT_COMPLETED" as const,
			title: "Hunt finished",
			body: "Found 5 items",
		};

		expect(gate.isDuplicate(payload1)).toBe(false);
		expect(gate.isDuplicate(payload2)).toBe(false);
	});

	it("allows same payload after TTL expires", async () => {
		gate = new DedupGate(100);

		const payload = {
			eventType: "HUNT_COMPLETED" as const,
			title: "Hunt finished",
			body: "Found 3 items",
		};

		expect(gate.isDuplicate(payload)).toBe(false);
		expect(gate.isDuplicate(payload)).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(gate.isDuplicate(payload)).toBe(false);
	});

	it("destroy() cleans up without errors", () => {
		gate = new DedupGate(5000);

		const payload = {
			eventType: "HUNT_COMPLETED" as const,
			title: "Test",
			body: "Body",
		};

		gate.isDuplicate(payload);
		expect(() => gate.destroy()).not.toThrow();
	});

	it("treats different eventType with same title/body as distinct", () => {
		gate = new DedupGate(5000);

		const payload1 = {
			eventType: "HUNT_COMPLETED" as const,
			title: "Same title",
			body: "Same body",
		};
		const payload2 = {
			eventType: "BACKUP_COMPLETED" as const,
			title: "Same title",
			body: "Same body",
		};

		expect(gate.isDuplicate(payload1)).toBe(false);
		expect(gate.isDuplicate(payload2)).toBe(false);
	});
});
