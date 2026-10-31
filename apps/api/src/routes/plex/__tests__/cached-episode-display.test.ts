import type { PlexEvidenceSummary } from "@arr/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AvailablePlexEpisodeEvidence,
	AvailablePositivePlexEpisodeEvidence,
	AvailableSelectedPlexEvidence,
	SelectedPlexEpisodeEvidence,
} from "../../../lib/plex/plex-evidence-repository.js";
import { createPositivePlexEpisodeDigest } from "../../../lib/plex/plex-episode-live-collector.js";
import {
	decodePlexGenerationMetadata,
	encodeAuthoritativePlexGenerationMetadata,
	projectPlexProviderObservationStatus,
} from "../../../lib/plex/plex-generation-metadata.js";
import { createPlexTargetLedgerBinding } from "../../../lib/plex/plex-generation-target-ledger.js";
import { plexConnectionFingerprint } from "../../../lib/plex/service-instance-fingerprint.js";
import { setupAuthInjection } from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	selected: vi.fn(),
	episodes: vi.fn(),
	positive: vi.fn(),
	client: vi.fn(),
}));
vi.mock("../../../lib/plex/plex-evidence-repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/plex/plex-evidence-repository.js")>()),
	loadInstanceSelectedEvidence: mocks.selected,
	loadInstanceSelectedEpisodeEvidence: mocks.episodes,
	loadPositiveEpisodeDisplayEvidence: mocks.positive,
}));
vi.mock("../../../lib/plex/plex-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/plex/plex-client.js")>()),
	createPlexClient: mocks.client,
}));

import { PlexAuthorityService } from "../../../lib/plex/plex-authority-service.js";
import { registerEpisodeRoutes } from "../episode-routes.js";
import { registerSeriesProgressRoutes } from "../series-progress-routes.js";

const userId = "synthetic-owner";
const instanceId = "synthetic-plex";
const current: PlexEvidenceSummary = {
	availability: "current",
	authority: "authoritative",
	attemptState: "success",
	publicationLevel: "authoritative",
	completeness: "complete",
	reasonCodes: [],
};

