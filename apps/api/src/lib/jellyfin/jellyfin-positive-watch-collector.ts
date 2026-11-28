import { createHash } from "node:crypto";
import type { JellyfinClient, JellyfinEpisodeItemsPage } from "./jellyfin-client.js";
import {
	deriveNativeWatchCandidates,
	type NativeWatchCandidate,
	type NativeWatchStageRow,
} from "./jellyfin-native-watch-projection.js";

const DEFAULT_PAGE_SIZE = 1_000;
const MAX_SCOPES = 256;
const MAX_ROWS_PER_PASS = 25_000;

type PlayedClient = Pick<JellyfinClient, "getPlayedEpisodeItemsPageWithCoverage">;
export type PositiveWatchScope = { userId: string; libraryId: string };

export type PositiveWatchCollection = {
	scopeCount: number;
	candidates: NativeWatchCandidate[];
};

function userKeyDigest(userId: string): string {
	return createHash("sha256")
		.update(JSON.stringify(["jellyfin-user", userId]))
		.digest("hex");
}

function isObservedEpisode(
	item: JellyfinEpisodeItemsPage["items"][number],
): item is Extract<JellyfinEpisodeItemsPage["items"][number], { played: boolean }> {
	return "played" in item;
}

async function readScope(
	client: PlayedClient,
	scope: PositiveWatchScope,
	pageSize: number,
	remainingRows: number,
): Promise<{ rows: NativeWatchStageRow[]; rawCount: number }> {
	let cursor = 0;
	let expectedTotal: number | null = null;
	const rows: NativeWatchStageRow[] = [];
	const seen = new Set<string>();
	for (;;) {
		const page = await client.getPlayedEpisodeItemsPageWithCoverage(
			scope.userId,
			scope.libraryId,
			cursor,
			pageSize,
		);
		if (
			!Number.isSafeInteger(page.startIndex) ||
			!Number.isSafeInteger(page.totalRecordCount) ||
			page.startIndex !== cursor ||
			page.totalRecordCount < 0 ||
			page.totalRecordCount > remainingRows ||
			(expectedTotal !== null && page.totalRecordCount !== expectedTotal) ||
			page.items.length > pageSize ||
			cursor + page.items.length > page.totalRecordCount ||
			(page.items.length === 0 && cursor < page.totalRecordCount)
		)
			throw new Error("Jellyfin positive watch page coverage is inconsistent");
		expectedTotal = page.totalRecordCount;
		for (const item of page.items) {
			if (!item.id.trim() || seen.has(item.id))
				throw new Error("Jellyfin positive watch page contains a duplicate or invalid ID");
			seen.add(item.id);
			if (!isObservedEpisode(item)) continue;
			if (item.played !== true)
				throw new Error("Jellyfin positive watch page contains an unplayed row");
			rows.push({
				userKeyDigest: userKeyDigest(scope.userId),
				libraryId: scope.libraryId,
				jellyfinId: item.id,
				seriesId: item.seriesId,
				seasonNumber: item.seasonNumber,
				episodeNumber: item.episodeNumber,
				played: true,
				playCount: item.playCount,
				lastPlayedAt: item.lastPlayedDate ? new Date(item.lastPlayedDate) : null,
			});
		}
		cursor += page.items.length;
		if (cursor === expectedTotal) return { rows, rawCount: cursor };
	}
}

/** A bounded two-pass positive read. Filtered absence is deliberately discarded. */
export async function collectJellyfinPositiveWatchCandidates(
	client: PlayedClient,
	scopes: readonly PositiveWatchScope[],
	options: { pageSize?: number; maxRowsPerPass?: number } = {},
): Promise<PositiveWatchCollection> {
	const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
	const maxRowsPerPass = options.maxRowsPerPass ?? MAX_ROWS_PER_PASS;
	if (
		!Number.isSafeInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > DEFAULT_PAGE_SIZE ||
		!Number.isSafeInteger(maxRowsPerPass) ||
		maxRowsPerPass < 1 ||
		scopes.length < 1 ||
		scopes.length > MAX_SCOPES
	)
		throw new Error("Jellyfin positive watch collection bounds are invalid");
	const scopeKeys = new Set<string>();
	for (const scope of scopes) {
		const key = `${scope.userId}\0${scope.libraryId}`;
		if (
			!scope.userId.trim() ||
			!scope.libraryId.trim() ||
			scope.userId.includes("\0") ||
			scope.libraryId.includes("\0") ||
			scopeKeys.has(key)
		)
			throw new Error("Jellyfin positive watch scope is invalid");
		scopeKeys.add(key);
	}
	const passes: NativeWatchStageRow[][] = [];
	for (let pass = 0; pass < 2; pass += 1) {
		const rows: NativeWatchStageRow[] = [];
		let rawCount = 0;
		for (const scope of scopes) {
			const observed = await readScope(client, scope, pageSize, maxRowsPerPass - rawCount);
			rows.push(...observed.rows);
			rawCount += observed.rawCount;
		}
		passes.push(rows);
	}
	return {
		scopeCount: scopes.length,
		candidates: deriveNativeWatchCandidates(passes[0]!, passes[1]!).filter(
			(candidate) => candidate.played,
		),
	};
}
