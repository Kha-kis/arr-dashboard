/**
 * Regression test for v2.15.1 — operator-facing Pulse collector error
 * messages must not leak internal function names like `collectArrSignals`.
 *
 * `labelForCollector` is the pure helper that translates a collector's
 * function name into plain-English copy for the failure `detail` string.
 */

import { describe, expect, it } from "vitest";
import { labelForCollector } from "../pulse.js";

describe("labelForCollector", () => {
	it("returns the operator label for every known collector", () => {
		const knownPairs: Array<[string, string]> = [
			["collectArrSignals", "ARR health and disk space"],
			["collectSeerrCircuitBreaker", "Seerr circuit breaker"],
			["collectCacheStaleness", "cache freshness"],
			["collectValidationHealth", "validation health"],
			["collectLibraryInsightCounts", "library insights"],
			["collectHuntFailures", "hunt failures"],
			["collectQueueCleanerFailures", "queue cleaner"],
			["collectTrashSyncFailures", "TRaSH sync"],
			["collectCleanupOpportunities", "cleanup opportunities"],
		];

		for (const [name, expected] of knownPairs) {
			expect(labelForCollector(name)).toBe(expected);
		}
	});

	it("humanizes unknown camelCase names instead of leaking them", () => {
		// A future collector that wasn't added to the label map still gets
		// a readable label — the operator copy never contains raw source names.
		expect(labelForCollector("collectFooBar")).toBe("foo bar");
		expect(labelForCollector("collectSomethingNew")).toBe("something new");
	});

	it("falls back to a safe label when the function name is empty", () => {
		// Defensive: `collector.name` can be empty for anonymous functions.
		// We still must not render an empty sentence fragment.
		expect(labelForCollector("")).toBe("signal");
	});
});
