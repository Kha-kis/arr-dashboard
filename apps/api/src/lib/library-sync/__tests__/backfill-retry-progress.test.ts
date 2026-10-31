import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMatchFile = vi.hoisted(() => vi.fn());
const mockBuildFileIdIndex = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../../qui/client-factory.js", () => ({
	createQuiClient: () => ({}),
}));
vi.mock("../../qui/observation-topology-guard.js", () => ({
	withQuiObservationTopologyGuard: async (_userId: string, action: () => Promise<unknown>) =>
		action(),
}));
vi.mock("../../qui/topology-generation.js", () => ({
	captureQuiTopologyGeneration: () => "topology",
	assertQuiTopologyGenerationCurrent: async () => undefined,
}));
vi.mock("../infohash-backfill-by-inode.js", () => ({
	buildFileIdIndex: mockBuildFileIdIndex,
	matchLibraryByFileId: mockMatchFile,
}));

import { runEpisodeBackfillSweep } from "../episode-file-backfill.js";
import { runPathBackfillSweep } from "../infohash-backfill-by-path.js";

function makeApp(kind: "movie" | "episode") {
	const rows = Array.from({ length: 501 }, (_, index) => ({
		id: `row-${index}`,
		data: "{}",
		title: "Synthetic",
		path: "/synthetic/not-present.mkv",
		size: 1n,
		arrSeriesId: 1,
		relativePath: "not-present.mkv",
		retryAfter: null as Date | null,
	}));
	const findRows = vi.fn(
		async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
			const retryField = kind === "movie" ? "pathBackfillRetryAfter" : "inodeBackfillRetryAfter";
			const dueOnly = Object.hasOwn(where, retryField);
			return rows
				.filter((row) =>
					dueOnly
						? row.retryAfter !== null && row.retryAfter <= new Date()
						: !row.retryAfter || row.retryAfter <= new Date(),
				)
				.slice(0, take)
				.map((row) => ({ ...row }));
		},
	);
	const defer = vi.fn(
		async ({
			where,
			data,
		}: {
			where: { id: string; path?: string; size?: bigint; data?: string };
			data: Record<string, unknown>;
		}) => {
			const row = rows.find((candidate) => candidate.id === where.id);
			if (!row) return { count: 0 };
			if (where.path !== undefined && where.path !== row.path) return { count: 0 };
			if (where.size !== undefined && where.size !== row.size) return { count: 0 };
			if (where.data !== undefined && where.data !== row.data) return { count: 0 };
			row.retryAfter =
				(data.pathBackfillRetryAfter as Date | undefined) ??
				(data.inodeBackfillRetryAfter as Date | undefined) ??
				null;
			return { count: 1 };
		},
	);
	return {
		app: {
			prisma: {
				serviceInstance: {
					findMany: vi.fn(async ({ where }: { where: { userId?: string } }) =>
						where.userId
							? [{ id: "qui-1", userId: "owner-1", hasLocalFilesystemAccess: true }]
							: [{ userId: "owner-1" }],
					),
				},
				libraryCache: { findMany: kind === "movie" ? findRows : vi.fn(), updateMany: defer },
				episodeFileCache: { findMany: kind === "episode" ? findRows : vi.fn(), updateMany: defer },
			},
		},
		rows,
		findRows,
		defer,
	};
}

describe("backfill retry progress", () => {
	beforeEach(() => {
		mockMatchFile.mockResolvedValue(null);
		mockBuildFileIdIndex.mockClear();
	});
	it.each(["movie", "episode"] as const)(
		"persists the %s backfill's cold qUI inode index",
		async (kind) => {
			const { app } = makeApp(kind);
			if (kind === "movie") {
				await runPathBackfillSweep({ app: app as never, batchSize: 1 });
			} else {
				await runEpisodeBackfillSweep({ app: app as never, batchSize: 1 });
			}
			expect(mockBuildFileIdIndex).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ id: "qui-1" }),
				undefined,
				app.prisma,
			);
		},
	);
	it("reaches movie row 501 after deferring 500 invalid fingerprints", async () => {
		const { app, rows, defer } = makeApp("movie");
		const first = await runPathBackfillSweep({ app: app as never, batchSize: 500 });
		const second = await runPathBackfillSweep({ app: app as never, batchSize: 500 });
		expect(first.rowsMissed).toBe(500);
		expect(second.rowsScanned).toBe(1);
		expect(rows[500]?.retryAfter).toBeInstanceOf(Date);
		expect(defer).toHaveBeenCalledTimes(501);
	});

	it("reaches episode row 501 after deferring 500 unmatched files", async () => {
		const { app, rows, defer } = makeApp("episode");
		const first = await runEpisodeBackfillSweep({ app: app as never, batchSize: 500 });
		const second = await runEpisodeBackfillSweep({ app: app as never, batchSize: 500 });
		expect(first.rowsMissed).toBe(500);
		expect(second.rowsScanned).toBe(1);
		expect(rows[500]?.retryAfter).toBeInstanceOf(Date);
		expect(defer).toHaveBeenCalledTimes(501);
	});

	it.each(["movie", "episode"] as const)(
		"due-only %s recovery ignores a large untried backlog",
		async (kind) => {
			const { app, rows, findRows } = makeApp(kind);
			rows[0]!.retryAfter = new Date(Date.now() - 1_000);
			const result =
				kind === "movie"
					? await runPathBackfillSweep({ app: app as never, batchSize: 500, dueOnly: true })
					: await runEpisodeBackfillSweep({ app: app as never, batchSize: 500, dueOnly: true });
			expect(result.rowsScanned).toBe(1);
			expect(findRows).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						[kind === "movie" ? "pathBackfillRetryAfter" : "inodeBackfillRetryAfter"]: {
							lte: expect.any(Date),
						},
					}),
				}),
			);
		},
	);

	it("does not publish a movie hash after Radarr changes the file during matching", async () => {
		const { app, rows, defer } = makeApp("movie");
		rows[0]!.data = JSON.stringify({
			path: "/synthetic",
			movieFile: { relativePath: "old.mkv", size: 1 },
		});
		mockMatchFile.mockImplementationOnce(async () => {
			rows[0]!.data = JSON.stringify({
				path: "/synthetic",
				movieFile: { relativePath: "new.mkv", size: 1 },
			});
			return { hash: "a".repeat(40), source: "inode" };
		});
		const result = await runPathBackfillSweep({ app: app as never, batchSize: 1 });
		expect(result.rowsHashed).toBe(0);
		expect(result.rowsMissed).toBe(1);
		expect(defer).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ data: expect.any(String) }) }),
		);
	});

	it("does not publish an episode hash after Sonarr changes the file during matching", async () => {
		const { app, rows, defer } = makeApp("episode");
		mockMatchFile.mockImplementationOnce(async () => {
			rows[0]!.path = "/synthetic/replaced.mkv";
			return { hash: "b".repeat(40), source: "inode" };
		});
		const result = await runEpisodeBackfillSweep({ app: app as never, batchSize: 1 });
		expect(result.rowsHashed).toBe(0);
		expect(result.rowsMissed).toBe(1);
		expect(defer).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ path: "/synthetic/not-present.mkv" }),
			}),
		);
	});
});
