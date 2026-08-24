import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	assertCurrentProviderEvidenceAuthority,
	createSanitizedProviderEvidence,
} from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

vi.mock("../../plex/plex-authority-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../plex/plex-authority-service.js")>();
	const repository = await import("../../plex/plex-evidence-repository.js");
	return {
		...actual,
		PlexAuthorityService: class {
			private readonly prisma: {
				serviceInstance: { findMany: (input: unknown) => Promise<Array<Record<string, unknown>>> };
			};

			constructor(input: {
				prisma: {
					serviceInstance: {
						findMany: (input: unknown) => Promise<Array<Record<string, unknown>>>;
					};
				};
			}) {
				this.prisma = input.prisma;
			}

			private async instance(input: { userId: string; instanceId: string }) {
				const instances = await this.prisma.serviceInstance.findMany({
					where: { userId: input.userId, service: "PLEX", enabled: true },
				});
				return instances.find((instance) => instance.id === input.instanceId);
			}

			private repositoryWithInstance(instance: Record<string, unknown> | undefined) {
				return {
					...this.prisma,
					serviceInstance: {
						...this.prisma.serviceInstance,
						findFirst: vi.fn().mockResolvedValue(instance ?? null),
					},
				} as never;
			}

			async scanInstancePolicy(input: { userId: string; instanceId: string }) {
				const instance = await this.instance(input);
				return repository.scanInstancePolicyEvidence(this.repositoryWithInstance(instance), input);
			}

			async readInstanceEpisodes(input: { userId: string; instanceId: string }) {
				const instance = await this.instance(input);
				return repository.loadInstanceEpisodeEvidence(
					this.prisma as never,
					{
						...input,
						instance: instance as never,
					} as never,
				);
			}

			async readInstanceSelectedEpisodes(input: { userId: string; instanceId: string }) {
				const instance = await this.instance(input);
				return repository.loadInstanceSelectedEpisodeEvidence(
					this.prisma as never,
					{
						...input,
						instance: instance as never,
					} as never,
				);
			}
		},
	};
});

function plexV3Metadata(itemCount = 1) {
	return JSON.stringify({
		version: 3,
		publicationLevel: "authoritative",
		completeness: "complete",
		itemCount,
		canonicalizationVersion: 1,
		sections: [
			{
				key: "1",
				uuid: "movies-uuid",
				title: "Movies",
				type: "movie",
				refreshing: false,
				scannedAt: 1_777_000_000,
				updatedAt: 1_777_000_100,
			},
		],
		roots: [{ sectionKey: "1", domain: "membership", digest: "a".repeat(64) }],
	});
}

function plexEpisodeV2Metadata(parentGenerationId: string) {
	return JSON.stringify({
		version: 2,
		parentPlexGenerationId: parentGenerationId,
		parentPublicationLevel: "authoritative",
		parentMetadataVersion: 3,
		canonicalizationVersion: 1,
		episodeDigest: "b".repeat(64),
		connectionGeneration: 3,
		identityGeneration: 7,
	});
}

