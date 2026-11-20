import type { QuiObservationStatus, TorrentStateCounts } from "@arr/shared";
import type { z } from "zod";
import type { PrismaClient, Prisma } from "../prisma.js";
import {
	readQuiTorrentObservations,
	type QuiObservationRead,
} from "../qui/torrent-observation-repository.js";
import type { libraryQuerySchema } from "./validation-schemas.js";

export type LibraryQuery = z.infer<typeof libraryQuerySchema>;
export type LibraryQuiView = QuiObservationRead;
export const unavailableLibraryQuiView = (): LibraryQuiView => ({ status: "unavailable" });

/** Reuse all owner/topology/count/freshness/postflight checks, never just head.complete. */
export const readLibraryQuiView = (prisma: PrismaClient, userId: string) =>
	readQuiTorrentObservations(prisma, userId, []);

export function sameLibraryQuiView(before: LibraryQuiView, after: LibraryQuiView): boolean {
	return (
		before.status === "available" &&
		after.status === "available" &&
		before.generation === after.generation &&
		before.observedAt.getTime() === after.observedAt.getTime()
	);
}

export function libraryQuiStatus(view: LibraryQuiView): QuiObservationStatus {
	return {
		status:
			view.status === "available"
				? "available"
				: view.status === "not_configured"
					? "not_configured"
					: "unavailable",
		observedAt: view.status === "available" ? view.observedAt.toISOString() : null,
	};
}

export function effectiveLibraryQuery(query: LibraryQuery, view: LibraryQuiView): LibraryQuery {
	return view.status === "available"
		? query
		: {
				...query,
				torrentState: "all",
				sortBy: query.sortBy === "torrentRatio" ? "sortTitle" : query.sortBy,
			};
}

export function effectiveTorrentWhere(
	base: Prisma.LibraryCacheWhereInput,
	view: LibraryQuiView,
	state: LibraryQuery["torrentState"],
): Prisma.LibraryCacheWhereInput {
	if (view.status !== "available" || state === "all") return base;
	if (state === "none")
		return {
			AND: [
				base,
				{
					OR: [
						{ torrentSyncedAt: null },
						{ torrentSyncedAt: { not: view.observedAt } },
						{ torrentState: null },
					],
				},
			],
		};
	return { AND: [base, { torrentSyncedAt: view.observedAt, torrentState: state }] };
}

export function verifiedLibraryProjection(
	row: { torrentSyncedAt: Date | null; torrentState: string | null; torrentRatio: number | null },
	view: LibraryQuiView,
) {
	return view.status === "available" && row.torrentSyncedAt?.getTime() === view.observedAt.getTime()
		? { torrentState: row.torrentState, torrentRatio: row.torrentRatio }
		: { torrentState: null, torrentRatio: null };
}

/** At most two bounded pages. No materialized whole-library sorting or hash IN list. */
export async function readLibraryQuiPage(
	prisma: PrismaClient,
	base: Prisma.LibraryCacheWhereInput,
	view: LibraryQuiView,
	query: LibraryQuery,
) {
	const where = effectiveTorrentWhere(base, view, query.torrentState),
		totalItems = await prisma.libraryCache.count({ where });
	const skip = (query.page - 1) * query.limit;
	if (query.sortBy === "torrentRatio" && view.status === "available") {
		const numeric: Prisma.LibraryCacheWhereInput = {
			AND: [where, { torrentSyncedAt: view.observedAt, torrentRatio: { not: null } }],
		};
		const effectiveNull: Prisma.LibraryCacheWhereInput = {
			AND: [
				where,
				{
					OR: [
						{ torrentSyncedAt: null },
						{ torrentSyncedAt: { not: view.observedAt } },
						{ torrentRatio: null },
					],
				},
			],
		};
		const numericCount = await prisma.libraryCache.count({ where: numeric });
		const numericTake = Math.min(query.limit, Math.max(0, numericCount - skip));
		const first = numericTake
			? await prisma.libraryCache.findMany({
					where: numeric,
					orderBy: [{ torrentRatio: query.sortOrder }, { sortTitle: "asc" }, { id: "asc" }],
					skip,
					take: numericTake,
				})
			: [];
		const remaining = Math.min(
			query.limit - first.length,
			Math.max(0, totalItems - Math.max(skip, numericCount)),
		);
		const last = remaining
			? await prisma.libraryCache.findMany({
					where: effectiveNull,
					orderBy: [{ sortTitle: "asc" }, { id: "asc" }],
					skip: Math.max(0, skip - numericCount),
					take: remaining,
				})
			: [];
		return { totalItems, cachedItems: [...first, ...last] };
	}
	const field = query.sortBy === "added" ? "arrAddedAt" : query.sortBy;
	const orderBy: Prisma.LibraryCacheOrderByWithRelationInput[] = [
		{ [field]: query.sortOrder },
		{ id: "asc" },
	];
	return {
		totalItems,
		cachedItems: await prisma.libraryCache.findMany({ where, orderBy, skip, take: query.limit }),
	};
}

export async function libraryQuiCounts(
	prisma: PrismaClient,
	base: Prisma.LibraryCacheWhereInput,
	view: LibraryQuiView,
): Promise<TorrentStateCounts | undefined> {
	if (view.status !== "available") return undefined;
	const [groups, all] = await Promise.all([
		prisma.libraryCache.groupBy({
			by: ["torrentState"],
			where: { AND: [base, { torrentSyncedAt: view.observedAt, torrentState: { not: null } }] },
			_count: { _all: true },
		}),
		prisma.libraryCache.count({ where: base }),
	]);
	const counts: TorrentStateCounts = {
		all,
		none: all,
		seeding: 0,
		downloading: 0,
		stalled_dl: 0,
		paused: 0,
		queued: 0,
		checking: 0,
		moving: 0,
		error: 0,
		unknown: 0,
	};
	for (const group of groups)
		if (
			group.torrentState &&
			group.torrentState !== "all" &&
			group.torrentState !== "none" &&
			Object.hasOwn(counts, group.torrentState)
		) {
			counts[group.torrentState as Exclude<keyof TorrentStateCounts, "all" | "none">] =
				group._count._all;
			counts.none -= group._count._all;
		}
	return counts;
}
