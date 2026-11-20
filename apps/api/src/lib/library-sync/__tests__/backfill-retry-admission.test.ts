import { describe, expect, it, vi } from "vitest";
import {
	countBackfillCandidates,
	countDueDeferredCorrelationCandidates,
	countOutstandingBackfillCandidates,
} from "../infohash-backfill.js";

describe("backfill catch-up admission", () => {
	it("includes due episode files even when there is no library-row backlog", async () => {
		const libraryCount = vi.fn().mockResolvedValue(0);
		const episodeCount = vi.fn().mockResolvedValue(21_896);
		const app = {
			prisma: {
				serviceInstance: {
					findMany: vi.fn().mockResolvedValue([{ userId: "owner-1" }]),
				},
				libraryCache: { count: libraryCount },
				episodeFileCache: { count: episodeCount },
			},
		};
		expect(await countBackfillCandidates(app as never)).toBe(21_896);
		expect(episodeCount).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					infoHash: null,
					instance: { userId: { in: ["owner-1"] }, service: "SONARR" },
				}),
			}),
		);
	});

	it("distinguishes deferred backlog from a completed backlog", async () => {
		const app = {
			prisma: {
				serviceInstance: { findMany: vi.fn().mockResolvedValue([{ userId: "owner-1" }]) },
				libraryCache: { count: vi.fn().mockResolvedValue(714) },
				episodeFileCache: { count: vi.fn().mockResolvedValue(21_896) },
			},
		};
		expect(await countOutstandingBackfillCandidates(app as never)).toBe(22_610);
		expect(await countDueDeferredCorrelationCandidates(app as never)).toBe(22_610);
		expect(app.prisma.libraryCache.count).toHaveBeenCalledWith({
			where: expect.objectContaining({
				infoHash: null,
				itemType: "movie",
				pathBackfillRetryAfter: { lte: expect.any(Date) },
			}),
		});
		expect(app.prisma.episodeFileCache.count).toHaveBeenCalledWith({
			where: expect.objectContaining({
				infoHash: null,
				inodeBackfillRetryAfter: { lte: expect.any(Date) },
			}),
		});
	});
});
