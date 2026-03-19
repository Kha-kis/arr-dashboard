import { beforeEach, describe, expect, it } from "vitest";
import { validationQuarantine } from "../validation-quarantine.js";

function makeItem(integration: string, category: string, index = 0) {
	return {
		raw: { id: index, invalid: true },
		errors: [`field_${index}: Expected string, received number`],
		integration,
		category,
		timestamp: new Date(Date.now() + index).toISOString(),
	};
}

describe("ValidationQuarantine", () => {
	beforeEach(() => {
		validationQuarantine.clear();
	});

	it("pushes and retrieves items by integration", () => {
		validationQuarantine.push(makeItem("plex", "sessions", 0));
		validationQuarantine.push(makeItem("plex", "sessions", 1));
		validationQuarantine.push(makeItem("seerr", "getRequests", 0));

		const plexItems = validationQuarantine.getByIntegration("plex");
		expect(plexItems).toHaveLength(2);
		expect(plexItems[0]!.integration).toBe("plex");

		const seerrItems = validationQuarantine.getByIntegration("seerr");
		expect(seerrItems).toHaveLength(1);

		expect(validationQuarantine.count).toBe(3);
	});

	it("getAll returns items grouped by integration", () => {
		validationQuarantine.push(makeItem("plex", "sessions"));
		validationQuarantine.push(makeItem("tautulli", "get_history"));

		const all = validationQuarantine.getAll();
		expect(Object.keys(all)).toEqual(expect.arrayContaining(["plex", "tautulli"]));
		expect(all.plex).toHaveLength(1);
		expect(all.tautulli).toHaveLength(1);
	});

	it("returns empty array for unknown integration", () => {
		expect(validationQuarantine.getByIntegration("nonexistent")).toEqual([]);
	});

	it("enforces per-integration cap of 50", () => {
		for (let i = 0; i < 55; i++) {
			validationQuarantine.push(makeItem("plex", "sessions", i));
		}

		const items = validationQuarantine.getByIntegration("plex");
		expect(items).toHaveLength(50);
		// Oldest (0-4) should have been evicted, newest (5-54) retained
		expect(items[0]!.errors[0]).toContain("field_5");
		expect(items[49]!.errors[0]).toContain("field_54");
		expect(validationQuarantine.count).toBe(50);
	});

	it("enforces global cap of 250", () => {
		// Fill 5 integrations with 55 each = 250 after per-integration caps
		// Each integration capped at 50, so 5 * 50 = 250
		for (let i = 0; i < 5; i++) {
			for (let j = 0; j < 55; j++) {
				validationQuarantine.push(makeItem(`int-${i}`, "cat", j));
			}
		}
		expect(validationQuarantine.count).toBe(250);

		// Add one more to a 6th integration — should evict oldest globally
		validationQuarantine.push(makeItem("int-5", "cat", 0));
		expect(validationQuarantine.count).toBe(250);
	});

	it("clear removes all items", () => {
		validationQuarantine.push(makeItem("plex", "sessions"));
		validationQuarantine.push(makeItem("seerr", "getRequests"));

		validationQuarantine.clear();

		expect(validationQuarantine.count).toBe(0);
		expect(validationQuarantine.getByIntegration("plex")).toEqual([]);
	});

	it("clearIntegration removes only that integration", () => {
		validationQuarantine.push(makeItem("plex", "sessions"));
		validationQuarantine.push(makeItem("seerr", "getRequests"));

		validationQuarantine.clearIntegration("plex");

		expect(validationQuarantine.count).toBe(1);
		expect(validationQuarantine.getByIntegration("plex")).toEqual([]);
		expect(validationQuarantine.getByIntegration("seerr")).toHaveLength(1);
	});

	it("stores correct error details", () => {
		const item = {
			raw: { badField: 123 },
			errors: ["badField: Expected string, received number", "missingField: Required"],
			integration: "plex",
			category: "sessions",
			timestamp: new Date().toISOString(),
		};

		validationQuarantine.push(item);

		const stored = validationQuarantine.getByIntegration("plex")[0]!;
		expect(stored.raw).toEqual({ badField: 123 });
		expect(stored.errors).toHaveLength(2);
		expect(stored.errors[0]).toContain("Expected string");
		expect(stored.category).toBe("sessions");
	});
});
