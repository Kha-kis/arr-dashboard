import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/api-client/base";
import { isSyncExecutionConflict } from "./sync-validation-utils";

describe("isSyncExecutionConflict", () => {
	it("refreshes validation only for stale-state conflicts", () => {
		expect(isSyncExecutionConflict(new ApiError("stale", 409))).toBe(true);
		expect(isSyncExecutionConflict(new ApiError("bad request", 400))).toBe(false);
		expect(isSyncExecutionConflict(new Error("409 in an unrelated message"))).toBe(false);
	});
});
