import { describe, expect, it, vi } from "vitest";
import type { CacheRefreshStatus, PlexCache, Prisma } from "../../prisma.js";
import type { OwnedProviderPublicationSnapshot } from "../../services/provider-identity-guard.js";
import { hasSamePersistedPlexCacheRows } from "../plex-cache-storage.js";
import {
	decodePlexGenerationMetadata,
	encodeAuthoritativePlexGenerationMetadata,
	encodePositivePlexGenerationMetadata,
} from "../plex-generation-metadata.js";
import { findReusablePlexGeneration } from "../plex-generation-reuse.js";
import {
	createPlexTargetLedgerBinding,
	type PlexGenerationTarget,
	readPlexGenerationTargetsForReuse,
} from "../plex-generation-target-ledger.js";

const oldTime = new Date("2026-10-19T12:00:00.000Z");
const attemptedAt = new Date("2026-10-19T12:01:00.000Z");
const completedAt = new Date("2026-10-19T12:02:00.000Z");

function fixture(positive = false) {
	const instance = {
		id: "plex-1",
		userId: "owner-1",
		service: "PLEX",
		enabled: true,
		baseUrl: "https://plex.invalid",
		apiKey: "test",
		label: "Plex",
		encryptedApiKey: "cipher",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		expectedIdentity: "test-plex",
		identityStatus: "VERIFIED",
		connectionGeneration: 2,
		identityGeneration: 3,
	} satisfies OwnedProviderPublicationSnapshot;
	const rows: Prisma.PlexCacheCreateManyInput[] = [
		{
			instanceId: "plex-1",
			tmdbId: 42,
			mediaType: "series",
			sectionId: "shows",
			sectionTitle: "Shows",
			title: "Test show",
			ratingKey: "show-1",
			lastWatchedAt: null,
			watchCount: 0,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: null,
			thumb: null,
			connectionGeneration: 2,
			identityGeneration: 3,
		},
	];
	const targets: PlexGenerationTarget[] = [
		{
			instanceId: "plex-1",
			generationId: "old-generation",
			sectionId: "shows",
			sectionUuid: "shows-uuid",
			mediaType: "series",
			tmdbId: 42,
			tvdbId: 99,
			ratingKey: "show-1",
		},
	];
	const unit = {
		scopeKey: "section:shows",
		expectedRawCount: 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
	};
	const publication = (generationId: string, observedAt = completedAt) => {
		const boundTargets = targets.map((target) => ({ ...target, generationId }));
		const targetLedger = createPlexTargetLedgerBinding({
			...instance,
			instanceId: instance.id,
			generationId,
			targets: boundTargets,
		});
		const common = {
			sections: [
				{
					key: "shows",
					uuid: "shows-uuid",
					title: "Shows",
					type: "show" as const,
					refreshing: false as const,
					scannedAt: 1,
					updatedAt: 2,
				},
			],
			itemCount: 1,
			canonicalizationVersion: 1 as const,
			targetLedger,
			coverageReceipt: {
				version: 2 as const,
				provider: "plex" as const,
				attemptStartedAt: (observedAt === oldTime ? oldTime : attemptedAt).toISOString(),
				observedAt: observedAt.toISOString(),
				evidence: positive ? ("positive-only" as const) : ("complete" as const),
				units: [unit],
				publishedCanonicalEntities: 1,
				domains: (
					["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"] as const
				).map((domain) => ({
					domain,
					evidence: "complete" as const,
					valueSemantics: "exact" as const,
					units: [unit],
					publishedCanonicalEntities: 1,
				})),
			},
		};
		const generationMetadata = positive
			? encodePositivePlexGenerationMetadata({
					...common,
					observedRoots: [
						{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) },
					],
					partialReasons: [],
				})
			: encodeAuthoritativePlexGenerationMetadata({
					...common,
					roots: [{ sectionKey: "shows", domain: "membership", digest: "a".repeat(64) }],
					partialReasons: [],
				});
		return { generationId, targets: boundTargets, targetLedger, generationMetadata };
	};
	const status: CacheRefreshStatus = {
		id: "status-1",
		instanceId: instance.id,
		cacheType: "plex",
		generationId: "old-generation",
		generationMetadata: publication("old-generation", oldTime).generationMetadata,
		lastRefreshedAt: oldTime,
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: 1,
		connectionGeneration: 2,
		identityGeneration: 3,
		lastAttemptAt: attemptedAt,
		lastAttemptResult: "in_progress:current-attempt",
		lastAttemptErrorMessage: null,
	};
	const savedRows = rows.map((row, index) => ({ ...row, id: `row-${index}` })) as PlexCache[];
	const savedTargets = targets.map((target, index) => ({ ...target, id: `target-${index}` }));
	function page<T extends { id: string }>(
		values: T[],
		{ take, cursor }: { take: number; cursor?: { id: string } },
	) {
		const start = cursor ? values.findIndex((value) => value.id === cursor.id) + 1 : 0;
		return values.slice(start, start + take);
	}
	const tx = {
		cacheRefreshStatus: { findUnique: vi.fn(async () => status as CacheRefreshStatus | null) },
		plexCache: { findMany: vi.fn(async (query) => page(savedRows, query)) },
		plexGenerationTarget: { findMany: vi.fn(async (query) => page(savedTargets, query)) },
	};
	const reuse = () =>
		findReusablePlexGeneration(tx as unknown as Prisma.TransactionClient, {
			instance,
			attempt: { attemptedAt, resultMarker: "in_progress:current-attempt" },
			rows,
			publication,
		});
	const editMetadata = (edit: (metadata: ReturnType<typeof JSON.parse>) => void) => {
		const metadata = JSON.parse(status.generationMetadata!);
		edit(metadata);
		status.generationMetadata = JSON.stringify(metadata);
	};
	return { instance, rows, savedRows, targets, savedTargets, status, tx, reuse, editMetadata };
}

