import type { PrismaClient } from "../prisma.js";
import type { NativeInventoryRow } from "../provider-observation/native-inventory.js";

const MAX_PAGE_ROWS = 200;
const MAX_SCOPE_RECEIPTS = 256;
const MAX_JOINED_WATCH_ROWS = 10_000;
const MAX_DISPLAY_AGE_MS = 24 * 60 * 60 * 1_000;

const UNKNOWN: NativeWatchDisplay = {
	state: "unknown",
	freshness: "unavailable",
	valueSemantics: "unknown",
	observedAt: null,
};

export type NativeWatchDisplay = {
	state: "watched" | "unwatched" | "unknown";
	freshness: "current" | "last-known" | "unavailable";
	valueSemantics: "exact" | "lower-bound" | "unknown";
	observedAt: string | null;
};

export async function readNativeEpisodeWatchPage(
	prisma: PrismaClient,
	input: { userId: string; instanceId: string; rows: readonly NativeInventoryRow[]; now: Date },
): Promise<ReadonlyMap<string, NativeWatchDisplay>> {
	const result = new Map(input.rows.map((row) => [row.nativeId, UNKNOWN]));
	if (
		input.rows.length === 0 ||
		input.rows.length > MAX_PAGE_ROWS ||
		!Number.isFinite(input.now.getTime()) ||
		input.rows.some((row) => row.mediaType !== "episode" || !row.nativeId.trim())
	)
		return result;
	return await prisma.$transaction(
		async (tx) => {
			const instance = await tx.serviceInstance.findFirst({
				where: {
					id: input.instanceId,
					userId: input.userId,
					enabled: true,
					service: { in: ["JELLYFIN", "EMBY"] },
					identityStatus: "VERIFIED",
				},
				select: {
					service: true,
					expectedIdentity: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			});
			if (!instance?.expectedIdentity?.trim()) return new Map();
			const positiveStatus = await tx.cacheRefreshStatus.findUnique({
				where: {
					instanceId_cacheType: {
						instanceId: input.instanceId,
						cacheType: "jellyfin_episode_positive",
					},
				},
			});
			const positiveObservedAt =
				instance.service === "JELLYFIN" &&
				positiveStatus?.lastResult === "success" &&
				positiveStatus.generationId &&
				positiveStatus.connectionGeneration === instance.connectionGeneration &&
				positiveStatus.identityGeneration === instance.identityGeneration &&
				withinDisplayAge(positiveStatus.lastRefreshedAt, input.now)
					? positiveStatus.lastRefreshedAt
					: null;
			const conflicts = new Set<string>();
			base: {
				const pointer = await tx.jellyfinNativeWatchPublication.findUnique({
					where: { instanceId: input.instanceId },
				});
				const status = await tx.cacheRefreshStatus.findUnique({
					where: {
						instanceId_cacheType: {
							instanceId: input.instanceId,
							cacheType: "jellyfin_episode",
						},
					},
				});
				if (
					!pointer ||
					!status ||
					pointer.connectionGeneration !== instance.connectionGeneration ||
					pointer.identityGeneration !== instance.identityGeneration ||
					status.connectionGeneration !== instance.connectionGeneration ||
					status.identityGeneration !== instance.identityGeneration ||
					status.lastResult !== "success" ||
					status.generationId !== pointer.activeCacheGenerationId ||
					!withinDisplayAge(pointer.activeObservedAt, input.now)
				)
					break base;
				const runIds = [pointer.activeRunId];
				if (
					pointer.previousRunId &&
					pointer.previousObservedAt &&
					withinDisplayAge(pointer.previousObservedAt, input.now)
				)
					runIds.push(pointer.previousRunId);
				const totalExpectedScopes =
					pointer.activeExpectedScopeCount +
					(runIds.length === 2 ? (pointer.previousExpectedScopeCount ?? 0) : 0);
				if (
					pointer.activeExpectedScopeCount < 1 ||
					pointer.activeExpectedScopeCount > MAX_SCOPE_RECEIPTS ||
					totalExpectedScopes > MAX_SCOPE_RECEIPTS * 2
				)
					break base;
				const receipts = await tx.jellyfinNativeWatchScopeReceipt.findMany({
					where: { instanceId: input.instanceId, runId: { in: runIds } },
					take: totalExpectedScopes + 1,
				});
				if (receipts.length !== totalExpectedScopes) break base;
				const nativeIds = input.rows.map((row) => row.nativeId);
				const count = await tx.jellyfinNativeWatchRow.count({
					where: {
						instanceId: input.instanceId,
						runId: { in: runIds },
						jellyfinId: { in: nativeIds },
					},
				});
				if (count > MAX_JOINED_WATCH_ROWS) break base;
				const rows = await tx.jellyfinNativeWatchRow.findMany({
					where: {
						instanceId: input.instanceId,
						runId: { in: runIds },
						jellyfinId: { in: nativeIds },
					},
					take: MAX_JOINED_WATCH_ROWS + 1,
				});
				if (rows.length !== count) break base;
				const current =
					status.lastAttemptResult === "success" &&
					status.lastRefreshedAt.getTime() === pointer.activeObservedAt.getTime() &&
					(!positiveObservedAt ||
						positiveObservedAt.getTime() <= pointer.activeObservedAt.getTime());
				for (const inventory of input.rows) {
					const active = classifyGeneration({
						inventory,
						runId: pointer.activeRunId,
						observedAt: pointer.activeObservedAt,
						expectedScopeCount: pointer.activeExpectedScopeCount,
						receipts,
						rows,
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					});
					if (active.kind === "value") {
						result.set(inventory.nativeId, {
							state: active.state,
							freshness: current ? "current" : "last-known",
							valueSemantics: active.valueSemantics,
							observedAt: pointer.activeObservedAt.toISOString(),
						});
						continue;
					}
					if (active.kind === "conflict") conflicts.add(inventory.nativeId);
					if (active.kind === "conflict" || runIds.length !== 2 || !pointer.previousObservedAt)
						continue;
					const previous = classifyGeneration({
						inventory,
						runId: runIds[1]!,
						observedAt: pointer.previousObservedAt,
						expectedScopeCount: pointer.previousExpectedScopeCount ?? 0,
						receipts,
						rows,
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					});
					if (previous.kind === "value")
						result.set(inventory.nativeId, {
							state: previous.state,
							freshness: "last-known",
							valueSemantics: previous.valueSemantics,
							observedAt: pointer.previousObservedAt.toISOString(),
						});
				}
			}
			const positiveGenerationComplete =
				positiveObservedAt &&
				positiveStatus?.generationId &&
				Number.isSafeInteger(positiveStatus.itemCount) &&
				positiveStatus.itemCount >= 0 &&
				positiveStatus.itemCount <= 25_000 &&
				(await tx.jellyfinPositiveWatchRow.count({
					where: { instanceId: input.instanceId, generationId: positiveStatus.generationId },
				})) === positiveStatus.itemCount;
			if (positiveObservedAt && positiveStatus?.generationId && positiveGenerationComplete) {
				const nativeIds = input.rows.map((row) => row.nativeId);
				const positiveCount = await tx.jellyfinPositiveWatchRow.count({
					where: {
						instanceId: input.instanceId,
						generationId: positiveStatus.generationId,
						jellyfinId: { in: nativeIds },
					},
				});
				if (positiveCount <= MAX_JOINED_WATCH_ROWS) {
					const positiveRows = await tx.jellyfinPositiveWatchRow.findMany({
						where: {
							instanceId: input.instanceId,
							generationId: positiveStatus.generationId,
							jellyfinId: { in: nativeIds },
						},
						take: MAX_JOINED_WATCH_ROWS + 1,
					});
					if (positiveRows.length === positiveCount) {
						for (const inventory of input.rows) {
							if (conflicts.has(inventory.nativeId)) continue;
							const matching = positiveRows.filter((row) => row.jellyfinId === inventory.nativeId);
							if (matching.length === 0) continue;
							if (
								inventory.parentNativeId === null ||
								inventory.seasonNumber === null ||
								inventory.episodeNumber === null ||
								matching.some(
									(row) =>
										!inventory.libraryIds.includes(row.libraryId) ||
										row.seriesId !== inventory.parentNativeId ||
										row.seasonNumber !== inventory.seasonNumber ||
										row.episodeNumber !== inventory.episodeNumber ||
										row.connectionGeneration !== instance.connectionGeneration ||
										row.identityGeneration !== instance.identityGeneration ||
										row.observedAt.getTime() !== positiveObservedAt.getTime(),
								)
							) {
								result.set(inventory.nativeId, UNKNOWN);
								continue;
							}
							const existing = result.get(inventory.nativeId);
							if (
								existing?.observedAt &&
								new Date(existing.observedAt).getTime() > positiveObservedAt.getTime()
							)
								continue;
							result.set(inventory.nativeId, {
								state: "watched",
								freshness:
									positiveStatus.lastAttemptResult === "success" ? "current" : "last-known",
								valueSemantics: "lower-bound",
								observedAt: positiveObservedAt.toISOString(),
							});
						}
					}
				}
			}
			return result;
		},
		{ isolationLevel: "Serializable", timeout: 10_000 },
	);
}

function withinDisplayAge(observedAt: Date, now: Date): boolean {
	const age = now.getTime() - observedAt.getTime();
	return Number.isFinite(age) && age >= 0 && age <= MAX_DISPLAY_AGE_MS;
}

type ScopeReceipt = {
	runId: string;
	userKeyDigest: string;
	libraryId: string;
	exact: boolean;
	expectedRawCount: number;
	observedRawCount: number;
	contentFingerprint: string;
	observedAt: Date;
	connectionGeneration: number;
	identityGeneration: number;
};
type WatchRow = {
	runId: string;
	userKeyDigest: string;
	libraryId: string;
	jellyfinId: string;
	seriesId: string;
	seasonNumber: number;
	episodeNumber: number;
	played: boolean;
	observedAt: Date;
	connectionGeneration: number;
	identityGeneration: number;
};

function classifyGeneration(input: {
	inventory: NativeInventoryRow;
	runId: string;
	observedAt: Date;
	expectedScopeCount: number;
	receipts: readonly ScopeReceipt[];
	rows: readonly WatchRow[];
	connectionGeneration: number;
	identityGeneration: number;
}):
	| { kind: "value"; state: "watched" | "unwatched"; valueSemantics: "exact" | "lower-bound" }
	| { kind: "absent" | "conflict" } {
	const scopeReceipts = input.receipts.filter((receipt) => receipt.runId === input.runId);
	if (
		scopeReceipts.length !== input.expectedScopeCount ||
		scopeReceipts.some(
			(receipt) =>
				receipt.connectionGeneration !== input.connectionGeneration ||
				receipt.identityGeneration !== input.identityGeneration ||
				receipt.observedAt.getTime() !== input.observedAt.getTime() ||
				!Number.isSafeInteger(receipt.expectedRawCount) ||
				!Number.isSafeInteger(receipt.observedRawCount) ||
				!/^[a-f0-9]{64}$/.test(receipt.contentFingerprint),
		)
	)
		return { kind: "conflict" };
	const relevant = scopeReceipts.filter((receipt) =>
		input.inventory.libraryIds.includes(receipt.libraryId),
	);
	if (relevant.length === 0) return { kind: "absent" };
	const matchingRows = input.rows.filter(
		(row) => row.runId === input.runId && row.jellyfinId === input.inventory.nativeId,
	);
	if (
		input.inventory.parentNativeId === null ||
		input.inventory.seasonNumber === null ||
		input.inventory.episodeNumber === null ||
		matchingRows.some(
			(row) =>
				!input.inventory.libraryIds.includes(row.libraryId) ||
				row.seriesId !== input.inventory.parentNativeId ||
				row.seasonNumber !== input.inventory.seasonNumber ||
				row.episodeNumber !== input.inventory.episodeNumber ||
				row.connectionGeneration !== input.connectionGeneration ||
				row.identityGeneration !== input.identityGeneration ||
				row.observedAt.getTime() !== input.observedAt.getTime(),
		)
	)
		return { kind: "conflict" };
	const byScope = new Map(
		matchingRows.map((row) => [`${row.userKeyDigest}\0${row.libraryId}`, row]),
	);
	if (byScope.size !== matchingRows.length) return { kind: "conflict" };
	const admitted = relevant.map((receipt) =>
		byScope.get(`${receipt.userKeyDigest}\0${receipt.libraryId}`),
	);
	if (
		matchingRows.some(
			(row) =>
				!relevant.some(
					(receipt) =>
						receipt.userKeyDigest === row.userKeyDigest && receipt.libraryId === row.libraryId,
				),
		)
	)
		return { kind: "conflict" };
	const coveredLibraries = new Set(relevant.map((receipt) => receipt.libraryId));
	// A scope can be partial because other episodes changed between passes. Each
	// published row has already been matched across both passes, so require a
	// row for every relevant user/library rather than whole-scope exactness.
	const complete =
		input.inventory.libraryIds.length > 0 &&
		input.inventory.libraryIds.every((libraryId) => coveredLibraries.has(libraryId)) &&
		admitted.every(Boolean);
	if (admitted.some((row) => row?.played))
		return {
			kind: "value",
			state: "watched",
			valueSemantics: complete ? "exact" : "lower-bound",
		};
	if (complete) return { kind: "value", state: "unwatched", valueSemantics: "exact" };
	return { kind: "absent" };
}
