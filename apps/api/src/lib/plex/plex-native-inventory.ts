import type { PlexCoverageReasonCode } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import {
	hasNativeInventoryExternalIds,
	type NativeInventoryDomain,
	type NativeInventoryRow,
	reconcileNativeInventoryIdentifiers,
} from "../provider-observation/native-inventory.js";
import type { NativeInventoryJobAdapter } from "../provider-observation/native-inventory-job-runner.js";
import type { PlexClient, PlexCompletePageResult, PlexSettlementLibrary } from "./plex-client.js";
import { logPlexCollectionRejection } from "./plex-collection-diagnostics.js";
import { evaluatePlexLiveSettlement } from "./plex-live-settlement.js";

export interface CollectedNativeInventory {
	domain: NativeInventoryDomain;
	scopeKeys: string[];
	rows: NativeInventoryRow[];
}

export type PlexNativeInventoryResult =
	| { complete: true; snapshots: CollectedNativeInventory[] }
	| { complete: false; reason: "coverage-incomplete" | "provider-unavailable" };

type PlexNativeInventoryDiagnosticStage =
	| "start-probe"
	| "first-library"
	| "first-episodes"
	| "between-probe"
	| "catalog-comparison"
	| "second-library"
	| "second-episodes"
	| "end-probe"
	| "inventory-comparison";

type PlexNativeInventoryDiagnosticReason =
	| PlexCoverageReasonCode
	| "invalid-id"
	| "duplicate-id"
	| "unexpected-item-type"
	| "incomplete-page"
	| "catalog-changed"
	| "inventory-changed"
	| "provider-read-failed";

class NativeInventoryCollectionFailure extends Error {
	constructor(
		readonly stage: PlexNativeInventoryDiagnosticStage,
		readonly diagnosticReason: PlexNativeInventoryDiagnosticReason,
	) {
		super("Plex native inventory collection rejected");
		this.name = "NativeInventoryCollectionFailure";
	}
}

