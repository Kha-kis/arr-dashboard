import { describe, expect, it, vi } from "vitest";
import {
	getPublishedEpisodeGenerationObservation,
	loadInstanceEpisodeEvidence,
	loadInstanceEvidence,
	loadInstanceMutationEvidence,
	loadInstanceSelectedEvidence,
	loadUserEvidence,
} from "../plex-evidence-repository.js";

const now = new Date("2026-08-20T14:00:00.000Z");
const sections = [{ key: "movies", title: "Movies", type: "movie" as const }];

function instance(overrides: Record<string, unknown> = {}) {
	return {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		enabled: true,
		label: "Primary Plex",
		connectionGeneration: 4,
		identityGeneration: 9,
		identityStatus: "VERIFIED",
		expectedIdentity: "machine-1",
		identityKind: "plex-machine-identifier",
		identityVerifiedAt: new Date("2026-08-20T10:00:00.000Z"),
		updatedAt: new Date("2026-08-20T10:00:00.000Z"),
		...overrides,
	};
}

function status(overrides: Record<string, unknown> = {}) {
	return {
		id: "status-1",
		instanceId: "plex-1",
		cacheType: "plex",
		lastRefreshedAt: new Date("2026-08-20T12:00:00.000Z"),
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: 1,
		generationId: "generation-1",
		generationMetadata: JSON.stringify({ sections }),
		lastAttemptAt: new Date("2026-08-20T12:00:00.000Z"),
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "row-1",
		instanceId: "plex-1",
		tmdbId: 42,
		mediaType: "movie",
		sectionId: "movies",
		sectionTitle: "Movies",
		title: "Example",
		ratingKey: "rating-42",
		lastWatchedAt: null,
		watchCount: 0,
		watchedByUsers: "[]",
		onDeck: false,
		userRating: null,
		collections: "[]",
		labels: "[]",
		addedAt: null,
		thumb: null,
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function episodeStatus(overrides: Record<string, unknown> = {}) {
	return {
		...status(),
		id: "episode-status-1",
		cacheType: "plex_episode",
		generationId: "episode-generation-1",
		generationMetadata: JSON.stringify({
			version: 1,
			parentPlexGenerationId: "generation-1",
			parentPublicationLevel: "authoritative",
			connectionGeneration: 4,
			identityGeneration: 9,
		}),
		...overrides,
	};
}

function episodeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "episode-row-1",
		instanceId: "plex-1",
		showTmdbId: 42,
		seasonNumber: 1,
		episodeNumber: 1,
		ratingKey: "episode-1",
		title: "Pilot",
		watched: false,
		watchedByUsers: "[]",
		lastWatchedAt: null,
		watchCount: 0,
		refreshedAt: new Date("2026-08-20T12:00:00.000Z"),
		sourceFingerprint: "source-1",
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function fixture(
	options: {
		instance?: ReturnType<typeof instance> | null;
		statuses?: Array<ReturnType<typeof status> | null>;
		rows?: ReturnType<typeof row>[];
		rowError?: Error;
	} = {},
) {
	const events: string[] = [];
	const statuses = options.statuses ?? [status(), status()];
	const findFirst = vi.fn(async (_args: unknown) => {
		events.push("instance");
		return options.instance === undefined ? instance() : options.instance;
	});
	const findManyStatus = vi.fn(async () => {
		events.push("status");
		const next = statuses.shift() ?? null;
		return next ? [next] : [];
	});
	const findMany = vi.fn(async () => {
		events.push("rows");
		if (options.rowError) throw options.rowError;
		return options.rows ?? [row()];
	});
	return {
		events,
		findFirst,
		prisma: {
			serviceInstance: { findFirst, findMany: vi.fn().mockResolvedValue([]) },
			cacheRefreshStatus: { findMany: findManyStatus },
			plexCache: { findMany },
		},
	};
}

async function load(testFixture: ReturnType<typeof fixture>) {
	return loadInstanceEvidence(testFixture.prisma as never, {
		userId: "user-1",
		instanceId: "plex-1",
		now,
		maxAgeMs: 3 * 60 * 60 * 1000,
	});
}

async function loadMutation(testFixture: ReturnType<typeof fixture>) {
	return loadInstanceMutationEvidence(testFixture.prisma as never, {
		userId: "user-1",
		instanceId: "plex-1",
		now,
		maxAgeMs: 3 * 60 * 60 * 1000,
	});
}

describe("Plex evidence repository", () => {
	it("reads status before and after rows and returns source-bound authoritative evidence", async () => {
		const testFixture = fixture();

		const result = await load(testFixture);

		expect(testFixture.events).toEqual(["instance", "status", "rows", "status"]);
		expect(result).toMatchObject({
			available: true,
			instanceId: "plex-1",
			generationId: "generation-1",
			connectionGeneration: 4,
			identityGeneration: 9,
			rows: [{ id: "row-1", tmdbId: 42 }],
			evidence: {
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		});
	});

	it.each([
		["generation change", status({ generationId: "generation-2" }), "generation_changed"],
		[
			"published timestamp change",
			status({ lastRefreshedAt: new Date("2026-08-20T12:01:00.000Z") }),
			"published_timestamp_changed",
		],
	])("fails closed for a %s during the read", async (_name, after, reasonCode) => {
		const result = await load(fixture({ statuses: [status(), after] }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: [reasonCode] },
		});
	});

	it("fails closed when the status item count does not match rows", async () => {
		const result = await load(
			fixture({ statuses: [status({ itemCount: 2 }), status({ itemCount: 2 })] }),
		);
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["row_count_mismatch"] },
		});
	});

	it.each([
		["row connection", row({ connectionGeneration: 5 }), "connection_generation_mismatch"],
		["row identity", row({ identityGeneration: 10 }), "identity_generation_mismatch"],
	])("fails closed for a %s mismatch", async (_name, changedRow, reasonCode) => {
		const result = await load(fixture({ rows: [changedRow] }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: [reasonCode] },
		});
	});

	it.each([
		["status connection", status({ connectionGeneration: 5 }), "connection_generation_mismatch"],
		["status identity", status({ identityGeneration: 10 }), "identity_generation_mismatch"],
	])("fails closed for a %s mismatch", async (_name, changedStatus, reasonCode) => {
		const result = await load(fixture({ statuses: [changedStatus] }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: [reasonCode] },
		});
	});

	it.each([
		["missing status", null, "missing_status"],
		["missing generation id", status({ generationId: null }), "missing_generation_id"],
		["null metadata", status({ generationMetadata: null }), "missing_metadata"],
		["malformed metadata", status({ generationMetadata: "{" }), "malformed_metadata"],
		[
			"unknown metadata",
			status({ generationMetadata: JSON.stringify({ version: 99, sections }) }),
			"unknown_metadata_version",
		],
	])("fails closed for %s", async (_name, before, reasonCode) => {
		const result = await load(fixture({ statuses: [before] }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: [reasonCode] },
		});
	});

	it("loads valid V2 authoritative metadata", async () => {
		const generationMetadata = JSON.stringify({
			version: 2,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: 1,
			sections,
		});
		const result = await load(
			fixture({
				statuses: [status({ generationMetadata }), status({ generationMetadata })],
			}),
		);
		expect(result).toMatchObject({ available: true, metadata: { version: 2 } });
	});

	it("retains an earlier authoritative generation after the latest attempt fails", async () => {
		const failedAttempt = {
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "offline",
		};
		const result = await load(
			fixture({ statuses: [status(failedAttempt), status(failedAttempt)] }),
		);
		expect(result).toMatchObject({
			available: true,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["latest_attempt_failed"],
				publishedGeneration: { publicationLevel: "authoritative" },
			},
		});
		const mutation = await loadMutation(
			fixture({ statuses: [status(failedAttempt), status(failedAttempt)] }),
		);
		expect(mutation).toMatchObject({
			available: false,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				reasonCodes: ["latest_attempt_failed"],
				publishedGeneration: { publicationLevel: "authoritative" },
			},
		});
	});

	it("preserves the normalized in-progress reason when mutation authority is withheld", async () => {
		const inProgress = { lastAttemptResult: "in_progress:opaque-token" };
		const mutation = await loadMutation(
			fixture({ statuses: [status(inProgress), status(inProgress)] }),
		);

		expect(mutation).toMatchObject({
			available: false,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "in_progress",
				reasonCodes: ["latest_attempt_in_progress"],
				publishedGeneration: { publicationLevel: "authoritative" },
			},
		});
		expect(JSON.stringify(mutation)).not.toContain("opaque-token");
	});

	it.each([
		["valid authoritative / success / fresh", status(), true, "current", "authoritative", true],
		[
			"valid authoritative / missing attempt result / fresh",
			status({ lastAttemptResult: null }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / missing attempt timestamp / fresh",
			status({ lastAttemptAt: null }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / future attempt timestamp / fresh",
			status({ lastAttemptAt: new Date("2026-08-20T14:00:01.000Z") }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / error / fresh",
			status({ lastAttemptResult: "error", lastAttemptErrorMessage: "inventory changed" }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / error message / fresh",
			status({ lastAttemptResult: "success", lastAttemptErrorMessage: "inventory changed" }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / unknown result / fresh",
			status({ lastAttemptResult: "unknown" }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / future partial / fresh",
			status({ lastAttemptResult: "partial" }),
			true,
			"last-known",
			"unavailable",
			false,
		],
		[
			"valid authoritative / success / stale",
			status({ lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") }),
			false,
			"unavailable",
			"unavailable",
			false,
		],
		[
			"valid authoritative / success / future-dated",
			status({ lastRefreshedAt: new Date("2026-08-20T14:00:01.000Z") }),
			false,
			"unavailable",
			"unavailable",
			false,
		],
		[
			"missing generation / success / fresh",
			status({ generationId: null }),
			false,
			"unavailable",
			"unavailable",
			false,
		],
		[
			"malformed metadata / success / fresh",
			status({ generationMetadata: "{" }),
			false,
			"unavailable",
			"unavailable",
			false,
		],
		[
			"subsequent authoritative refresh / success / fresh",
			status(),
			true,
			"current",
			"authoritative",
			true,
		],
	] as const)(
		"applies the latest-attempt matrix for %s",
		async (_caseName, matrixStatus, observationAvailable, availability, authority, mutationAvailable) => {
			const observation = await load(
				fixture({ statuses: [{ ...matrixStatus }, { ...matrixStatus }] }),
			);
			const mutation = await loadMutation(
				fixture({ statuses: [{ ...matrixStatus }, { ...matrixStatus }] }),
			);

			expect(observation.available).toBe(observationAvailable);
			expect(observation.evidence).toMatchObject({ availability, authority });
			expect(mutation.available).toBe(mutationAvailable);
		},
	);

	it("rejects a stale published generation", async () => {
		const stale = { lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") };
		const result = await load(fixture({ statuses: [status(stale), status(stale)] }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["published_generation_stale"] },
		});
	});

	it("applies the default freshness bound when the caller omits maxAgeMs", async () => {
		const stale = { lastRefreshedAt: new Date("2026-08-18T08:00:00.000Z") };
		const repository = fixture({ statuses: [status(stale), status(stale)] });
		const result = await loadInstanceEvidence(repository.prisma as never, {
			userId: "user-1",
			instanceId: "plex-1",
			now,
		});
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["published_generation_stale"] },
		});
	});

	it("loads only target-selected rows while validating the full generation count", async () => {
		const findMany = vi.fn(async () => [row()]);
		const repository = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance()) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([status()]) },
			plexCache: {
				findMany,
				count: vi.fn().mockResolvedValue(1),
			},
		};
		const result = await loadInstanceSelectedEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			selection: { kind: "targets", targets: [{ tmdbId: 42, mediaType: "movie" }] },
			now,
		});

		expect(result).toMatchObject({ available: true, itemCount: 1, rows: [{ tmdbId: 42 }] });
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					instanceId: "plex-1",
					OR: [{ tmdbId: 42, mediaType: "movie" }],
				},
			}),
		);
	});

	it("fails closed for a disabled instance", async () => {
		const result = await load(fixture({ instance: instance({ enabled: false }) }));
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["disabled_instance"] },
		});
	});

	it("keeps an authoritative empty generation distinct from unavailable", async () => {
		const emptyStatus = status({ itemCount: 0, generationMetadata: JSON.stringify({ sections }) });
		const result = await load(fixture({ rows: [], statuses: [emptyStatus, { ...emptyStatus }] }));
		expect(result).toMatchObject({ available: true, rows: [], itemCount: 0 });
	});

	it("returns unavailable instead of a synthesized empty snapshot on query failure", async () => {
		const result = await load(fixture({ rowError: new Error("database unavailable") }));
		expect(result).toEqual({
			available: false,
			evidence: {
				availability: "unavailable",
				authority: "unavailable",
				attemptState: "unknown",
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["query_failed"],
			},
		});
	});

	it("keeps the user ownership predicate in the instance query", async () => {
		const testFixture = fixture();
		await load(testFixture);
		expect(testFixture.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "plex-1", userId: "user-1", service: "PLEX" },
			}),
		);
	});

	it("returns separately source-bound evidence for multiple user instances", async () => {
		const first = instance();
		const second = instance({
			id: "plex-2",
			label: "Secondary Plex",
			connectionGeneration: 7,
			identityGeneration: 12,
		});
		const repository = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([first, second]),
				findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
					where.id === "plex-1" ? first : second,
				),
			},
			cacheRefreshStatus: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) => {
					const instanceId = where.instanceId;
					return [
						status({
							instanceId,
							generationId: `generation-${instanceId}`,
							connectionGeneration: instanceId === "plex-1" ? 4 : 7,
							identityGeneration: instanceId === "plex-1" ? 9 : 12,
						}),
					];
				}),
			},
			plexCache: {
				findMany: vi.fn(async ({ where }: { where: { instanceId: string } }) => [
					row({
						id: `row-${where.instanceId}`,
						instanceId: where.instanceId,
						connectionGeneration: where.instanceId === "plex-1" ? 4 : 7,
						identityGeneration: where.instanceId === "plex-1" ? 9 : 12,
					}),
				]),
			},
		};

		const result = await loadUserEvidence(repository as never, {
			userId: "user-1",
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});

		expect(result.every((entry) => entry.available)).toBe(true);
		expect(result.flatMap((entry) => (entry.available ? [entry.instanceId] : []))).toEqual([
			"plex-1",
			"plex-2",
		]);
	});

	it.each([
		["successful latest authoritative attempt", true, fixture()],
		[
			"failed latest attempt",
			false,
			fixture({
				statuses: [
					status({ lastAttemptResult: "error", lastAttemptErrorMessage: "failed" }),
					status({ lastAttemptResult: "error", lastAttemptErrorMessage: "failed" }),
				],
			}),
		],
		[
			"stale generation",
			false,
			fixture({
				statuses: [
					status({ lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") }),
					status({ lastRefreshedAt: new Date("2026-08-20T08:00:00.000Z") }),
				],
			}),
		],
		[
			"malformed metadata",
			false,
			fixture({
				statuses: [status({ generationMetadata: "{" }), status({ generationMetadata: "{" })],
			}),
		],
		["missing status", false, fixture({ statuses: [null] })],
		[
			"row-count mismatch",
			false,
			fixture({ statuses: [status({ itemCount: 2 }), status({ itemCount: 2 })] }),
		],
		["identity-generation mismatch", false, fixture({ rows: [row({ identityGeneration: 10 })] })],
		[
			"connection-generation mismatch",
			false,
			fixture({ rows: [row({ connectionGeneration: 5 })] }),
		],
	] as const)(
		"does not broaden current-main mutation authority for %s",
		async (_caseName, currentMainAuthorizes, repository) => {
			const result = await loadMutation(repository);
			const pr1Authorizes = result.available;

			expect(pr1Authorizes).toBe(currentMainAuthorizes);
			expect(pr1Authorizes && !currentMainAuthorizes).toBe(false);
		},
	);
});

