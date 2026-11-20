import type { FastifyBaseLogger } from "fastify";
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

type NativeEpisodeJobReader = Pick<
	JellyfinClient,
	"getNativeMediaFolders" | "readNativeInventoryPage"
>;

export interface JellyfinNativeEpisodeJobScope {
	libraryId: string;
	collectionType: string;
	scopeKey: string;
}

export function createJellyfinNativeEpisodeJobAdapter(
	client: NativeEpisodeJobReader,
): NativeInventoryJobAdapter<JellyfinNativeEpisodeJobScope>;
export function createJellyfinNativeEpisodeJobAdapter(
	client: Pick<NativeEpisodeJobReader, "readNativeInventoryPage">,
	options: {
		discoverScopes: NativeInventoryJobAdapter<JellyfinNativeEpisodeJobScope>["discoverScopes"];
	},
): NativeInventoryJobAdapter<JellyfinNativeEpisodeJobScope>;
export function createJellyfinNativeEpisodeJobAdapter(
	client: Pick<NativeEpisodeJobReader, "readNativeInventoryPage"> &
		Partial<Pick<NativeEpisodeJobReader, "getNativeMediaFolders">>,
	options?: {
		discoverScopes?: NativeInventoryJobAdapter<JellyfinNativeEpisodeJobScope>["discoverScopes"];
	},
): NativeInventoryJobAdapter<JellyfinNativeEpisodeJobScope> {
	return {
		domain: "episode" as const,
		async discoverScopes(deadlineAt: number): Promise<
			| { status: "ready"; catalogIdentity: string; scopes: JellyfinNativeEpisodeJobScope[] }
			| {
					status: "unavailable";
					reason: "deadline-exceeded" | "provider-unavailable" | "coverage-incomplete";
			  }
		> {
			if (options?.discoverScopes) return await options.discoverScopes(deadlineAt);
			if (!client.getNativeMediaFolders)
				return { status: "unavailable", reason: "provider-unavailable" };
			const remainingMs = deadlineAt - Date.now();
			if (remainingMs <= 0) return { status: "unavailable", reason: "deadline-exceeded" };
			let libraries: JellyfinLibrary[];
			try {
				libraries = await client.getNativeMediaFolders({ timeoutMs: remainingMs });
			} catch {
				return { status: "unavailable", reason: "provider-unavailable" };
			}
			const ids = new Set<string>();
			const scopes: JellyfinNativeEpisodeJobScope[] = [];
			for (const library of libraries) {
				if (!validIdentity(library.id) || ids.has(library.id)) {
					return { status: "unavailable", reason: "coverage-incomplete" };
				}
				ids.add(library.id);
				if (library.collectionType === "playlists") continue;
				scopes.push({
					libraryId: library.id,
					collectionType: library.collectionType,
					scopeKey: `library:${library.id}`,
				});
			}
			scopes.sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
			return { status: "ready", catalogIdentity: scopeIdentity(scopes), scopes };
		},
		async readPage(
			scope: JellyfinNativeEpisodeJobScope,
			startIndex: number,
			limit: number,
			deadlineAt: number,
		): Promise<
			| {
					status: "page";
					domain: "episode";
					scopeKey: string;
					startIndex: number;
					totalRecordCount: number;
					rawNativeIds: string[];
					comparisonKeys: string[];
					rows: NativeInventoryRow[];
			  }
			| {
					status: "unavailable";
					reason: "deadline-exceeded" | "provider-unavailable" | "coverage-incomplete";
			  }
		> {
			if (!validIdentity(scope.libraryId) || scope.scopeKey !== `library:${scope.libraryId}`) {
				return { status: "unavailable", reason: "coverage-incomplete" };
			}
			let page: Awaited<ReturnType<JellyfinClient["readNativeInventoryPage"]>>;
			try {
				page = await client.readNativeInventoryPage({
					domain: "episode",
					libraryId: scope.libraryId,
					startIndex,
					limit,
					deadlineAt,
				});
			} catch {
				return { status: "unavailable", reason: "provider-unavailable" };
			}
			if (page.status === "unavailable") return page;
			if (page.domain !== "episode" || page.startIndex !== startIndex) {
				return { status: "unavailable", reason: "coverage-incomplete" };
			}
			const rawNativeIds: string[] = [];
			const comparisonKeys: string[] = [];
			const rows: NativeInventoryRow[] = [];
			const ids = new Set<string>();
			for (const item of page.items) {
				if (item.type !== "Episode" || !validIdentity(item.id) || ids.has(item.id)) {
					return { status: "unavailable", reason: "coverage-incomplete" };
				}
				ids.add(item.id);
				rawNativeIds.push(item.id);
				comparisonKeys.push("Episode");
				rows.push({
					nativeId: item.id,
					mediaType: "episode",
					libraryIds: [scope.libraryId],
					...coordinate(item),
					title: typeof item.name === "string" ? item.name : "",
				});
			}
			return {
				status: "page",
				domain: "episode",
				scopeKey: scope.scopeKey,
				startIndex: page.startIndex,
				totalRecordCount: page.totalRecordCount,
				rawNativeIds,
				comparisonKeys,
				rows,
			};
		},
	};
}

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
const NATIVE_EPISODE_MAX_DURATION_MS = 20 * 60 * 1000;

