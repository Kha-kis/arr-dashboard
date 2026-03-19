/**
 * Account Deduplication Tests
 *
 * Tests for the pure deduplicateAccounts helper that deduplicates
 * and sorts Plex user account names from aggregated instance results.
 *
 * Run with: npx vitest run account-helpers.test.ts
 */

import { describe, expect, it } from "vitest";
import { deduplicateAccounts } from "../lib/account-helpers.js";

describe("deduplicateAccounts", () => {
	it("deduplicates repeated account names", () => {
		const result = deduplicateAccounts(["alice", "bob", "alice", "bob", "alice"]);
		expect(result).toEqual(["alice", "bob"]);
	});

	it("sorts results alphabetically", () => {
		const result = deduplicateAccounts(["charlie", "alice", "bob"]);
		expect(result).toEqual(["alice", "bob", "charlie"]);
	});

	it("filters out non-string values from aggregated array", () => {
		const result = deduplicateAccounts(["alice", 42, null, undefined, true, "bob", { name: "eve" }]);
		expect(result).toEqual(["alice", "bob"]);
	});

	it("returns empty array for empty input", () => {
		const result = deduplicateAccounts([]);
		expect(result).toEqual([]);
	});

	it("handles single account name", () => {
		const result = deduplicateAccounts(["alice"]);
		expect(result).toEqual(["alice"]);
	});
});
