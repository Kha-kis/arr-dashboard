import type { NativeInventoryRow } from "../provider-observation/native-inventory.js";
import type {
	JellyfinClient,
	JellyfinLibrary,
	JellyfinNativeEpisodeItem,
} from "./jellyfin-client.js";

export interface CollectedJellyfinNativeEpisodeInventory {
	domain: "episode";
	scopeKeys: string[];
	rows: NativeInventoryRow[];
}

export type JellyfinNativeEpisodeInventoryResult =
	| { complete: true; snapshots: [CollectedJellyfinNativeEpisodeInventory] }
	| { complete: false; reason: "coverage-incomplete" | "provider-unavailable" };

interface JellyfinNativeEpisodeScope {
	libraryId: string;
	collectionType: string;
	scopeKey: string;
}

interface JellyfinNativeEpisodePass {
	snapshot: CollectedJellyfinNativeEpisodeInventory;
	scopedItems: Array<{ scopeKey: string; id: string }>;
}

class IncompleteJellyfinNativeEpisodeInventory extends Error {}
class UnavailableJellyfinNativeEpisodeInventory extends Error {}

function validIdentity(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function normalizeOptionalString(value: unknown): string | null {
	return validIdentity(value) ? value : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function coordinate(item: JellyfinNativeEpisodeItem): {
	parentNativeId: string | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
} {
	const parentNativeId = normalizeOptionalString(item.seriesId);
	const seasonNumber = normalizeOptionalNumber(item.seasonNumber);
	const episodeNumber = normalizeOptionalNumber(item.episodeNumber);
	if (parentNativeId === null || seasonNumber === null || episodeNumber === null) {
		return { parentNativeId: null, seasonNumber: null, episodeNumber: null };
	}
	return { parentNativeId, seasonNumber, episodeNumber };
}

function requireCompletePage(
	page: Awaited<ReturnType<JellyfinClient["getNativeEpisodeItemsWithCoverage"]>>,
): JellyfinNativeEpisodeItem[] {
	if (
		page.reason !== null ||
		!Array.isArray(page.items) ||
		!Number.isSafeInteger(page.expectedRawCount) ||
		page.expectedRawCount !== page.items.length ||
		page.rawObserved !== page.items.length ||
		!Number.isSafeInteger(page.pagesAttempted) ||
		page.pagesAttempted < 1 ||
		page.pagesCompleted !== page.pagesAttempted
	) {
		throw new IncompleteJellyfinNativeEpisodeInventory();
	}
	return page.items;
}

async function discoverScopes(client: JellyfinClient): Promise<JellyfinNativeEpisodeScope[]> {
	let libraries: JellyfinLibrary[];
	try {
		libraries = await client.getNativeMediaFolders();
	} catch {
		throw new UnavailableJellyfinNativeEpisodeInventory();
	}
	const libraryIds = new Set<string>();
	const scopes: JellyfinNativeEpisodeScope[] = [];
	for (const library of libraries) {
		if (!validIdentity(library.id) || libraryIds.has(library.id)) {
			throw new IncompleteJellyfinNativeEpisodeInventory();
		}
		libraryIds.add(library.id);
		// Playlist views are grouping containers, not physical media scopes.
		if (library.collectionType === "playlists") continue;
		scopes.push({
			libraryId: library.id,
			collectionType: library.collectionType,
			scopeKey: `library:${library.id}`,
		});
	}
	return scopes.sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
}

function scopeIdentity(scopes: readonly JellyfinNativeEpisodeScope[]): string {
	return JSON.stringify(scopes.map((scope) => [scope.scopeKey, scope.collectionType]));
}

function scopedItemsIdentity(items: JellyfinNativeEpisodePass["scopedItems"]): string {
	return JSON.stringify(
		[...items]
			.sort((a, b) => `${a.scopeKey}\0${a.id}`.localeCompare(`${b.scopeKey}\0${b.id}`))
			.map((item) => [item.scopeKey, item.id]),
	);
}

function mergeRow(previous: NativeInventoryRow, row: NativeInventoryRow): NativeInventoryRow {
	const sameCoordinate =
		previous.parentNativeId === row.parentNativeId &&
		previous.seasonNumber === row.seasonNumber &&
		previous.episodeNumber === row.episodeNumber;
	return {
		...previous,
		libraryIds: [...new Set([...previous.libraryIds, ...row.libraryIds])].sort(),
		parentNativeId: sameCoordinate ? previous.parentNativeId : null,
		seasonNumber: sameCoordinate ? previous.seasonNumber : null,
		episodeNumber: sameCoordinate ? previous.episodeNumber : null,
		title: row.title || previous.title,
	};
}

function mergePassSnapshots(
	first: CollectedJellyfinNativeEpisodeInventory,
	second: CollectedJellyfinNativeEpisodeInventory,
): CollectedJellyfinNativeEpisodeInventory {
	const rowsById = new Map(first.rows.map((row) => [row.nativeId, row]));
	for (const row of second.rows) {
		const previous = rowsById.get(row.nativeId);
		rowsById.set(row.nativeId, previous ? mergeRow(previous, row) : row);
	}
	return {
		...second,
		rows: [...rowsById.values()].sort((a, b) => a.nativeId.localeCompare(b.nativeId)),
	};
}

async function collectPass(
	client: JellyfinClient,
	scopes: readonly JellyfinNativeEpisodeScope[],
): Promise<JellyfinNativeEpisodePass> {
	const rowsById = new Map<string, NativeInventoryRow>();
	const scopedItems: JellyfinNativeEpisodePass["scopedItems"] = [];
	const scopedIds = new Set<string>();

	for (const scope of scopes) {
		let page: Awaited<ReturnType<JellyfinClient["getNativeEpisodeItemsWithCoverage"]>>;
		try {
			page = await client.getNativeEpisodeItemsWithCoverage(scope.libraryId);
		} catch {
			throw new UnavailableJellyfinNativeEpisodeInventory();
		}
		for (const item of requireCompletePage(page)) {
			if (item.type !== "Episode" || !validIdentity(item.id)) {
				throw new IncompleteJellyfinNativeEpisodeInventory();
			}
			const scopedId = `${scope.scopeKey}\0${item.id}`;
			if (scopedIds.has(scopedId)) {
				throw new IncompleteJellyfinNativeEpisodeInventory();
			}
			scopedIds.add(scopedId);
			scopedItems.push({ scopeKey: scope.scopeKey, id: item.id });

			const coordinates = coordinate(item);
			const row: NativeInventoryRow = {
				nativeId: item.id,
				mediaType: "episode",
				libraryIds: [scope.libraryId],
				...coordinates,
				title: typeof item.name === "string" ? item.name : "",
			};
			const existing = rowsById.get(item.id);
			rowsById.set(item.id, existing ? mergeRow(existing, row) : row);
		}
	}

	return {
		snapshot: {
			domain: "episode",
			scopeKeys: scopes.map((scope) => scope.scopeKey),
			rows: [...rowsById.values()].sort((a, b) => a.nativeId.localeCompare(b.nativeId)),
		},
		scopedItems,
	};
}

export async function collectJellyfinNativeEpisodeInventory(
	client: JellyfinClient,
): Promise<JellyfinNativeEpisodeInventoryResult> {
	try {
		let scopes = await discoverScopes(client);
		let previous: JellyfinNativeEpisodePass | undefined;
		// A moving catalog gets one extra complete pass. Only consecutive agreement
		// within unchanged physical scopes can replace the published inventory.
		for (let pass = 0; pass < 3; pass++) {
			const current = await collectPass(client, scopes);
			const after = await discoverScopes(client);
			if (scopeIdentity(scopes) !== scopeIdentity(after)) {
				previous = undefined;
			} else {
				if (
					previous &&
					scopedItemsIdentity(previous.scopedItems) === scopedItemsIdentity(current.scopedItems)
				) {
					return {
						complete: true,
						snapshots: [mergePassSnapshots(previous.snapshot, current.snapshot)],
					};
				}
				previous = current;
			}
			scopes = after;
		}
		throw new IncompleteJellyfinNativeEpisodeInventory();
	} catch (error) {
		return {
			complete: false,
			reason:
				error instanceof IncompleteJellyfinNativeEpisodeInventory
					? "coverage-incomplete"
					: "provider-unavailable",
		};
	}
}
