import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/api-client/base";
import { getPartialDeploymentConflict, isSyncExecutionConflict } from "./sync-validation-utils";

describe("isSyncExecutionConflict", () => {
	it("refreshes validation only for stale-state conflicts", () => {
		expect(isSyncExecutionConflict(new ApiError("stale", 409))).toBe(true);
		expect(isSyncExecutionConflict(new ApiError("bad request", 400))).toBe(false);
		expect(isSyncExecutionConflict(new Error("409 in an unrelated message"))).toBe(false);
	});

	it("extracts a typed partial deployment from a conflict payload", () => {
		const partial = getPartialDeploymentConflict(
			new ApiError("stale", 409, {
				details: {
					partialDeployment: {
						created: 1,
						updated: 2,
						skipped: 3,
						details: {
							created: ["Created CF"],
							updated: ["Updated CF"],
							failed: ["Failed CF"],
						},
						qualityProfile: {
							action: "updated",
							profileId: 7,
							profileName: "Any",
						},
					},
				},
			}),
		);

		expect(partial).toEqual({
			created: 1,
			updated: 2,
			skipped: 3,
			details: {
				created: ["Created CF"],
				updated: ["Updated CF"],
				failed: ["Failed CF"],
			},
			qualityProfile: { action: "updated", profileId: 7, profileName: "Any" },
		});
	});
});