function fixture(id = instanceId) {
	const now = new Date(Date.now() - 1000);
	const at = now.toISOString();
	const instance = {
		id,
		userId,
		service: "PLEX",
		enabled: true,
		label: "Synthetic Plex",
		expectedIdentity: "synthetic-machine",
		identityKind: "PLEX_MACHINE_IDENTIFIER",
		identityStatus: "VERIFIED",
		identityVerifiedAt: now,
		connectionGeneration: 4,
		identityGeneration: 9,
		baseUrl: "http://synthetic.invalid",
		encryptedApiKey: "synthetic-key",
		encryptionIv: "synthetic-iv",
	};
	const section = {
		key: "shows",
		uuid: "shows-uuid",
		title: "Synthetic Shows",
		type: "show" as const,
		refreshing: false as const,
		scannedAt: 1777000000,
		updatedAt: 1777000100,
	};
	const target = {
		instanceId: id,
		generationId: "parent-generation",
		sectionId: section.key,
		sectionUuid: section.uuid,
		mediaType: "series" as const,
		tmdbId: 42,
		tvdbId: null,
		ratingKey: "101",
	};
	const binding = createPlexTargetLedgerBinding({
		instanceId: id,
		generationId: target.generationId,
		connectionGeneration: 4,
		identityGeneration: 9,
		targets: [target],
	});
	const unit = (scopeKey: string) => ({
		scopeKey,
		expectedRawCount: 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
	});
	const encoded = encodeAuthoritativePlexGenerationMetadata({
		sections: [section],
		itemCount: 1,
		canonicalizationVersion: 1,
		roots: [{ sectionKey: section.key, domain: "membership", digest: "a".repeat(64) }],
		targetLedger: binding,
		partialReasons: [],
		coverageReceipt: {
			version: 2,
			provider: "plex",
			attemptStartedAt: at,
			observedAt: at,
			evidence: "complete",
			units: [unit("plex:aggregate")],
			publishedCanonicalEntities: 1,
			domains: (
				["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"] as const
			).map((domain) => ({
				domain,
				evidence: "complete" as const,
				valueSemantics: "exact" as const,
				units: [unit(`plex:${domain}`)],
				...(domain === "mapping" || domain === "watch-count"
					? { publishedCanonicalEntities: 1 }
					: {}),
			})),
		},
	});
	const decoded = decodePlexGenerationMetadata(encoded);
	if (
		!decoded.ok ||
		decoded.metadata.version !== 6 ||
		decoded.metadata.publicationLevel !== "authoritative"
	)
		throw new Error("Invalid synthetic parent");
	const status = {
		instanceId: id,
		lastRefreshedAt: now,
		lastResult: "success",
		lastErrorMessage: null,
		lastAttemptAt: now,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		itemCount: 1,
		connectionGeneration: 4,
		identityGeneration: 9,
		generationId: target.generationId,
		generationMetadata: encoded,
	};
	const providerStatus = projectPlexProviderObservationStatus({
		status,
		metadata: decoded.metadata,
		now,
	});
	const parent: AvailableSelectedPlexEvidence = {
		available: true,
		instanceId: id,
		instanceName: instance.label,
		generationId: target.generationId,
		publishedAt: now,
		itemCount: 1,
		connectionGeneration: 4,
		identityGeneration: 9,
		metadata: decoded.metadata,
		generationStatus: status,
		sections: [section],
		rows: [],
		selection: { kind: "targets", targets: [{ mediaType: "series", tmdbId: 42 }] },
		evidence: current,
		providerStatus,
	};
	const row = {
		id: "episode-1",
		instanceId: id,
		showTmdbId: 42,
		seasonNumber: 1,
		episodeNumber: 1,
		ratingKey: "201",
		title: "Synthetic Pilot",
		watched: true,
		watchedByUsers: '["synthetic-viewer"]',
		lastWatchedAt: now,
		watchCount: 2,
		refreshedAt: now,
		sourceFingerprint: plexConnectionFingerprint(instance),
		connectionGeneration: 4,
		identityGeneration: 9,
	};
	const episodes: AvailablePlexEpisodeEvidence = {
		available: true,
		instanceId: id,
		generationId: "episode-generation",
		parentGenerationId: target.generationId,
		publishedAt: now,
		connectionGeneration: 4,
		identityGeneration: 9,
		rows: [
			row,
			{
				...row,
				id: "episode-2",
				episodeNumber: 2,
				ratingKey: "202",
				title: "Synthetic Second",
				watched: false,
				watchedByUsers: "[]",
				lastWatchedAt: null,
				watchCount: 0,
			},
		],
		generationStatus: { ...status, generationId: "episode-generation", itemCount: 2 },
		evidence: current,
		providerStatus,
	};
	const unavailable: SelectedPlexEpisodeEvidence = {
		available: false,
		instanceId: id,
		evidence: {
			availability: "unavailable",
			authority: "unavailable",
			attemptState: "unknown",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: ["missing_status"],
		},
		providerStatus,
	};
	const positiveUnit = { ...unit("plex:episodes"), expectedRawCount: null };
	const positive: AvailablePositivePlexEpisodeEvidence = {
		...episodes,
		rows: [row],
		parentMetadata: decoded.metadata,
		currentParent: {
			generationId: target.generationId,
			metadata: decoded.metadata,
			generationStatus: status,
		},
		metadata: {
			version: 6,
			publicationLevel: "positive-only",
			completeness: "partial",
			itemCount: 1,
			canonicalizationVersion: 1,
			capability: {
				domain: "episodes",
				field: "watchCount",
				semantics: "lower-bound",
				operator: "greater_than",
			},
			parentPlexGenerationId: target.generationId,
			parentMetadataVersion: 6,
			parentPublicationLevel: "authoritative",
			parentTargetDigest: binding.targetDigest,
			episodeDigest: createPositivePlexEpisodeDigest([{ ...target, showTmdbId: 42 }], [row]),
			partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
			connectionGeneration: 4,
			identityGeneration: 9,
			coverageReceipt: {
				version: 2,
				provider: "plex_episode",
				attemptStartedAt: at,
				observedAt: at,
				evidence: "positive-only",
				publishedCanonicalEntities: 1,
				units: [positiveUnit],
				domains: (["episode-inventory", "watch-count"] as const).map((domain) => ({
					domain,
					evidence: "positive-only" as const,
					valueSemantics: "lower-bound" as const,
					publishedCanonicalEntities: 1,
					units: [positiveUnit],
				})),
			},
			parentProof: {
				instanceId: id,
				generationId: target.generationId,
				connectionGeneration: 4,
				identityGeneration: 9,
				providerIdentity: instance.expectedIdentity,
				sourceFingerprint: row.sourceFingerprint,
				publishedAt: at,
				attemptedAt: at,
				attemptResult: "success",
				itemCount: 1,
				metadata: decoded.metadata,
				targets: [target],
			},
		},
		evidence: {
			availability: "last-known",
			authority: "unavailable",
			attemptState: "error",
			publicationLevel: "positive-only",
			completeness: "partial",
			reasonCodes: ["latest_attempt_failed"],
		},
	};
	positive.generationStatus = {
		...positive.generationStatus,
		itemCount: 1,
		generationMetadata: JSON.stringify(positive.metadata),
		lastAttemptAt: new Date(now.getTime() + 1),
		lastAttemptResult: "error",
		lastAttemptErrorMessage: "Synthetic denied refresh",
	};
	return { instance, parent, episodes, unavailable, positive, target };
}