describe("transaction-local Plex generation equivalence", () => {
	it("does not reuse an otherwise valid legacy V5 receipt-backed head", async () => {
		const f = fixture();
		f.editMetadata((metadata) => {
			metadata.version = 5;
			const {
				domains: _domains,
				publishedCanonicalEntities: _count,
				...receipt
			} = metadata.coverageReceipt;
			metadata.coverageReceipt = { ...receipt, version: 1 };
		});
		expect(decodePlexGenerationMetadata(f.status.generationMetadata)).toMatchObject({
			ok: true,
			metadata: { version: 5 },
		});
		expect(await f.reuse()).toBeNull();
	});
	it.each([false, true])(
		"reuses verified identical V6 evidence with only fresh receipt clocks (positive: %s)",
		async (positive) => {
			const f = fixture(positive);
			const reused = await f.reuse();
			expect(reused?.generationId).toBe("old-generation");
			expect(JSON.parse(reused!.generationMetadata).coverageReceipt).toMatchObject({
				attemptStartedAt: "2026-10-19T12:01:00.000Z",
				observedAt: "2026-10-19T12:02:00.000Z",
			});
		},
	);

	it.each([
		["instanceId", "plex-2"],
		["tmdbId", 43],
		["mediaType", "movie"],
		["sectionId", "other"],
		["sectionTitle", "Other shows"],
		["title", "Changed title"],
		["ratingKey", null],
		["lastWatchedAt", oldTime],
		["watchCount", 1],
		["watchedByUsers", '["Account"]'],
		["onDeck", true],
		["userRating", 8],
		["collections", '["Collection"]'],
		["labels", '["Label"]'],
		["addedAt", oldTime],
		["thumb", "/thumb"],
		["connectionGeneration", null],
		["identityGeneration", 4],
	] as const)("does not ignore persisted %s differences", async (field, value) => {
		const f = fixture();
		Object.assign(f.savedRows[0]!, { [field]: value });
		expect(await f.reuse()).toBeNull();
	});

	it("normalizes only database optional defaults and equivalent Date representations", async () => {
		const f = fixture();
		for (const key of ["ratingKey", "lastWatchedAt", "userRating", "addedAt", "thumb"] as const) {
			f.rows[0]![key] = undefined;
			Object.assign(f.savedRows[0]!, { [key]: null });
		}
		f.rows[0]!.title = undefined;
		f.savedRows[0]!.title = "";
		f.rows[0]!.watchCount = undefined;
		f.rows[0]!.onDeck = undefined;
		f.rows[0]!.addedAt = oldTime.toISOString();
		f.savedRows[0]!.addedAt = new Date(oldTime);
		expect((await f.reuse())?.generationId).toBe("old-generation");
	});

	it.each([
		["instanceId", "plex-2"],
		["generationId", "other-generation"],
		["sectionId", "other"],
		["sectionUuid", "other-uuid"],
		["mediaType", "movie"],
		["tmdbId", 43],
		["tvdbId", null],
		["ratingKey", "show-2"],
	] as const)(
		"verifies the actual old ledger's %s against receipt-backed metadata",
		async (field, value) => {
			const f = fixture();
			Object.assign(f.savedTargets[0]!, { [field]: value });
			expect(await f.reuse()).toBeNull();
		},
	);

	it.each([
		["instanceId", "plex-2"],
		["cacheType", "plex_episode"],
		["lastResult", "error"],
		["lastErrorMessage", "failed"],
		["generationId", null],
		["generationId", " "],
		["connectionGeneration", 1],
		["identityGeneration", null],
		["itemCount", 2],
		["lastAttemptAt", oldTime],
		["lastAttemptResult", "in_progress:superseded"],
		["lastAttemptErrorMessage", "failed"],
		["lastRefreshedAt", completedAt],
	] as const)("rejects unverified status %s=%s", async (field, value) => {
		const f = fixture();
		Object.assign(f.status, { [field]: value });
		expect(await f.reuse()).toBeNull();
	});

	it.each([
		[
			"section title",
			(m: ReturnType<typeof JSON.parse>) => {
				m.sections[0].title = "Other";
			},
		],
		[
			"section uuid",
			(m: ReturnType<typeof JSON.parse>) => {
				m.sections[0].uuid = "other";
			},
		],
		[
			"section revision",
			(m: ReturnType<typeof JSON.parse>) => {
				m.sections[0].updatedAt = 3;
			},
		],
		[
			"root",
			(m: ReturnType<typeof JSON.parse>) => {
				m.roots[0].digest = "b".repeat(64);
			},
		],
		[
			"receipt pagination",
			(m: ReturnType<typeof JSON.parse>) => {
				m.coverageReceipt.units[0].pagesAttempted = 2;
				m.coverageReceipt.units[0].pagesCompleted = 2;
			},
		],
		[
			"receipt domain pagination",
			(m: ReturnType<typeof JSON.parse>) => {
				m.coverageReceipt.domains[0].units[0].pagesAttempted = 2;
				m.coverageReceipt.domains[0].units[0].pagesCompleted = 2;
			},
		],
		[
			"receipt semantics",
			(m: ReturnType<typeof JSON.parse>) => {
				m.coverageReceipt.domains[2].valueSemantics = "lower-bound";
			},
		],
		[
			"receipt binding timestamp",
			(m: ReturnType<typeof JSON.parse>) => {
				m.coverageReceipt.observedAt = attemptedAt.toISOString();
			},
		],
		[
			"target digest",
			(m: ReturnType<typeof JSON.parse>) => {
				m.targetDigest = "b".repeat(64);
			},
		],
		[
			"target count",
			(m: ReturnType<typeof JSON.parse>) => {
				m.targetCount = 2;
			},
		],
		[
			"metadata version",
			(m: ReturnType<typeof JSON.parse>) => {
				m.version = 5;
			},
		],
		[
			"canonicalization version",
			(m: ReturnType<typeof JSON.parse>) => {
				m.canonicalizationVersion = 2;
			},
		],
		[
			"publication level",
			(m: ReturnType<typeof JSON.parse>) => {
				m.publicationLevel = "positive-only";
			},
		],
	] as const)("retains the new-generation path for changed %s", async (_name, edit) => {
		const f = fixture();
		f.editMetadata(edit);
		expect(await f.reuse()).toBeNull();
	});

	it.each([
		[
			"ambiguities",
			(m: ReturnType<typeof JSON.parse>) => {
				m.ambiguousTmdbCandidates = [{ mediaType: "series", tmdbId: 42 }];
			},
		],
		[
			"partial reasons",
			(m: ReturnType<typeof JSON.parse>) => {
				m.partialReasons = [{ code: "historyItemsWithUnknownAccounts", count: 1 }];
			},
		],
		[
			"observed roots",
			(m: ReturnType<typeof JSON.parse>) => {
				m.observedRoots[0].digest = "b".repeat(64);
			},
		],
		[
			"capabilities",
			(m: ReturnType<typeof JSON.parse>) => {
				m.capabilities[0].semantics = "exact";
			},
		],
	] as const)("does not ignore positive-only %s", async (_name, edit) => {
		const f = fixture(true);
		f.editMetadata(edit);
		expect(await f.reuse()).toBeNull();
	});

	it.each([null, "", "{", "{}", '{"sections":[]}', '{"version":4}'])(
		"rejects legacy/missing/corrupt metadata %s",
		async (metadata) => {
			const f = fixture();
			f.status.generationMetadata = metadata;
			expect(await f.reuse()).toBeNull();
		},
	);

	it.each(["status", "rows", "targets"] as const)(
		"treats a failed %s equivalence read as no reuse",
		async (part) => {
			const f = fixture();
			const read =
				part === "status"
					? f.tx.cacheRefreshStatus.findUnique
					: part === "rows"
						? f.tx.plexCache.findMany
						: f.tx.plexGenerationTarget.findMany;
			read.mockRejectedValueOnce(new Error("read failed"));
			expect(await f.reuse()).toBeNull();
		},
	);

	it.each(["missing status", "missing ledger", "surplus ledger", "missing row", "surplus row"])(
		"rejects %s",
		async (part) => {
			const f = fixture();
			if (part === "missing status") f.tx.cacheRefreshStatus.findUnique.mockResolvedValueOnce(null);
			if (part === "missing ledger") f.savedTargets.splice(0);
			if (part === "surplus ledger")
				f.savedTargets.push({ ...f.savedTargets[0]!, id: "surplus", ratingKey: "extra" });
			if (part === "missing row") f.savedRows.splice(0);
			if (part === "surplus row") f.savedRows.push({ ...f.savedRows[0]!, id: "surplus" });
			expect(await f.reuse()).toBeNull();
		},
	);
});

