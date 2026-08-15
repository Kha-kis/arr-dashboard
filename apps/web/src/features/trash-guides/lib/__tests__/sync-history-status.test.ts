import { describe, expect, it } from "vitest";
import { getSyncHistoryStatusLabel } from "../sync-history-status";

describe("getSyncHistoryStatusLabel", () => {
	it("labels persisted uncertainty as needing operator review", () => {
		expect(getSyncHistoryStatusLabel("UNCERTAIN")).toBe("NEEDS REVIEW");
	});
});