function validKey(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function requireCompletePage<T>(
	page: PlexCompletePageResult<T>,
	stage: PlexNativeInventoryDiagnosticStage,
): T[] {
	if (page.reason !== null)
		throw new NativeInventoryCollectionFailure(stage, "provider-read-failed");
	if (
		!Array.isArray(page.items) ||
		!Number.isSafeInteger(page.expectedRawCount) ||
		page.expectedRawCount !== page.items.length ||
		page.rawObserved !== page.items.length ||
		!Number.isSafeInteger(page.pagesAttempted) ||
		page.pagesAttempted < 1 ||
		page.pagesCompleted !== page.pagesAttempted
	)
		throw new NativeInventoryCollectionFailure(stage, "incomplete-page");
	return page.items;
}

async function probe(
	client: PlexClient,
	stage: Extract<PlexNativeInventoryDiagnosticStage, "start-probe" | "between-probe" | "end-probe">,
): Promise<PlexSettlementLibrary[]> {
	let activities: Awaited<ReturnType<PlexClient["getActivities"]>>;
	let sections: Awaited<ReturnType<PlexClient["getLibrarySettlementSections"]>>;
	try {
		[activities, sections] = await Promise.all([
			client.getActivities({ uncached: true }),
			client.getLibrarySettlementSections({ uncached: true }),
		]);
	} catch {
		throw new NativeInventoryCollectionFailure(stage, "provider-read-failed");
	}
	const selected = sections.filter(
		(section) => section.type === "movie" || section.type === "show",
	);
	if (selected.some((s) => !validKey(s.key) || !validKey(s.uuid))) {
		throw new NativeInventoryCollectionFailure(stage, "invalid-id");
	}
	if (
		new Set(selected.map((s) => s.key)).size !== selected.length ||
		new Set(selected.map((s) => s.uuid)).size !== selected.length
	) {
		throw new NativeInventoryCollectionFailure(stage, "duplicate-id");
	}
	const settlement = evaluatePlexLiveSettlement({
		activities,
		sections,
		selectedSectionKeys: selected.map((s) => s.key),
	});
	if (!settlement.settled) {
		throw new NativeInventoryCollectionFailure(
			stage,
			settlement.reasonCodes[0] ?? "plex_section_state_unavailable",
		);
	}
	return selected.sort((a, b) => a.key.localeCompare(b.key));
}

function catalogIdentity(sections: readonly PlexSettlementLibrary[]): string {
	return JSON.stringify(sections.map((s) => [s.key, s.uuid, s.type, s.scannedAt, s.updatedAt]));
}

export interface PlexNativeJobScope {
	domain: NativeInventoryDomain;
	sectionKey: string;
	sectionUuid: string;
	sectionType: "movie" | "show";
	scopeKey: string;
}

type PlexNativeJobReader = Pick<
	PlexClient,
	"getActivities" | "getLibrarySettlementSections" | "readNativeInventoryPage"
>;

/** One paired run retains Plex's settled-catalog proof across both domains. */
export function createPlexNativeJobAdapter(
	client: PlexNativeJobReader,
): NativeInventoryJobAdapter<PlexNativeJobScope>;
export function createPlexNativeJobAdapter(
	client: Pick<PlexNativeJobReader, "readNativeInventoryPage">,
	options: { discoverScopes: NativeInventoryJobAdapter<PlexNativeJobScope>["discoverScopes"] },
): NativeInventoryJobAdapter<PlexNativeJobScope>;
export function createPlexNativeJobAdapter(
	client: Pick<PlexNativeJobReader, "readNativeInventoryPage"> &
		Partial<Omit<PlexNativeJobReader, "readNativeInventoryPage">>,
	options?: { discoverScopes: NativeInventoryJobAdapter<PlexNativeJobScope>["discoverScopes"] },
): NativeInventoryJobAdapter<PlexNativeJobScope> {
	return {
		domain: "paired",
		async discoverScopes(deadlineAt) {
			if (options?.discoverScopes) return await options.discoverScopes(deadlineAt);
			if (!client.getActivities || !client.getLibrarySettlementSections)
				return { status: "unavailable", reason: "provider-unavailable" };
			const remainingMs = deadlineAt - Date.now();
			if (remainingMs <= 0) return { status: "unavailable", reason: "deadline-exceeded" };
			let activities: Awaited<ReturnType<PlexClient["getActivities"]>>;
			let sections: Awaited<ReturnType<PlexClient["getLibrarySettlementSections"]>>;
			try {
				[activities, sections] = await Promise.all([
					client.getActivities({ uncached: true, timeoutMs: remainingMs }),
					client.getLibrarySettlementSections({ uncached: true, timeoutMs: remainingMs }),
				]);
			} catch {
				return { status: "unavailable", reason: "provider-unavailable" };
			}
			const selected = sections.filter(
				(section) => section.type === "movie" || section.type === "show",
			);
			if (
				selected.some((section) => !validKey(section.key) || !validKey(section.uuid)) ||
				new Set(selected.map((section) => section.key)).size !== selected.length ||
				new Set(selected.map((section) => section.uuid)).size !== selected.length
			)
				return { status: "unavailable", reason: "coverage-incomplete" };
			const settled = evaluatePlexLiveSettlement({
				activities,
				sections,
				selectedSectionKeys: selected.map((section) => section.key),
			});
			if (!settled.settled) return { status: "unavailable", reason: "coverage-incomplete" };
			selected.sort((a, b) => a.key.localeCompare(b.key));
			const scopes: PlexNativeJobScope[] = [];
			for (const section of selected) {
				const sectionType = section.type as "movie" | "show";
				const scope = {
					sectionKey: section.key,
					sectionUuid: section.uuid,
					sectionType,
					scopeKey: JSON.stringify([section.key, section.uuid, section.type]),
				};
				scopes.push({ ...scope, domain: "library" });
				if (sectionType === "show") scopes.push({ ...scope, domain: "episode" });
			}
			return { status: "ready", catalogIdentity: catalogIdentity(selected), scopes };
		},
		async readPage(scope, startIndex, limit, deadlineAt) {
			if (
				!validKey(scope.sectionKey) ||
				!validKey(scope.sectionUuid) ||
				(scope.sectionType !== "movie" && scope.sectionType !== "show") ||
				(scope.domain !== "library" && scope.domain !== "episode") ||
				(scope.domain === "episode" && scope.sectionType !== "show") ||
				scope.scopeKey !== JSON.stringify([scope.sectionKey, scope.sectionUuid, scope.sectionType])
			)
				return { status: "unavailable", reason: "coverage-incomplete" };
			let page: Awaited<ReturnType<PlexClient["readNativeInventoryPage"]>>;
			try {
				page = await client.readNativeInventoryPage({
					domain: scope.domain,
					sectionId: scope.sectionKey,
					startIndex,
					limit,
					deadlineAt,
				});
			} catch {
				return { status: "unavailable", reason: "provider-unavailable" };
			}
			if (page.status === "unavailable") return page;
			if (page.domain !== scope.domain || page.startIndex !== startIndex) {
				return { status: "unavailable", reason: "coverage-incomplete" };
			}
			const rawNativeIds: string[] = [];
			const comparisonKeys: Array<string | null> = [];
			const rows: NativeInventoryRow[] = [];
			for (const item of page.items) {
				if (!validKey(item.ratingKey)) {
					return { status: "unavailable", reason: "coverage-incomplete" };
				}
				rawNativeIds.push(item.ratingKey);
				if (scope.domain === "library") {
					if (item.type === "collection") {
						comparisonKeys.push(null);
						continue;
					}
					if (item.type !== scope.sectionType) {
						return { status: "unavailable", reason: "coverage-incomplete" };
					}
					comparisonKeys.push(JSON.stringify([item.type]));
					rows.push({
						nativeId: item.ratingKey,
						mediaType: item.type === "show" ? "series" : "movie",
						libraryIds: [scope.sectionKey],
						parentNativeId: null,
						seasonNumber: null,
						episodeNumber: null,
						title: item.title,
						...(hasNativeInventoryExternalIds(item.externalIds)
							? { externalIds: item.externalIds }
							: {}),
					});
				} else {
					if (item.type !== "episode")
						return { status: "unavailable", reason: "coverage-incomplete" };
					comparisonKeys.push(
						JSON.stringify([
							item.type,
							item.grandparentRatingKey,
							item.seasonNumber,
							item.episodeNumber,
						]),
					);
					rows.push({
						nativeId: item.ratingKey,
						mediaType: "episode",
						libraryIds: [scope.sectionKey],
						parentNativeId: item.grandparentRatingKey,
						seasonNumber: item.seasonNumber,
						episodeNumber: item.episodeNumber,
						title: item.title,
					});
				}
			}
			return {
				status: "page",
				domain: scope.domain,
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
	libraryStage: Extract<PlexNativeInventoryDiagnosticStage, "first-library" | "second-library">,
	episodeStage: Extract<PlexNativeInventoryDiagnosticStage, "first-episodes" | "second-episodes">,
): Promise<CollectedNativeInventory[]> {
	const library: CollectedNativeInventory = { domain: "library", scopeKeys: [], rows: [] };
	const episode: CollectedNativeInventory = { domain: "episode", scopeKeys: [], rows: [] };
	const seen = new Set<string>();
	const admitKey = (key: string, stage: PlexNativeInventoryDiagnosticStage) => {
		if (!validKey(key)) throw new NativeInventoryCollectionFailure(stage, "invalid-id");
		if (seen.has(key)) throw new NativeInventoryCollectionFailure(stage, "duplicate-id");
		seen.add(key);
	};
	for (const section of sections) {
		const scopeKey = JSON.stringify([section.key, section.uuid, section.type]);
		library.scopeKeys.push(scopeKey);
		let libraryPage: Awaited<ReturnType<PlexClient["getNativeLibraryItemsWithCoverage"]>>;
		try {
			libraryPage = await client.getNativeLibraryItemsWithCoverage(section.key);
		} catch {
			throw new NativeInventoryCollectionFailure(libraryStage, "provider-read-failed");
		}
		const items = requireCompletePage(libraryPage, libraryStage);
		for (const item of items) {
			admitKey(item.ratingKey, libraryStage);
			// Plex may include collection containers in /all. They are not movie/series items.
			if (item.type === "collection") continue;
			if (item.type !== section.type)
				throw new NativeInventoryCollectionFailure(libraryStage, "unexpected-item-type");
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
		let episodePage: Awaited<ReturnType<PlexClient["getNativeEpisodeItemsWithCoverage"]>>;
		try {
			episodePage = await client.getNativeEpisodeItemsWithCoverage(section.key);
		} catch {
			throw new NativeInventoryCollectionFailure(episodeStage, "provider-read-failed");
		}
		const episodes = requireCompletePage(episodePage, episodeStage);
		for (const item of episodes) {
			admitKey(item.ratingKey, episodeStage);
			if (item.type !== "episode")
				throw new NativeInventoryCollectionFailure(episodeStage, "unexpected-item-type");
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
	log?: FastifyBaseLogger,
): Promise<PlexNativeInventoryResult> {
	let stage: PlexNativeInventoryDiagnosticStage = "start-probe";
	try {
		const before = await probe(client, "start-probe");
		stage = "first-library";
		const first = await collectPass(client, before, "first-library", "first-episodes");
		stage = "between-probe";
		const between = await probe(client, "between-probe");
		stage = "catalog-comparison";
		if (catalogIdentity(before) !== catalogIdentity(between))
			throw new NativeInventoryCollectionFailure(stage, "catalog-changed");
		stage = "second-library";
		const second = await collectPass(client, between, "second-library", "second-episodes");
		stage = "end-probe";
		const after = await probe(client, "end-probe");
		stage = "catalog-comparison";
		if (catalogIdentity(between) !== catalogIdentity(after))
			throw new NativeInventoryCollectionFailure(stage, "catalog-changed");
		stage = "inventory-comparison";
		if (inventoryIdentity(first) !== inventoryIdentity(second))
			throw new NativeInventoryCollectionFailure(stage, "inventory-changed");
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
		const failure =
			error instanceof NativeInventoryCollectionFailure
				? error
				: new NativeInventoryCollectionFailure(stage, "provider-read-failed");
		logPlexCollectionRejection(log, {
			category: "plex-native-collection-rejected",
			stage: failure.stage,
			reason: failure.diagnosticReason,
		});
		return {
			complete: false,
			reason:
				failure.diagnosticReason === "provider-read-failed"
					? "provider-unavailable"
					: "coverage-incomplete",
		};
	}
}