describe("transaction-local reuse storage boundaries", () => {
	function pages<T extends { id: string }>(values: T[]) {
		return vi.fn(async ({ take, cursor }: { take: number; cursor?: { id: string } }) => {
			const start = cursor ? values.findIndex((row) => row.id === cursor.id) + 1 : 0;
			return values.slice(start, start + take);
		});
	}

	it("compares duplicate row multiplicity across the 500-row boundary and exposes surplus rows", async () => {
		const f = fixture();
		const intended = Array.from({ length: 501 }, () => ({ ...f.rows[0]! }));
		const persisted = intended.map((row, index) => ({ ...row, id: `row-${index}` })) as PlexCache[];
		const findMany = pages(persisted);
		const tx = { plexCache: { findMany } } as unknown as Prisma.TransactionClient;
		expect(await hasSamePersistedPlexCacheRows(tx, "plex-1", intended)).toBe(true);
		expect(findMany.mock.calls).toEqual([
			[{ where: { instanceId: "plex-1" }, orderBy: { id: "asc" }, take: 500 }],
			[
				{
					where: { instanceId: "plex-1" },
					orderBy: { id: "asc" },
					take: 2,
					skip: 1,
					cursor: { id: "row-499" },
				},
			],
		]);
		persisted.push({ ...persisted[0]!, id: "surplus" });
		expect(await hasSamePersistedPlexCacheRows(tx, "plex-1", intended)).toBe(false);
		persisted.splice(500);
		expect(await hasSamePersistedPlexCacheRows(tx, "plex-1", intended)).toBe(false);
	});

	it("reads every target across the 500-row boundary, including crossed or surplus generations", async () => {
		const f = fixture();
		const persisted = Array.from({ length: 501 }, (_, index) => ({
			...f.targets[0]!,
			id: `target-${index}`,
			ratingKey: `show-${index}`,
		}));
		// The ledger reader must not hide this row; the caller's integrity check rejects it.
		persisted[500]!.generationId = "crossed-generation";
		const findMany = pages(persisted);
		const tx = { plexGenerationTarget: { findMany } } as unknown as Prisma.TransactionClient;
		const result = await readPlexGenerationTargetsForReuse(tx, "plex-1", 501);
		expect(result).toHaveLength(501);
		expect(result?.at(-1)).toMatchObject({
			generationId: "crossed-generation",
			ratingKey: "show-500",
		});
		expect(findMany.mock.calls).toEqual([
			[{ where: { instanceId: "plex-1" }, orderBy: { id: "asc" }, take: 500 }],
			[
				{
					where: { instanceId: "plex-1" },
					orderBy: { id: "asc" },
					take: 2,
					skip: 1,
					cursor: { id: "target-499" },
				},
			],
		]);
		persisted.push({ ...persisted[0]!, id: "surplus", ratingKey: "surplus" });
		expect(await readPlexGenerationTargetsForReuse(tx, "plex-1", 501)).toBeNull();
	});

	it("does not accept a full-page scan whose cursor fails to advance", async () => {
		const f = fixture();
		const rows = Array.from({ length: 500 }, (_, index) => ({
			...f.savedRows[0]!,
			id: `row-${index}`,
		}));
		const targets = Array.from({ length: 500 }, (_, index) => ({
			...f.savedTargets[0]!,
			id: `target-${index}`,
		}));
		const tx = {
			plexCache: { findMany: vi.fn(async () => rows) },
			plexGenerationTarget: { findMany: vi.fn(async () => targets) },
		} as unknown as Prisma.TransactionClient;
		expect(
			await hasSamePersistedPlexCacheRows(
				tx,
				"plex-1",
				Array.from({ length: 1000 }, () => ({ ...f.rows[0]! })),
			),
		).toBe(false);
		expect(await readPlexGenerationTargetsForReuse(tx, "plex-1", 1000)).toBeNull();
	});

	it("does not trust an empty expected inventory when any stored row remains", async () => {
		const f = fixture();
		expect(
			await hasSamePersistedPlexCacheRows(
				f.tx as unknown as Prisma.TransactionClient,
				"plex-1",
				[],
			),
		).toBe(false);
		expect(
			await readPlexGenerationTargetsForReuse(
				f.tx as unknown as Prisma.TransactionClient,
				"plex-1",
				0,
			),
		).toBeNull();
	});
});
