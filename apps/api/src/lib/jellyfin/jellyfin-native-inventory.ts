import {
	hasNativeInventoryExternalIds,
	mergeNativeInventoryExternalIds,
	type NativeInventoryRow,
	reconcileNativeInventoryIdentifiers,
} from "../provider-observation/native-inventory.js";
import type {
	JellyfinClient,
	JellyfinLibrary,
	JellyfinNativeLibraryItem,
} from "./jellyfin-client.js";

export interface CollectedJellyfinNativeLibraryInventory {
	domain: "library";
	scopeKeys: string[];
	rows: NativeInventoryRow[];
}

export type JellyfinNativeLibraryInventoryResult =
	| { complete: true; snapshots: [CollectedJellyfinNativeLibraryInventory] }
	| { complete: false; reason: "coverage-incomplete" | "provider-unavailable" };

type NativeLibraryReader = Pick<
	JellyfinClient,
	"getNativeMediaFolders" | "getNativeLibraryItemsWithCoverage"
>;

interface JellyfinNativeLibraryScope {
	libraryId: string;
	collectionType: string;
	scopeKey: string;
}

interface JellyfinNativeLibraryPass {
	snapshot: CollectedJellyfinNativeLibraryInventory;
	scopedItems: Array<{
		scopeKey: string;
		id: string;
		type: JellyfinNativeLibraryItem["type"];
		externalIds?: JellyfinNativeLibraryItem["externalIds"];
	}>;
}

class IncompleteJellyfinNativeInventory extends Error {}
class UnavailableJellyfinNativeInventory extends Error {}

function validIdentity(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function expectedItemType(
	collectionType: string,
	itemType: JellyfinNativeLibraryItem["type"],
): boolean {
	return (
		(collectionType !== "movies" && collectionType !== "tvshows") ||
		(collectionType === "movies" && itemType === "Movie") ||
		(collectionType === "tvshows" && itemType === "Series")
	);
}

function requireCompletePage(
	page: Awaited<ReturnType<JellyfinClient["getNativeLibraryItemsWithCoverage"]>>,
): JellyfinNativeLibraryItem[] {
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
		throw new IncompleteJellyfinNativeInventory();
	}
	return page.items;
}

async function discoverScopes(client: NativeLibraryReader): Promise<JellyfinNativeLibraryScope[]> {
	let libraries: JellyfinLibrary[];
	try {
		libraries = await client.getNativeMediaFolders();
	} catch {
		throw new UnavailableJellyfinNativeInventory();
	}
	const libraryIds = new Set<string>();
	const scopes: JellyfinNativeLibraryScope[] = [];
	for (const library of libraries) {
		if (!validIdentity(library.id) || libraryIds.has(library.id)) {
			throw new IncompleteJellyfinNativeInventory();
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

function scopeIdentity(scopes: readonly JellyfinNativeLibraryScope[]): string {
	return JSON.stringify(scopes.map((scope) => [scope.scopeKey, scope.collectionType]));
}

function scopedItemsIdentity(
	items: JellyfinNativeLibraryPass["scopedItems"],
	requireStableIdentifiers = false,
): string {
	return JSON.stringify(
		[...items]
			.sort((a, b) =>
				`${a.scopeKey}\0${a.id}\0${a.type}`.localeCompare(`${b.scopeKey}\0${b.id}\0${b.type}`),
			)
			.map((item) =>
				requireStableIdentifiers
					? [item.scopeKey, item.id, item.type, item.externalIds?.tmdb ?? []]
					: [item.scopeKey, item.id, item.type],
			),
	);
}

async function collectPass(
	client: NativeLibraryReader,
	scopes: readonly JellyfinNativeLibraryScope[],
): Promise<JellyfinNativeLibraryPass> {
	const rowsById = new Map<string, NativeInventoryRow>();
	const scopedItems: JellyfinNativeLibraryPass["scopedItems"] = [];
	const scopedIds = new Set<string>();

	for (const scope of scopes) {
		let page: Awaited<ReturnType<JellyfinClient["getNativeLibraryItemsWithCoverage"]>>;
		try {
			page = await client.getNativeLibraryItemsWithCoverage(scope.libraryId, {
				includeItemTypes:
					scope.collectionType === "movies"
						? "Movie"
						: scope.collectionType === "tvshows"
							? "Series"
							: "Movie,Series",
			});
		} catch {
			throw new UnavailableJellyfinNativeInventory();
		}
		for (const item of requireCompletePage(page)) {
			if (
				!validIdentity(item.id) ||
				(item.type !== "Movie" && item.type !== "Series" && item.type !== "BoxSet")
			) {
				throw new IncompleteJellyfinNativeInventory();
			}
			const scopedId = `${scope.scopeKey}\0${item.id}`;
			if (scopedIds.has(scopedId)) throw new IncompleteJellyfinNativeInventory();
			scopedIds.add(scopedId);
			scopedItems.push({
				scopeKey: scope.scopeKey,
				id: item.id,
				type: item.type,
				...(hasNativeInventoryExternalIds(item.externalIds)
					? { externalIds: item.externalIds }
					: {}),
			});

			if (item.type === "BoxSet") continue;
			if (!expectedItemType(scope.collectionType, item.type)) {
				throw new IncompleteJellyfinNativeInventory();
			}
			const mediaType = item.type === "Movie" ? "movie" : "series";
			const existing = rowsById.get(item.id);
			if (existing && existing.mediaType !== mediaType) {
				throw new IncompleteJellyfinNativeInventory();
			}
			if (existing) {
				const externalIds = mergeNativeInventoryExternalIds(existing.externalIds, item.externalIds);
				rowsById.set(item.id, {
					...existing,
					libraryIds: [...new Set([...existing.libraryIds, scope.libraryId])].sort(),
					title: typeof item.name === "string" ? item.name : "",
					...(hasNativeInventoryExternalIds(externalIds) ? { externalIds } : {}),
				});
				continue;
			}
			rowsById.set(item.id, {
				nativeId: item.id,
				mediaType,
				libraryIds: [scope.libraryId],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: typeof item.name === "string" ? item.name : "",
				...(hasNativeInventoryExternalIds(item.externalIds)
					? { externalIds: item.externalIds }
					: {}),
			});
		}
	}

	const snapshot: CollectedJellyfinNativeLibraryInventory = {
		domain: "library",
		scopeKeys: scopes.map((scope) => scope.scopeKey),
		rows: [...rowsById.values()].sort((a, b) => a.nativeId.localeCompare(b.nativeId)),
	};
	return { snapshot, scopedItems };
}

export async function collectJellyfinNativeLibraryInventory(
	client: NativeLibraryReader,
	options?: { requireStableIdentifiers?: boolean },
): Promise<JellyfinNativeLibraryInventoryResult> {
	try {
		let scopes = await discoverScopes(client);
		let previous: JellyfinNativeLibraryPass | undefined;
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
					scopedItemsIdentity(previous.scopedItems, options?.requireStableIdentifiers) ===
						scopedItemsIdentity(current.scopedItems, options?.requireStableIdentifiers)
				) {
					return {
						complete: true,
						snapshots: [
							{
								...current.snapshot,
								rows: reconcileNativeInventoryIdentifiers(
									previous.snapshot.rows,
									current.snapshot.rows,
								),
							},
						],
					};
				}
				previous = current;
			}
			scopes = after;
		}
		throw new IncompleteJellyfinNativeInventory();
	} catch (error) {
		return {
			complete: false,
			reason:
				error instanceof IncompleteJellyfinNativeInventory
					? "coverage-incomplete"
					: "provider-unavailable",
		};
	}
}