function logNativeEpisodeTiming(
	log: Pick<FastifyBaseLogger, "info"> | undefined,
	fields: Record<string, string | number>,
	message: string,
): void {
	try {
		log?.info(fields, message);
	} catch {
		// Diagnostic telemetry must not change inventory coverage or publication.
	}
}

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

async function discoverScopes(
	client: JellyfinClient,
	deadlineAt: number,
): Promise<JellyfinNativeEpisodeScope[]> {
	let libraries: JellyfinLibrary[];
	try {
		const remainingMs = deadlineAt - Date.now();
		if (remainingMs <= 0) throw new UnavailableJellyfinNativeEpisodeInventory();
		libraries = await client.getNativeMediaFolders({ timeoutMs: remainingMs });
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
	pass: number,
	deadlineAt: number,
	log?: Pick<FastifyBaseLogger, "info">,
): Promise<JellyfinNativeEpisodePass> {
	const passStartedAt = Date.now();
	const rowsById = new Map<string, NativeInventoryRow>();
	const scopedItems: JellyfinNativeEpisodePass["scopedItems"] = [];
	const scopedIds = new Set<string>();

	for (const [scopeIndex, scope] of scopes.entries()) {
		const scopeStartedAt = Date.now();
		let page: Awaited<ReturnType<JellyfinClient["getNativeEpisodeItemsWithCoverage"]>>;
		try {
			const remainingMs = deadlineAt - Date.now();
			if (remainingMs <= 0) throw new UnavailableJellyfinNativeEpisodeInventory();
			page = await client.getNativeEpisodeItemsWithCoverage(scope.libraryId, remainingMs);
		} catch {
			logNativeEpisodeTiming(
				log,
				{
					category: "native-episode-scope-timing",
					pass,
					scopeOrdinal: scopeIndex + 1,
					pagesAttempted: 0,
					pagesCompleted: 0,
					rawObserved: 0,
					elapsedMs: Date.now() - scopeStartedAt,
					status: "provider-unavailable",
				},
				"Jellyfin native episode scope read timing",
			);
			throw new UnavailableJellyfinNativeEpisodeInventory();
		}
		logNativeEpisodeTiming(
			log,
			{
				category: "native-episode-scope-timing",
				pass,
				scopeOrdinal: scopeIndex + 1,
				pagesAttempted: page.pagesAttempted,
				pagesCompleted: page.pagesCompleted,
				rawObserved: page.rawObserved,
				elapsedMs: Date.now() - scopeStartedAt,
				status: page.reason === null ? "complete" : "coverage-incomplete",
			},
			"Jellyfin native episode scope read timing",
		);
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

	const snapshot: CollectedJellyfinNativeEpisodeInventory = {
		domain: "episode",
		scopeKeys: scopes.map((scope) => scope.scopeKey),
		rows: [...rowsById.values()].sort((a, b) => a.nativeId.localeCompare(b.nativeId)),
	};
	logNativeEpisodeTiming(
		log,
		{
			category: "native-episode-pass-timing",
			pass,
			scopes: scopes.length,
			rows: snapshot.rows.length,
			elapsedMs: Date.now() - passStartedAt,
			status: "complete",
		},
		"Jellyfin native episode pass timing",
	);
	return {
		snapshot,
		scopedItems,
	};
}

export async function collectJellyfinNativeEpisodeInventory(
	client: JellyfinClient,
	log?: Pick<FastifyBaseLogger, "info">,
): Promise<JellyfinNativeEpisodeInventoryResult> {
	try {
		const deadlineAt = Date.now() + NATIVE_EPISODE_MAX_DURATION_MS;
		let scopes = await discoverScopes(client, deadlineAt);
		let previous: JellyfinNativeEpisodePass | undefined;
		// A moving catalog gets one extra complete pass. Only consecutive agreement
		// within unchanged physical scopes can replace the published inventory.
		for (let pass = 0; pass < 3; pass++) {
			const current = await collectPass(client, scopes, pass + 1, deadlineAt, log);
			const after = await discoverScopes(client, deadlineAt);
			if (Date.now() >= deadlineAt) throw new UnavailableJellyfinNativeEpisodeInventory();
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
import type { NativeInventoryJobAdapter } from "../provider-observation/native-inventory-job-runner.js";