let fixtures: ReturnType<typeof fixture>[];
let apps: FastifyInstance[];
let selectedResult: SelectedPlexEpisodeEvidence | undefined;
let afterRead: (() => void) | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	fixtures = [fixture()];
	apps = [];
	selectedResult = undefined;
	afterRead = undefined;
	mocks.selected.mockImplementation(async () => fixtures[0]!.parent);
	mocks.episodes.mockImplementation(async (_prisma, input) => {
		const source = fixtures.find((entry) => entry.instance.id === input.instanceId)!;
		const result = selectedResult ?? source.episodes;
		afterRead?.();
		return result;
	});
	mocks.positive.mockImplementation(
		async (_prisma, input) =>
			fixtures.find((entry) => entry.instance.id === input.instanceId)!.unavailable,
	);
	mocks.client.mockImplementation(() => ({
		getActivities: () => {
			throw new Error("Synthetic provider denied");
		},
	}));
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Real provider networking is forbidden");
		}),
	);
});
afterEach(async () => {
	await Promise.all(apps.map((app) => app.close()));
	vi.unstubAllGlobals();
});

async function appFor(owner = userId) {
	const app = Fastify({ logger: false });
	apps.push(app);
	setupAuthInjection(app, { id: owner, username: "synthetic-user" });
	app.decorate("prisma", {
		serviceInstance: {
			findFirst: vi.fn(
				async ({ where }) =>
					fixtures.find(
						({ instance }) =>
							instance.id === where.id &&
							instance.userId === where.userId &&
							instance.service === where.service &&
							(where.enabled === undefined || instance.enabled === where.enabled),
					)?.instance ?? null,
			),
			findMany: vi.fn(async ({ where }) =>
				fixtures
					.filter(({ instance }) => instance.userId === where.userId && instance.enabled)
					.map(({ instance }) => ({ id: instance.id })),
			),
		},
		plexGenerationTarget: {
			findMany: vi.fn(async ({ where }) =>
				fixtures
					.filter((entry) => entry.target.instanceId === where.instanceId)
					.map((entry) => ({ id: "target-1", ...entry.target })),
			),
		},
		cacheRefreshStatus: {
			findMany: vi.fn(async ({ where }) => {
				const entry = fixtures.find((source) => source.instance.id === where.instanceId)!;
				return [
					where.cacheType === "plex"
						? entry.parent.generationStatus
						: entry.positive.generationStatus,
				];
			}),
		},
	} as never);
	app.decorate("encryptor", {
		decrypt: () => {
			throw new Error("No display credential decryption");
		},
	} as never);
	await app.register(registerEpisodeRoutes, { prefix: "/api/plex/episodes" });
	await app.register(registerSeriesProgressRoutes, { prefix: "/api/plex/series-progress" });
	await app.ready();
	return app;
}
const episodeUrl = `/api/plex/episodes?instanceId=${instanceId}&showTmdbId=42`;
const progressUrl = "/api/plex/series-progress?tmdbIds=42,999";
async function get(url: string, owner = userId) {
	const app = await appFor(owner);
	return await app.inject({ method: "GET", url, headers: { "x-test-auth": "1" } });
}
function expectNoProvider() {
	expect(mocks.client).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
}

