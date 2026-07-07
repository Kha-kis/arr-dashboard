import { describe, expect, it } from "vitest";
import { describePredicate, humanizeKind } from "../describe-predicate";

describe("humanizeKind", () => {
	it("turns a snake_case kind into a readable label", () => {
		expect(humanizeKind("plex_last_watched")).toBe("Plex last watched");
		expect(humanizeKind("age")).toBe("Age");
	});
});

describe("describePredicate — generic kinds", () => {
	it("shows the operator first, then the values", () => {
		const result = describePredicate(
			{ kind: "age", params: { operator: "older_than", days: 30 } },
			false,
		);
		expect(result.label).toBe("Age");
		expect(result.summary).toBe("older than · 30");
	});

	it("joins array values when not incognito", () => {
		const result = describePredicate(
			{ kind: "genre", params: { genres: ["Action", "Drama"] } },
			false,
		);
		expect(result.summary).toBe("Action, Drama");
	});

	// Fix (a): multi-value kinds get keyed summaries to remove ambiguity.
	it("keys each value when a kind has more than one value-bearing param", () => {
		const result = describePredicate(
			{ kind: "year_range", params: { operator: "between", yearFrom: 2020, yearTo: 2024 } },
			false,
		);
		// Not the ambiguous bare "2020 · 2024".
		expect(result.summary).toBe("between · year from 2020 · year to 2024");
	});

	it("keeps the clean value-only form for single-value kinds", () => {
		const result = describePredicate(
			{ kind: "year_range", params: { operator: "before", year: 2020 } },
			false,
		);
		expect(result.summary).toBe("before · 2020");
	});

	it("keys still show in incognito while values stay masked", () => {
		const result = describePredicate(
			{ kind: "file_path", params: { operator: "matches", pattern: "/mnt/x", field: "path" } },
			true,
		);
		// Two string values → keyed; keys structural (shown), values masked.
		expect(result.summary).toContain("pattern •••");
		expect(result.summary).toContain("field •••");
		expect(result.summary).not.toContain("/mnt/x");
	});
});

describe("describePredicate — field_match (notifications)", () => {
	it("uses the matched field as the label", () => {
		const result = describePredicate(
			{
				kind: "field_match",
				params: { field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
			},
			false,
		);
		expect(result.label).toBe("eventType");
		expect(result.summary).toBe("equals HUNT_COMPLETED");
	});
});

describe("describePredicate — incognito masking", () => {
	it("masks string values but keeps numbers and the operator", () => {
		const result = describePredicate(
			{ kind: "plex_label", params: { operator: "any_of", labels: ["Favorites"] } },
			true,
		);
		// operator shown (structural), label array masked
		expect(result.summary).toContain("any of");
		expect(result.summary).toContain("•••");
		expect(result.summary).not.toContain("Favorites");
	});

	it("keeps numeric thresholds visible in incognito (structure, not data)", () => {
		const result = describePredicate(
			{ kind: "age", params: { operator: "older_than", days: 30 } },
			true,
		);
		expect(result.summary).toBe("older than · 30");
	});

	it("masks a free-text field_match value in incognito", () => {
		const result = describePredicate(
			{ kind: "field_match", params: { field: "username", operator: "equals", value: "alice" } },
			true,
		);
		expect(result.summary).toContain("equals");
		expect(result.summary).not.toContain("alice");
		expect(result.summary).toContain("•••");
	});
});