function fingerprint(value: unknown): string {
	const canonicalize = (input: unknown): unknown => {
		if (input instanceof Date) return input.toISOString();
		if (Array.isArray(input)) return input.map(canonicalize);
		if (typeof input === "object" && input !== null) {
			return Object.fromEntries(
				Object.entries(input as Record<string, unknown>)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, entry]) => [key, canonicalize(entry)]),
			);
		}
		return input;
	};
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function fixture(
	statusOverrides: Record<string, unknown> = {},
	instanceOverrides: Record<string, unknown> = {},
) {
	const now = new Date();
	const instance = {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		name: "Private label",
		label: "Private label",
		baseUrl: "http://private.invalid",
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		expectedIdentity: "plex-machine-a",
		identityKind: "PLEX_MACHINE_IDENTIFIER",
		identityStatus: "VERIFIED",
		identityVerifiedAt: new Date(now.getTime() - 5_000),
		connectionGeneration: 3,
		identityGeneration: 7,
		createdAt: new Date(now.getTime() - 20_000),
		updatedAt: new Date(now.getTime() - 10_000),
		...instanceOverrides,
	};
	let instances = [instance];
	const status = {
		instanceId: instance.id,
		cacheType: "plex",
		lastRefreshedAt: now,
		lastResult: "success",
		lastErrorMessage: null,
		lastAttemptAt: now,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null as string | null,
		itemCount: 1,
		connectionGeneration: 3,
		identityGeneration: 7,
		generationId: "generation-a",
		generationMetadata: plexV3Metadata(),
		...statusOverrides,
	};
	let rows = [
		{
			id: "plex-row-1",
			instanceId: instance.id,
			tmdbId: 42,
			mediaType: "movie",
			sectionId: "1",
			sectionTitle: "Movies",
			lastWatchedAt: now,
			watchCount: 2,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: null,
			connectionGeneration: 3,
			identityGeneration: 7,
		},
	];
	const statusFingerprint = fingerprint({
		instance: {
			id: instance.id,
			expectedIdentity: instance.expectedIdentity,
			identityKind: instance.identityKind,
			identityVerifiedAt: instance.identityVerifiedAt,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			updatedAt: instance.updatedAt,
		},
		status: {
			instanceId: status.instanceId,
			lastRefreshedAt: status.lastRefreshedAt,
			lastResult: status.lastResult,
			lastErrorMessage: status.lastErrorMessage,
			lastAttemptResult: status.lastAttemptResult,
			lastAttemptErrorMessage: status.lastAttemptErrorMessage,
			itemCount: status.itemCount,
			connectionGeneration: status.connectionGeneration,
			identityGeneration: status.identityGeneration,
			generationId: status.generationId,
			generationMetadata: status.generationMetadata,
		},
	});
	const evidence = createSanitizedProviderEvidence(
		["plex"],
		[
			{
				service: "PLEX",
				identityKind: instance.identityKind,
				identityFingerprint: fingerprint({
					service: instance.service,
					identityKind: instance.identityKind,
					expectedIdentity: instance.expectedIdentity,
				}),
				connectionGeneration: 3,
				identityGeneration: 7,
				cacheType: "plex",
				completedAt: status.lastRefreshedAt.toISOString(),
				itemCount: 1,
				verifiedAt: instance.identityVerifiedAt.toISOString(),
				statusFingerprint,
				rowFingerprint: fingerprint(rows),
			},
		],
	);
	const tx = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([{ id: instance.id }]),
		serviceInstance: { findMany: vi.fn(async () => instances) },
		cacheRefreshStatus: { findMany: vi.fn(async () => [status]) },
		plexCache: { findMany: vi.fn(async () => rows) },
	};
	const identityReader = vi.fn(async () => ({
		service: "PLEX",
		identityKind: "plex-machine-identifier",
		rawIdentity: instance.expectedIdentity,
		confirmationDigest: "safe",
		fingerprint: "safe",
	}));
	const deps = {
		prisma: {
			serviceInstance: tx.serviceInstance,
			cacheRefreshStatus: tx.cacheRefreshStatus,
			plexCache: tx.plexCache,
			$transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		},
		encryptor: { decrypt: vi.fn(() => "decrypted") },
		providerIdentityReader: identityReader,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as CleanupExecutorDeps;
	return {
		deps,
		evidence,
		instance,
		status,
		identityReader,
		setInstances(next: typeof instances) {
			instances = next;
		},
		setRows(next: typeof rows) {
			rows = next;
		},
	};
}