describe("cached episode display through actual routes and authority", () => {
	it("returns admitted watched and unwatched cache rows while the provider is denied", async () => {
		const response = await get(episodeUrl);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			showTmdbId: 42,
			episodes: [
				{ episodeNumber: 1, watched: true, watchedByUsers: ["synthetic-viewer"] },
				{ episodeNumber: 2, watched: false, watchedByUsers: [] },
			],
			evidence: current,
		});
		expectNoProvider();
	});
	it("returns exact progress only from complete admitted cached rows and keeps absent shows unknown", async () => {
		const response = await get(progressUrl);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			progress: {
				42: { status: "exact", watched: 1, total: 2, percent: 50, watchedSemantics: "exact" },
				999: { status: "unknown", watched: null, total: null, percent: null },
			},
			evidence: current,
		});
		expectNoProvider();
	});
	it.each(["wrong owner", "disabled"])("denies %s before selected cache access", async (mode) => {
		if (mode === "disabled") fixtures[0]!.instance.enabled = false;
		const response = await get(episodeUrl, mode === "wrong owner" ? "other-owner" : userId);
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("episodes");
		expect(mocks.episodes).not.toHaveBeenCalled();
		expectNoProvider();
	});
	it.each([
		"owner",
		"disabled",
		"connection",
		"identity",
		"status",
		"kind",
		"verifiedAt",
		"fingerprint",
	])("rejects %s drift during the cached read", async (mode) => {
		afterRead = () => {
			const source = fixtures[0]!;
			source.instance = {
				...source.instance,
				...(mode === "owner"
					? { userId: "other-owner" }
					: mode === "disabled"
						? { enabled: false }
						: mode === "connection"
							? { connectionGeneration: 5 }
							: mode === "identity"
								? { expectedIdentity: "other-machine" }
								: mode === "status"
									? { identityStatus: "MISMATCH" }
									: mode === "kind"
										? { identityKind: "OTHER" }
										: mode === "verifiedAt"
											? { identityVerifiedAt: new Date(0) }
											: { baseUrl: "http://other-synthetic.invalid" }),
			};
		};
		const response = await get(episodeUrl);
		expect(response.statusCode).toBe(503);
		expect(response.json()).not.toHaveProperty("episodes");
		expectNoProvider();
	});
	it.each([
		"missing_status",
		"published_generation_stale",
		"parent_generation_unavailable",
		"row_count_mismatch",
	] as const)("keeps %s unavailable", async (reason) => {
		selectedResult = {
			...fixtures[0]!.unavailable,
			evidence: { ...fixtures[0]!.unavailable.evidence, reasonCodes: [reason] },
		};
		const response = await get(progressUrl);
		expect(response.statusCode).toBe(200);
		expect(response.json().progress[42]).toMatchObject({
			status: "unknown",
			watched: null,
			total: null,
			percent: null,
		});
		expectNoProvider();
	});
	it.each(["error", "in_progress"] as const)(
		"summarizes the admitted positive fallback after a newer %s attempt",
		async (state) => {
			const source = fixtures[0]!;
			selectedResult = source.unavailable;
			source.positive.generationStatus.lastAttemptResult =
				state === "error" ? "error" : "in_progress:synthetic-attempt";
			source.positive.evidence = {
				...source.positive.evidence,
				attemptState: state,
				reasonCodes: [state === "error" ? "latest_attempt_failed" : "latest_attempt_in_progress"],
			};
			mocks.positive.mockResolvedValue(source.positive);
			const response = await get(progressUrl);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				progress: {
					42: {
						status: "partial",
						watched: 1,
						total: null,
						percent: null,
						watchedSemantics: "lower-bound",
					},
					999: { status: "unknown", watched: null },
				},
				evidence: source.positive.evidence,
			});
			const details = await get(episodeUrl);
			expect(details.statusCode).toBe(200);
			expect(details.json().episodes).toHaveLength(1);
			expect(details.json().episodes[0]).toMatchObject({ watched: true, episodeNumber: 1 });
			expectNoProvider();
		},
	);
	it.each([
		["full plus failed", "success", "error", "error"],
		["full plus running", "success", "in_progress", "in_progress"],
		["two failed", "error", "error", "error"],
		["two running", "in_progress", "in_progress", "in_progress"],
		["failed plus running", "error", "in_progress", "in_progress"],
	] as const)(
		"preserves retained attempt state for %s sources",
		async (_label, first, second, expected) => {
			fixtures.push(fixture("second-plex"));
			const states = [first, second];
			fixtures.forEach((source, index) => {
				const state = states[index]!;
				if (state === "success") return;
				source.positive.generationStatus.lastAttemptResult =
					state === "error" ? "error" : "in_progress:synthetic-attempt";
				source.positive.generationStatus.lastAttemptErrorMessage =
					state === "error" ? "Synthetic denied refresh" : null;
				source.positive.evidence = {
					...source.positive.evidence,
					attemptState: state,
					reasonCodes: [state === "error" ? "latest_attempt_failed" : "latest_attempt_in_progress"],
				};
			});
			mocks.episodes.mockImplementation(async (_prisma, input) => {
				const source = fixtures.find((entry) => entry.instance.id === input.instanceId)!;
				return first === "success" && source.instance.id === instanceId
					? source.episodes
					: source.unavailable;
			});
			mocks.positive.mockImplementation(
				async (_prisma, input) =>
					fixtures.find((entry) => entry.instance.id === input.instanceId)!.positive,
			);
			const response = await get(progressUrl);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				progress: { 42: { status: "partial", watched: 1, total: null, percent: null } },
				evidence: {
					availability: "last-known",
					attemptState: expected,
					publicationLevel: "positive-only",
					completeness: "partial",
				},
			});
			expectNoProvider();
		},
	);
	it("retains unavailable sources in mixed full, positive and unavailable progress", async () => {
		fixtures.push(fixture("positive-plex"), fixture("missing-plex"));
		mocks.episodes.mockImplementation(async (_prisma, input) => {
			const source = fixtures.find((entry) => entry.instance.id === input.instanceId)!;
			return input.instanceId === instanceId ? source.episodes : source.unavailable;
		});
		mocks.positive.mockImplementation(async (_prisma, input) => {
			const source = fixtures.find((entry) => entry.instance.id === input.instanceId)!;
			return input.instanceId === "positive-plex" ? source.positive : source.unavailable;
		});
		const response = await get(progressUrl);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			progress: { 42: { status: "partial", total: null, percent: null, watched: 1 } },
			evidence: {
				availability: "unavailable",
				publicationLevel: "positive-only",
				completeness: "partial",
			},
		});
		expect(response.json().evidence.reasonCodes).toContain("missing_status");
		expectNoProvider();
	});
	it("keeps the stronger selected episode mutation reader behind live verification", async () => {
		const app = await appFor();
		const service = new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: app.log,
		});
		const result = await service.readInstanceSelectedEpisodes({
			userId,
			instanceId,
			showTmdbIds: [42],
			mutation: true,
		});
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["plex_activity_unavailable"] },
		});
		expect(mocks.client).toHaveBeenCalledOnce();
		expect(mocks.episodes).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});