describe("Plex episode evidence repository", () => {
	function episodeFixture(
		input: {
			parentStatus?: ReturnType<typeof status>;
			episode?: ReturnType<typeof episodeStatus>;
			parentCount?: number;
			episodeRows?: ReturnType<typeof episodeRow>[];
		} = {},
	) {
		const parent = input.parentStatus ?? status();
		const episode = input.episode ?? episodeStatus();
		return {
			serviceInstance: { findFirst: vi.fn(), findMany: vi.fn() },
			cacheRefreshStatus: {
				findMany: vi.fn(async ({ where }: { where: { cacheType: string } }) => [
					where.cacheType === "plex" ? parent : episode,
				]),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(input.parentCount ?? 1),
				findMany: vi.fn(),
			},
			plexEpisodeCache: {
				count: vi.fn().mockResolvedValue(input.episodeRows?.length ?? 1),
				findMany: vi.fn().mockResolvedValue(input.episodeRows ?? [episodeRow()]),
			},
		};
	}

	async function loadEpisode(repository: ReturnType<typeof episodeFixture>) {
		return loadInstanceEpisodeEvidence(repository as never, {
			userId: "user-1",
			instanceId: "plex-1",
			instance: instance(),
			now,
			maxAgeMs: 3 * 60 * 60 * 1000,
		});
	}

	it("loads rows only when the episode generation is bound to the authoritative parent", async () => {
		const result = await loadEpisode(episodeFixture());

		expect(result).toMatchObject({
			available: true,
			generationId: "episode-generation-1",
			parentGenerationId: "generation-1",
			rows: [{ id: "episode-row-1" }],
			evidence: { publicationLevel: "authoritative", completeness: "complete" },
		});
	});

	it("fails closed when episode metadata names a different parent generation", async () => {
		const result = await loadEpisode(
			episodeFixture({
				episode: episodeStatus({
					generationMetadata: JSON.stringify({
						version: 1,
						parentPlexGenerationId: "other-parent",
						parentPublicationLevel: "authoritative",
						connectionGeneration: 4,
						identityGeneration: 9,
					}),
				}),
			}),
		);

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["parent_generation_unavailable"] },
		});
	});

	it("keeps a genuinely authoritative empty parent and empty episode generation distinct", async () => {
		const emptyParent = status({ itemCount: 0 });
		const emptyEpisode = episodeStatus({ itemCount: 0 });
		const result = await loadEpisode(
			episodeFixture({
				parentStatus: emptyParent,
				episode: emptyEpisode,
				parentCount: 0,
				episodeRows: [],
			}),
		);

		expect(result).toMatchObject({ available: true, rows: [] });
	});

	it("preserves the parent publication but reports a later failed episode attempt", async () => {
		const failedAttempt = {
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "offline",
		};
		const result = await loadEpisode(episodeFixture({ episode: episodeStatus(failedAttempt) }));

		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["latest_attempt_failed"] },
		});
	});

	it.each([
		["error", "error", "latest_attempt_failed"],
		["in_progress:opaque-token", "in_progress", "latest_attempt_in_progress"],
	] as const)(
		"keeps a historical episode publication separate from a %s latest attempt",
		async (lastAttemptResult, attemptState, reasonCode) => {
			const repository = episodeFixture({
				episode: episodeStatus({
					lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
					lastAttemptResult,
					lastAttemptErrorMessage: lastAttemptResult === "error" ? "offline" : null,
				}),
			});
			const result = await getPublishedEpisodeGenerationObservation(repository as never, {
				userId: "user-1",
				instanceId: "plex-1",
				instance: instance(),
				now,
				maxAgeMs: 3 * 60 * 60 * 1000,
			});

			expect(result).toMatchObject({
				available: true,
				evidence: {
					availability: "last-known",
					authority: "unavailable",
					attemptState,
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: [reasonCode],
					publishedGeneration: { publicationLevel: "authoritative" },
				},
			});
			expect(JSON.stringify(result.evidence)).not.toContain("opaque-token");
		},
	);

	it("withholds episode evidence when the parent latest attempt failed", async () => {
		const failedAttempt = {
			lastAttemptAt: new Date("2026-08-20T13:00:00.000Z"),
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "parent refresh failed",
		};
		const result = await loadEpisode(episodeFixture({ parentStatus: status(failedAttempt) }));

		expect(result).toMatchObject({
			available: false,
			evidence: {
				availability: "last-known",
				authority: "unavailable",
				attemptState: "error",
				reasonCodes: ["latest_attempt_failed"],
			},
		});
	});
});