const cacheCases = {
	plex: {
		service: "PLEX",
		identityKind: "PLEX_MACHINE_IDENTIFIER",
		observationKind: "plex-machine-identifier",
		model: "plexCache",
		row: {
			id: "plex-row",
			instanceId: "provider-1",
			tmdbId: 42,
			mediaType: "movie",
			sectionId: "1",
			sectionTitle: "Movies",
			lastWatchedAt: null,
			watchCount: 2,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: null,
			connectionGeneration: 3,
			identityGeneration: 7,
		},
	},
	plex_episode: {
		service: "PLEX",
		identityKind: "PLEX_MACHINE_IDENTIFIER",
		observationKind: "plex-machine-identifier",
		model: "plexEpisodeCache",
		row: {
			id: "plex-episode-row",
			instanceId: "provider-1",
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 2,
			ratingKey: "episode-key",
			watched: true,
			watchedByUsers: "[]",
			lastWatchedAt: null,
			watchCount: 1,
			refreshedAt: new Date("2026-08-15T00:00:00.000Z"),
			sourceFingerprint: "source",
			connectionGeneration: 3,
			identityGeneration: 7,
		},
	},
	jellyfin: {
		service: "JELLYFIN",
		identityKind: "JELLYFIN_SERVER_ID",
		observationKind: "jellyfin-server-id",
		model: "jellyfinCache",
		row: {
			id: "jellyfin-row",
			instanceId: "provider-1",
			tmdbId: 42,
			mediaType: "movie",
			lastWatchedAt: null,
			watchCount: 2,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			addedAt: null,
			connectionGeneration: 3,
			identityGeneration: 7,
		},
		extraRow: {
			libraryId: "library-id",
			libraryName: "Private library",
			jellyfinId: "upstream-item",
			collections: "[]",
		},
	},
	jellyfin_episode: {
		service: "EMBY",
		identityKind: "EMBY_SERVER_ID",
		observationKind: "emby-server-id",
		model: "jellyfinEpisodeCache",
		row: {
			id: "jellyfin-episode-row",
			instanceId: "provider-1",
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 2,
			jellyfinId: "episode-id",
			watched: true,
			watchedByUsers: "[]",
			lastWatchedAt: null,
			connectionGeneration: 3,
			identityGeneration: 7,
		},
	},
	tautulli: {
		service: "TAUTULLI",
		identityKind: "TAUTULLI_PMS_IDENTIFIER",
		observationKind: "tautulli-pms-identifier",
		model: "tautulliCache",
		row: {
			id: "tautulli-row",
			instanceId: "provider-1",
			tmdbId: 42,
			mediaType: "movie",
			lastWatchedAt: null,
			watchCount: 2,
			watchedByUsers: "[]",
			connectionGeneration: 3,
			identityGeneration: 7,
		},
	},
} as const;

