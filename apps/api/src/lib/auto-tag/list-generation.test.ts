import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../prisma.js";
import { publishTmdbListGeneration, publishTraktListGeneration } from "./list-cache-refresher.js";
import { loadCompleteListEvidence } from "./list-evidence-loader.js";

type Row = {
	userId: string;
	listKey: string;
	tmdbId: number;
	mediaType: string;
	title: string;
	generation: string;
	refreshedAt: Date;
};

type Status = {
	userId: string;
	provider: string;
	listKey: string;
	generationId: string | null;
	lastRefreshedAt: Date | null;
	lastResult: string | null;
	lastErrorMessage: string | null;
	itemCount: number;
	lastAttemptAt: Date | null;
	lastAttemptResult: string | null;
	lastAttemptErrorMessage: string | null;
};

function successfulStatus(overrides: Partial<Status> = {}): Status {
	const now = new Date();
	return {
		userId: "user-1",
		provider: "tmdb",
		listKey: "list-1",
		generationId: "generation-1",
		lastRefreshedAt: now,
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: 2,
		lastAttemptAt: now,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		...overrides,
	};
}

function createAtomicPublisherPrisma(provider: "tmdb" | "trakt", failCreate = false) {
	let rows: Row[] = [
		{
			userId: "user-1",
			listKey: "list-1",
			tmdbId: 7,
			mediaType: "movie",
			title: "Previous",
			generation: "previous-generation",
			refreshedAt: new Date("2026-08-01T00:00:00.000Z"),
		},
	];
	let status = successfulStatus({
		provider,
		generationId: "previous-generation",
		itemCount: 1,
	});

	const prisma = {
		$transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) => {
			let draftRows = structuredClone(rows);
			let draftStatus = structuredClone(status);
			const cache = {
				deleteMany: vi.fn(async () => {
					draftRows = [];
					return { count: rows.length };
				}),
				createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
					if (failCreate) throw new Error("interrupted publication");
					draftRows = data.map((row) => ({
						userId: row.userId as string,
						listKey: (row.listId ?? row.listSlug) as string,
						tmdbId: row.tmdbId as number,
						mediaType: row.mediaType as string,
						title: row.title as string,
						generation: row.generation as string,
						refreshedAt: row.refreshedAt as Date,
					}));
					return { count: data.length };
				}),
			};
			const tx = {
				tmdbListCache: cache,
				traktListCache: cache,
				listCacheRefreshStatus: {
					upsert: vi.fn(async ({ create, update }: { create: Status; update: Partial<Status> }) => {
						draftStatus = status ? { ...draftStatus, ...update } : create;
						return draftStatus;
					}),
				},
			};
			await callback(tx);
			rows = draftRows;
			status = draftStatus;
		}),
	} as unknown as PrismaClient;

	return { prisma, rows: () => rows, status: () => status };
}

function createEvidencePrisma(statuses: Status[], rows: Row[]): PrismaClient {
	const tx = {
		listCacheRefreshStatus: {
			findMany: vi.fn(async () => statuses),
		},
		tmdbListCache: {
			findMany: vi.fn(async ({ where }: { where: { generation: string; listId: string } }) =>
				rows
					.filter((row) => row.generation === where.generation && row.listKey === where.listId)
					.map(({ tmdbId, mediaType }) => ({ tmdbId, mediaType })),
			),
		},
		traktListCache: {
			findMany: vi.fn(async ({ where }: { where: { generation: string; listSlug: string } }) =>
				rows
					.filter((row) => row.generation === where.generation && row.listKey === where.listSlug)
					.map(({ tmdbId, mediaType }) => ({ tmdbId, mediaType })),
			),
		},
	};
	return {
		$transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
	} as unknown as PrismaClient;
}

describe("atomic typed list generations", () => {
	it.each(["tmdb", "trakt"] as const)(
		"preserves movie/series collisions for %s",
		async (provider) => {
			const state = createAtomicPublisherPrisma(provider);
			const items = [
				{ tmdbId: 42, mediaType: "movie" as const, title: "Movie 42" },
				{ tmdbId: 42, mediaType: "series" as const, title: "Series 42" },
			];
			if (provider === "tmdb") {
				await publishTmdbListGeneration(state.prisma, "user-1", "list-1", items);
			} else {
				await publishTraktListGeneration(state.prisma, "user-1", "list-1", items);
			}

			expect(
				state
					.rows()
					.map((row) => `${row.mediaType}:${row.tmdbId}`)
					.sort(),
			).toEqual(["movie:42", "series:42"]);
			expect(new Set(state.rows().map((row) => row.generation))).toEqual(
				new Set([state.status().generationId]),
			);
			expect(state.status()).toMatchObject({
				lastResult: "success",
				lastAttemptResult: "success",
				itemCount: 2,
			});
		},
	);

	it("rolls back replacement rows and the pointer when publication is interrupted", async () => {
		const state = createAtomicPublisherPrisma("tmdb", true);

		await expect(
			publishTmdbListGeneration(state.prisma, "user-1", "list-1", [
				{ tmdbId: 42, mediaType: "movie", title: "Movie 42" },
			]),
		).rejects.toThrow("interrupted publication");

		expect(state.rows()).toEqual([
			expect.objectContaining({ tmdbId: 7, generation: "previous-generation" }),
		]);
		expect(state.status()).toMatchObject({ generationId: "previous-generation", itemCount: 1 });
	});

	it("publishes a complete empty generation", async () => {
		const state = createAtomicPublisherPrisma("trakt");

		await publishTraktListGeneration(state.prisma, "user-1", "list-1", []);

		expect(state.rows()).toEqual([]);
		expect(state.status()).toMatchObject({
			generationId: expect.any(String),
			lastResult: "success",
			itemCount: 0,
		});
	});
});

describe("completeness-qualified list evidence", () => {
	const rows: Row[] = [
		{
			userId: "user-1",
			listKey: "list-1",
			tmdbId: 42,
			mediaType: "movie",
			title: "Movie 42",
			generation: "generation-1",
			refreshedAt: new Date(),
		},
		{
			userId: "user-1",
			listKey: "list-1",
			tmdbId: 42,
			mediaType: "series",
			title: "Series 42",
			generation: "generation-1",
			refreshedAt: new Date(),
		},
	];

	it("loads typed movie and series identities from one complete generation", async () => {
		const evidence = await loadCompleteListEvidence(
			createEvidencePrisma([successfulStatus()], rows),
			"user-1",
			"tmdb",
			["list-1"],
		);

		expect(evidence?.memberships.get("list-1")).toEqual(new Set(["movie:42", "series:42"]));
	});

	it("accepts a complete empty generation as known empty", async () => {
		const evidence = await loadCompleteListEvidence(
			createEvidencePrisma([successfulStatus({ itemCount: 0 })], []),
			"user-1",
			"tmdb",
			["list-1"],
		);

		expect(evidence?.memberships.get("list-1")).toEqual(new Set());
	});

	it.each([
		["first run", []],
		[
			"newer failed attempt",
			[
				successfulStatus({
					lastErrorMessage: "upstream failed",
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "upstream failed",
				}),
			],
		],
		["interrupted row publication", [successfulStatus({ itemCount: 3 })]],
	] as const)("keeps %s evidence unknown", async (_label, statuses) => {
		const evidence = await loadCompleteListEvidence(
			createEvidencePrisma([...statuses], rows),
			"user-1",
			"tmdb",
			["list-1"],
		);

		expect(evidence).toBeUndefined();
	});
});
