import { describe, expect, it } from "vitest";
import {
	effectiveLibraryQuery,
	effectiveTorrentWhere,
	libraryQuiStatus,
	sameLibraryQuiView,
	verifiedLibraryProjection,
	type LibraryQuiView,
} from "../qui-observation-view.js";
import { libraryQuerySchema } from "../validation-schemas.js";
const time = new Date("2026-10-25T10:00:00Z");
const available: LibraryQuiView = {
	status: "available",
	generation: "synthetic-generation",
	observedAt: time,
	rows: new Map(),
};
describe("Library qUI receipt-derived view", () => {
	it("discards changed, missing, future/stale-refused and source-refused receipts instead of comparing only timestamps", () => {
		expect(sameLibraryQuiView(available, { ...available, generation: "replacement" })).toBe(false);
		expect(
			sameLibraryQuiView(available, { ...available, observedAt: new Date(time.getTime() + 1) }),
		).toBe(false);
		expect(sameLibraryQuiView(available, { status: "unavailable" })).toBe(false);
		expect(sameLibraryQuiView(available, { status: "not_configured" })).toBe(false);
		expect(sameLibraryQuiView(available, { ...available, observedAt: new Date(time) })).toBe(true);
	});
	it("only exposes the validated observation START and sanitizes private publication identity", () => {
		expect(libraryQuiStatus(available)).toEqual({
			status: "available",
			observedAt: "2026-10-25T10:00:00.000Z",
		});
		expect(libraryQuiStatus({ status: "not_configured" })).toEqual({
			status: "not_configured",
			observedAt: null,
		});
		expect(libraryQuiStatus({ status: "unavailable" })).toEqual({
			status: "unavailable",
			observedAt: null,
		});
	});
	it("does not trust timestamps from a different publication and preserves a valid state with unknown ratio", () => {
		const row = { torrentSyncedAt: time, torrentState: "seeding", torrentRatio: null };
		expect(verifiedLibraryProjection(row, available)).toEqual({
			torrentState: "seeding",
			torrentRatio: null,
		});
		expect(
			verifiedLibraryProjection(
				{ ...row, torrentSyncedAt: new Date(0), torrentRatio: 99 },
				available,
			),
		).toEqual({ torrentState: null, torrentRatio: null });
		expect(
			verifiedLibraryProjection({ ...row, torrentRatio: 99 }, { status: "unavailable" }),
		).toEqual({ torrentState: null, torrentRatio: null });
	});
	it("changes only unavailable qUI filter/sort semantics while preserving scoped non-qUI filters", () => {
		const query = libraryQuerySchema.parse({
			instanceId: "owned",
			torrentState: "paused",
			sortBy: "torrentRatio",
			sortOrder: "desc",
			status: "released",
			page: 3,
			limit: 7,
		});
		expect(effectiveLibraryQuery(query, { status: "unavailable" })).toEqual({
			...query,
			torrentState: "all",
			sortBy: "sortTitle",
		});
		expect(effectiveLibraryQuery(query, available)).toBe(query);
		expect(
			effectiveLibraryQuery({ ...query, sortBy: "title" }, { status: "not_configured" }).sortBy,
		).toBe("title");
	});
	it("defines none as no available cached projection, not evidence of provider absence", () => {
		expect(effectiveTorrentWhere({ instanceId: "owned" }, available, "none")).toEqual({
			AND: [
				{ instanceId: "owned" },
				{
					OR: [
						{ torrentSyncedAt: null },
						{ torrentSyncedAt: { not: time } },
						{ torrentState: null },
					],
				},
			],
		});
		expect(effectiveTorrentWhere({ instanceId: "owned" }, available, "paused")).toEqual({
			AND: [{ instanceId: "owned" }, { torrentSyncedAt: time, torrentState: "paused" }],
		});
	});
});