function cacheTypeFixture(
	cacheType: keyof typeof cacheCases,
	options: {
		now?: Date;
		providerOverrides?: Record<string, unknown>;
		statusOverrides?: Record<string, unknown>;
	} = {},
) {
	const cacheCase = cacheCases[cacheType];
	const now = options.now ?? new Date();
	const provider = {
		id: "provider-1",
		userId: "user-1",
		service: cacheCase.service,
		name: "Private label",
		label: "Private label",
		baseUrl: "http://private.invalid",
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		expectedIdentity: "provider-identity",
		identityKind: cacheCase.identityKind,
		identityStatus: "VERIFIED",
		identityVerifiedAt: new Date(now.getTime() - 5_000),
		connectionGeneration: 3,
		identityGeneration: 7,
		createdAt: new Date(now.getTime() - 20_000),
		updatedAt: new Date(now.getTime() - 10_000),
		...options.providerOverrides,
	};
	const status = {
		instanceId: provider.id,
		cacheType,
		lastRefreshedAt: now,
		lastResult: "success",
		lastErrorMessage: null,
		lastAttemptAt: now,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		itemCount: 1,
		connectionGeneration: 3,
		identityGeneration: 7,
		generationId: "generation-a",
		generationMetadata:
			cacheType === "plex"
				? plexV3Metadata()
				: cacheType === "plex_episode"
					? plexEpisodeV2Metadata("parent-generation-a")
					: "{}",
		...options.statusOverrides,
	};
	const statusPayload = {
		instanceId: status.instanceId,
		lastRefreshedAt: status.lastRefreshedAt,
		lastResult: status.lastResult,
		lastErrorMessage: status.lastErrorMessage,
		lastAttemptResult: status.lastAttemptResult,
		lastAttemptErrorMessage: status.lastAttemptErrorMessage,
		itemCount: status.itemCount,
		connectionGeneration: status.connectionGeneration,
		identityGeneration: status.identityGeneration,
		generationId: status.generationId,
		generationMetadata: status.generationMetadata,
	};
	const evidence = createSanitizedProviderEvidence(
		[cacheType],
		[
			{
				service: cacheCase.service,
				identityKind: cacheCase.identityKind,
				identityFingerprint: fingerprint({
					service: provider.service,
					identityKind: provider.identityKind,
					expectedIdentity: provider.expectedIdentity,
				}),
				connectionGeneration: 3,
				identityGeneration: 7,
				cacheType,
				completedAt: now.toISOString(),
				itemCount: 1,
				verifiedAt: provider.identityVerifiedAt.toISOString(),
				statusFingerprint: fingerprint({
					instance: {
						id: provider.id,
						expectedIdentity: provider.expectedIdentity,
						identityKind: provider.identityKind,
						identityVerifiedAt: provider.identityVerifiedAt,
						connectionGeneration: provider.connectionGeneration,
						identityGeneration: provider.identityGeneration,
						updatedAt: provider.updatedAt,
					},
					status: statusPayload,
				}),
				rowFingerprint: fingerprint([cacheCase.row]),
			},
		],
	);
	const databaseRow = { ...cacheCase.row, ...(cacheCase as { extraRow?: object }).extraRow };
	const findRows = vi.fn(async ({ select }: { select: Record<string, boolean> }) => [
		Object.fromEntries(
			Object.keys(select).map((key) => [key, databaseRow[key as keyof typeof databaseRow]]),
		),
	]);
	const tx = {
		$queryRawUnsafe: vi.fn(),
		serviceInstance: { findMany: vi.fn(async () => [provider]) },
		cacheRefreshStatus: {
			findMany: vi.fn(async ({ where }: { where: { cacheType: string } }) =>
				cacheType === "plex_episode" && where.cacheType === "plex"
					? [
							{
								...status,
								cacheType: "plex",
								generationId: "parent-generation-a",
								generationMetadata: plexV3Metadata(),
							},
						]
					: [status],
			),
		},
		plexCache: { findMany: findRows, count: vi.fn().mockResolvedValue(1) },
		plexEpisodeCache: { findMany: findRows },
		jellyfinCache: { findMany: findRows },
		jellyfinEpisodeCache: { findMany: findRows },
		tautulliCache: { findMany: findRows },
	};
	const identityReader = vi.fn(async () => ({
		service: cacheCase.service,
		identityKind: cacheCase.observationKind,
		rawIdentity: provider.expectedIdentity,
		confirmationDigest: "safe",
		fingerprint: "safe",
	}));
	const deps = {
		prisma: {
			...tx,
			$transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		},
		encryptor: { decrypt: vi.fn(() => "decrypted") },
		providerIdentityReader: identityReader,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as CleanupExecutorDeps;
	return { deps, evidence, identityReader };
}

describe("provider execution authority", () => {
	for (const cacheType of Object.keys(cacheCases) as Array<keyof typeof cacheCases>) {
		it(`accepts unchanged real ${cacheType} evidence`, async () => {
			const subject = cacheTypeFixture(cacheType);

			await expect(
				assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
			).resolves.toBeUndefined();
			expect(subject.identityReader).toHaveBeenCalledOnce();
		});
	}

	it.each(["jellyfin", "tautulli"] as const)(
		"keeps the publication-order check for non-Plex %s evidence",
		async (cacheType) => {
			const now = new Date("2026-08-20T12:00:00.000Z");
			const subject = cacheTypeFixture(cacheType, {
				now,
				providerOverrides: {
					updatedAt: new Date("2026-08-20T11:50:00.000Z"),
					identityVerifiedAt: new Date("2026-08-20T11:50:00.000Z"),
				},
				statusOverrides: {
					lastRefreshedAt: new Date("2026-08-20T11:45:00.000Z"),
					lastAttemptAt: new Date("2026-08-20T11:45:00.000Z"),
				},
			});

			await expect(
				assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
			).rejects.toThrow("Provider execution authority changed");
			expect(subject.identityReader).not.toHaveBeenCalled();
		},
	);

	it("live-checks identity and exact rows, then fences the accepted snapshot", async () => {
		const subject = fixture();
		const assertLease = vi.fn().mockResolvedValue(undefined);

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, assertLease),
		).resolves.toBeUndefined();

		expect(subject.identityReader).toHaveBeenCalledTimes(1);
		expect(assertLease).toHaveBeenCalledTimes(2);
		expect(subject.deps.prisma.$transaction).toHaveBeenCalledTimes(1);
	});

	it.each([
		["metadata-only instance update", "updatedAt"],
		["same-identity reverification", "identityVerifiedAt"],
	] as const)("accepts current Plex evidence after a %s", async (_label, field) => {
		const publicationAt = new Date(Date.now() - 30_000);
		const subject = fixture(
			{ lastRefreshedAt: publicationAt, lastAttemptAt: publicationAt },
			{ [field]: new Date(Date.now() - 10_000) },
		);

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).resolves.toBeUndefined();
		expect(subject.identityReader).toHaveBeenCalledOnce();
	});

	it("fails closed when the live provider identity does not match", async () => {
		const subject = fixture();
		subject.identityReader.mockResolvedValueOnce({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "plex-machine-b",
			confirmationDigest: "safe",
			fingerprint: "safe",
		});

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.deps.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("rejects row drift even while the status token lags unchanged", async () => {
		const subject = fixture();
		subject.setRows([]);

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.identityReader).not.toHaveBeenCalled();
	});

	it("does not reuse the first target check after rows drift", async () => {
		const subject = fixture();
		const assertLease = vi.fn();
		await assertCurrentProviderEvidenceAuthority(
			subject.deps,
			"user-1",
			subject.evidence,
			assertLease,
		);
		subject.setRows([]);

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, assertLease),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.identityReader).toHaveBeenCalledTimes(1);
	});

	it.each([
		["connection generation", "connectionGeneration"],
		["identity generation", "identityGeneration"],
	] as const)("rejects a changed %s", async (_label, field) => {
		const subject = fixture();
		subject.instance[field]++;

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.identityReader).not.toHaveBeenCalled();
	});

	for (const state of ["disabled", "deleted", "mismatched"] as const) {
		it(`rejects a ${state} contributing instance`, async () => {
			const subject = fixture();
			if (state === "disabled") subject.instance.enabled = false;
			else if (state === "deleted") subject.setInstances([]);
			else subject.instance.identityStatus = "MISMATCH";

			await expect(
				assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
			).rejects.toThrow("Provider execution authority changed");
		});
	}

	it("rejects a same-identity refresh or invalidated cache status", async () => {
		const subject = fixture();
		subject.status.generationId = "generation-b";
		subject.status.lastAttemptErrorMessage = "refresh failed";

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
	});

	it("rejects completed A provider evidence for both direct and retry revalidation after B publishes", async () => {
		const subject = fixture();

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).resolves.toBeUndefined();

		subject.status.generationId = "generation-b";
		subject.status.lastRefreshedAt = new Date(subject.status.lastRefreshedAt.getTime() + 1_000);
		subject.status.lastAttemptAt = new Date(subject.status.lastRefreshedAt);
		subject.setRows([
			{
				...subject.status,
				id: "plex-row-b",
				instanceId: subject.instance.id,
				tmdbId: 43,
				mediaType: "movie",
				sectionId: "2",
				sectionTitle: "Movies B",
				lastWatchedAt: subject.status.lastRefreshedAt,
				watchCount: 5,
				watchedByUsers: "[]",
				onDeck: true,
				userRating: null,
				collections: "[]",
				labels: "[]",
				addedAt: null,
				connectionGeneration: 3,
				identityGeneration: 7,
			},
		]);

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
	});

	it("does not authorize retry or direct execution after a failed latest Plex attempt", async () => {
		const subject = fixture({
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "Plex inventory changed",
			lastErrorMessage: "Plex inventory changed",
		});

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.identityReader).not.toHaveBeenCalled();
	});

	it("rejects identity dependency failure without entering the database fence", async () => {
		const subject = fixture();
		subject.identityReader.mockRejectedValueOnce(new Error("private upstream failure"));

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.deps.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("rejects drift after the live read in the final protected fence", async () => {
		const subject = fixture();
		subject.identityReader.mockImplementationOnce(async () => {
			subject.setRows([]);
			return {
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: subject.instance.expectedIdentity,
				confirmationDigest: "safe",
				fingerprint: "safe",
			};
		});

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.deps.prisma.$transaction).toHaveBeenCalledOnce();
	});
});
