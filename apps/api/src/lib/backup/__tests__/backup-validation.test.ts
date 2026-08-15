import { describe, expect, it } from "vitest";
import { isNonterminalRollback } from "../backup-validation.js";

describe("isNonterminalRollback", () => {
	it("treats an exact backup-less manual resolution as terminal", () => {
		expect(
			isNonterminalRollback({
				status: "FAILED",
				backupId: null,
				rolledBack: false,
				rollbackStatus: "MANUALLY_RESOLVED",
			}),
		).toBe(false);
	});

	it("keeps malformed manual-resolution markers nonterminal", () => {
		expect(
			isNonterminalRollback({
				status: "SUCCESS",
				backupId: null,
				rolledBack: false,
				rollbackStatus: "MANUALLY_RESOLVED",
			}),
		).toBe(true);
	});
});
