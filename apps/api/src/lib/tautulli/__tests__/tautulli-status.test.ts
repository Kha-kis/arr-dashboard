import { describe, expect, it } from "vitest";
import { projectTautulliCacheStatus } from "../tautulli-status.js";

const status = {
	lastResult: "success",
	lastRefreshedAt: new Date("2026-08-27T12:00:00Z"),
	lastAttemptAt: new Date("2026-08-27T13:00:00Z"),
	lastAttemptResult: "error",
	lastAttemptErrorMessage:
		"https://tautulli.example/api?apikey=secret rating_key=123 title=Sensitive",
	lastErrorMessage: null,
	generationId: "generation-1",
	generationMetadata: null,
	itemCount: 4,
	connectionGeneration: 4,
	identityGeneration: 2,
};

describe("Tautulli status projection", () => {
	it("redacts legacy and unknown free-form attempt text", () => {
		const projected = projectTautulliCacheStatus(status, 4);
		expect(projected).toMatchObject({
			cachedItems: 4,
			hasCacheData: true,
			publicationState: "last-known",
			attempt: { result: "error", reasonCode: "legacy_error_redacted" },
		});
		expect(JSON.stringify(projected)).not.toMatch(
			/tautulli\.example|apikey|rating_key|Sensitive|123/,
		);
	});

	it("exposes only allowlisted current reason codes and normalized in-progress state", () => {
		expect(
			projectTautulliCacheStatus(
				{ ...status, lastAttemptResult: "in_progress:opaque-token", lastAttemptErrorMessage: null },
				4,
			),
		).toMatchObject({ attempt: { result: "in_progress", reasonCode: null } });
		expect(
			projectTautulliCacheStatus({ ...status, lastAttemptErrorMessage: "catalog_changed" }, 4),
		).toMatchObject({ attempt: { result: "error", reasonCode: "catalog_changed" } });
	});

	it("does not report mismatched physical rows as current", () => {
		expect(
			projectTautulliCacheStatus(
				{
					...status,
					lastAttemptAt: status.lastRefreshedAt,
					lastAttemptResult: "success",
					lastAttemptErrorMessage: null,
				},
				3,
			),
		).toMatchObject({
			publicationState: "unavailable",
			cachedItems: 3,
			reasonCode: "publication_integrity_mismatch",
		});
	});

	it("does not report a physically corrupt partial generation as last-known", () => {
		expect(
			projectTautulliCacheStatus(
				{
					...status,
					lastResult: "partial",
					lastAttemptResult: "partial",
					lastAttemptErrorMessage: "metadata_tmdb_unmapped",
				},
				4,
				false,
			),
		).toMatchObject({
			publicationState: "unavailable",
			reasonCode: "publication_integrity_mismatch",
		});
	});

	it.each([
		["physical count", status, -0],
		["status item count", { ...status, itemCount: -0 }, 4],
		["connection generation", { ...status, connectionGeneration: -0 }, 4],
		["identity generation", { ...status, identityGeneration: -0 }, 4],
	] as const)("fails closed without exposing negative-zero %s", (_label, value, physicalCount) => {
		const projected = projectTautulliCacheStatus(value, physicalCount);

		expect(projected).toMatchObject({
			publicationState: "unavailable",
			reasonCode: "publication_integrity_mismatch",
		});
		expect(Object.is(projected.cachedItems, -0)).toBe(false);
		expect(
			Object.values(projected).some((entry) => typeof entry === "number" && Object.is(entry, -0)),
		).toBe(false);
	});
});
