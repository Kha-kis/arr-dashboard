import { describe, expect, it } from "vitest";
import * as contracts from "../manual-import.js";

const review = {
	operation: {
		operationId: "original",
		state: "failed",
		reason: "evidence-unavailable",
		selectedFileCount: 1,
		verifiedFileCount: 0,
		canConsiderNewAttempt: true,
	},
	importMode: "move",
	sourceFileCount: 1,
	sourceVerifiedFileCount: 0,
	verifiedEpisodeCount: 1,
	unavailableFileCount: 0,
	candidates: [
		{
			id: 1,
			service: "sonarr",
			path: "/synthetic/file",
			downloadId: "source",
			series: { id: 12 },
			episodes: [{ id: 14 }],
		},
	],
};

describe("explicit remaining-file review contract", () => {
	it("retains the explicit predecessor in a new keyed public request", () => {
		const payload = {
			instanceId: "instance",
			service: "sonarr",
			importMode: "copy",
			idempotencyKey: "new-intention",
			remainderOf: "original",
			files: [{ path: "/synthetic/file", downloadId: "source", seriesId: 12, episodeIds: [14] }],
		};
		expect(contracts.manualImportSubmissionSchema.parse(payload)).toEqual(payload);
	});
	it.each(["", " original ", "x".repeat(129)])("rejects an invalid predecessor", (remainderOf) => {
		expect(
			contracts.manualImportSubmissionSchema.safeParse({
				instanceId: "instance",
				service: "radarr",
				idempotencyKey: "new",
				remainderOf,
				files: [{ path: "/synthetic/file", downloadId: "source", movieId: 12 }],
			}).success,
		).toBe(false);
	});
	it("rejects a remainder action without its explicit attempt key", () => {
		expect(
			contracts.manualImportSubmissionSchema.safeParse({
				instanceId: "instance",
				service: "radarr",
				remainderOf: "original",
				files: [{ path: "/synthetic/file", downloadId: "source", movieId: 12 }],
			}).success,
		).toBe(false);
	});
	it("preserves truthful source counts and remaining episode candidates", () => {
		expect(contracts.manualImportRemainderReviewSchema.parse(review)).toEqual(review);
	});
	it.each([
		{ ...review, sourceFileCount: 2 },
		{ ...review, unavailableFileCount: 1 },
		{ ...review, sourceVerifiedFileCount: 1 },
		{ ...review, verifiedEpisodeCount: -1 },
		{ ...review, verifiedEpisodeCount: 10001 },
		{ ...review, importMode: "auto" },
		{ ...review, permissionToImport: true },
	])("rejects inconsistent or authority-bearing review data", (value) => {
		expect(contracts.manualImportRemainderReviewSchema.safeParse(value).success).toBe(false);
	});
	it("represents missing original targets without fabricating completion", () => {
		const unavailable = { ...review, candidates: [], unavailableFileCount: 1 };
		expect(contracts.manualImportRemainderReviewSchema.parse(unavailable)).toEqual(unavailable);
	});
	it.each(["", " foreign ", "x".repeat(129)])(
		"rejects an invalid operation reference",
		(operationId) => {
			expect(contracts.manualImportRemainderParamsSchema.safeParse({ operationId }).success).toBe(
				false,
			);
		},
	);
});
