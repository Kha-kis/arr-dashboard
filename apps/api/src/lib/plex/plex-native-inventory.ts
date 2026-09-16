import {
	hasNativeInventoryExternalIds,
	reconcileNativeInventoryIdentifiers,
	type NativeInventoryDomain,
	type NativeInventoryRow,
} from "../provider-observation/native-inventory.js";
import type { PlexClient, PlexCompletePageResult, PlexSettlementLibrary } from "./plex-client.js";
import { evaluatePlexLiveSettlement } from "./plex-live-settlement.js";

export interface CollectedNativeInventory {
	domain: NativeInventoryDomain;
	scopeKeys: string[];
	rows: NativeInventoryRow[];
}

export type PlexNativeInventoryResult =
	| { complete: true; snapshots: CollectedNativeInventory[] }
	| { complete: false; reason: "coverage-incomplete" | "provider-unavailable" };

class IncompleteNativeInventory extends Error {}

function validKey(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function requireCompletePage<T>(page: PlexCompletePageResult<T>): T[] {
	if (page.reason !== null) throw new Error("Native inventory request failed");
	if (
		!Array.isArray(page.items) ||
		!Number.isSafeInteger(page.expectedRawCount) ||
		page.expectedRawCount !== page.items.length ||
		page.rawObserved !== page.items.length ||
		!Number.isSafeInteger(page.pagesAttempted) ||
		page.pagesAttempted < 1 ||
		page.pagesCompleted !== page.pagesAttempted
	)
		throw new IncompleteNativeInventory();
	return page.items;
}

async function probe(client: PlexClient): Promise<PlexSettlementLibrary[]> {
	const [activities, sections] = await Promise.all([
		client.getActivities({ uncached: true }),
		client.getLibrarySettlementSections({ uncached: true }),
	]);
	const selected = sections.filter(
		(section) => section.type === "movie" || section.type === "show",
	);
	if (
		selected.some((s) => !validKey(s.key) || !validKey(s.uuid)) ||
		new Set(selected.map((s) => s.key)).size !== selected.length ||
		new Set(selected.map((s) => s.uuid)).size !== selected.length ||
		!evaluatePlexLiveSettlement({
			activities,
			sections,
			selectedSectionKeys: selected.map((s) => s.key),
		}).settled
	) {
		throw new IncompleteNativeInventory();
	}
	return selected.sort((a, b) => a.key.localeCompare(b.key));
}

function catalogIdentity(sections: readonly PlexSettlementLibrary[]): string {
	return JSON.stringify(sections.map((s) => [s.key, s.uuid, s.type, s.scannedAt, s.updatedAt]));
}

function inventoryIdentity(snapshots: readonly CollectedNativeInventory[]): string {
	return JSON.stringify(
		snapshots.map((snapshot) => ({
			domain: snapshot.domain,
			scopes: snapshot.scopeKeys,
			rows: [...snapshot.rows]
				.sort((a, b) => a.nativeId.localeCompare(b.nativeId))
				.map((row) => [
					row.nativeId,
					row.mediaType,
					row.libraryIds,
					row.parentNativeId,
					row.seasonNumber,
					row.episodeNumber,
				]),
		})),
	);
}

async function collectPass(
	client: PlexClient,
	sections: readonly PlexSettlementLibrary[],
): Promise<CollectedNativeInventory[]> {
	const library: CollectedNativeInventory = { domain: "library", scopeKeys: [], rows: [] };
	const episode: CollectedNativeInventory = { domain: "episode", scopeKeys: [], rows: [] };
	const seen = new Set<string>();
	const admitKey = (key: string) => {
		if (!validKey(key) || seen.has(key)) throw new IncompleteNativeInventory();
		seen.add(key);
	};
	for (const section of sections) {
		const scopeKey = JSON.stringify([section.key, section.uuid, section.type]);
		library.scopeKeys.push(scopeKey);
		const items = requireCompletePage(await client.getNativeLibraryItemsWithCoverage(section.key));
		for (const item of items) {
			admitKey(item.ratingKey);
			// Plex may include collection containers in /all. They are not movie/series items.
			if (item.type === "collection") continue;
			if (item.type !== section.type) throw new IncompleteNativeInventory();
			const externalIds = item.externalIds;
			library.rows.push({
				nativeId: item.ratingKey,
				mediaType: item.type === "show" ? "series" : "movie",
				libraryIds: [section.key],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: item.title,
				...(hasNativeInventoryExternalIds(externalIds) ? { externalIds } : {}),
			});
		}
		if (section.type !== "show") continue;
		episode.scopeKeys.push(scopeKey);
		const episodes = requireCompletePage(
			await client.getNativeEpisodeItemsWithCoverage(section.key),
		);
		for (const item of episodes) {
			admitKey(item.ratingKey);
			if (item.type !== "episode") throw new IncompleteNativeInventory();
			episode.rows.push({
				nativeId: item.ratingKey,
				mediaType: "episode",
				libraryIds: [section.key],
				parentNativeId: item.grandparentRatingKey,
				seasonNumber: item.seasonNumber,
				episodeNumber: item.episodeNumber,
				title: item.title,
			});
		}
	}
	return [library, episode];
}

/**
 * Native presence is independent of GUID mapping, account history and watch
 * metadata. Publish only two matching complete passes bracketed by unchanged,
 * settled catalogs. The caller owns the live provider identity/publication guard.
 */
export async function collectPlexNativeInventory(
	client: PlexClient,
): Promise<PlexNativeInventoryResult> {
	try {
		const before = await probe(client);
		const first = await collectPass(client, before);
		const between = await probe(client);
		if (catalogIdentity(before) !== catalogIdentity(between)) throw new IncompleteNativeInventory();
		const second = await collectPass(client, between);
		const after = await probe(client);
		if (
			catalogIdentity(between) !== catalogIdentity(after) ||
			inventoryIdentity(first) !== inventoryIdentity(second)
		)
			throw new IncompleteNativeInventory();
		return {
			complete: true,
			snapshots: second.map((snapshot) => ({
				...snapshot,
				rows: reconcileNativeInventoryIdentifiers(
					first.find((prior) => prior.domain === snapshot.domain)?.rows ?? [],
					snapshot.rows,
				),
			})),
		};
	} catch (error) {
		return {
			complete: false,
			reason:
				error instanceof IncompleteNativeInventory ? "coverage-incomplete" : "provider-unavailable",
		};
	}
}
