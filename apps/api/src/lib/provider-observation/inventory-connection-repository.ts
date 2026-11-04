import type {
	ProviderInventoryConnection,
	ProviderNativeWatchCoverage,
	ProviderNativeWatchDisplay,
} from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import { readOwnedNativeWatchCoverage } from "../jellyfin/jellyfin-native-watch-coverage.js";
import { readNativeEpisodeWatchPage } from "../jellyfin/jellyfin-native-watch-reader.js";
import { PlexAuthorityService } from "../plex/plex-authority-service.js";
import { projectPlexNativeEpisodeWatchPage } from "../plex/plex-native-episode-watch-projection.js";
import type { PrismaClient } from "../prisma.js";
import {
	type ArrConnectionItem,
	createArrConnectionIndex,
	resolveArrConnection,
} from "./inventory-connections.js";
import {
	type NativeInventoryRow,
	normalizeNativeInventoryExternalIds,
	parseStoredItem,
	readNativeInventoryDisplayPage,
	readNativeInventoryDisplayTargets,
	readNativeInventoryPage,
	reconcileNativeInventoryIdentifiers,
} from "./native-inventory.js";

export const MAX_CONNECTION_ITEMS = 100_000;
const ARR_CATALOG_BATCH_SIZE = 1000;
type NativeReadInput = Parameters<typeof readNativeInventoryPage>[1];
type InventoryConnectionReadInput = NativeReadInput & { metadataFilter?: "missing-tmdb" };

export type ProviderInventoryReadTiming = {
	stage: "native-page" | "arr-catalog" | "native-postcheck";
	outcome: "returned" | "error";
	elapsedMs: number;
};

/** Bounded, generation-pinned read. Partial pages never become a complete catalog. */
export async function readCompleteNativeLibrary(
	prisma: PrismaClient,
	input: {
		userId: string;
		instanceId: string;
		now?: Date;
		expectedGenerationId?: string;
	},
) {
	const libraryInput = {
		userId: input.userId,
		instanceId: input.instanceId,
		now: input.now,
		expectedGenerationId: input.expectedGenerationId,
	};
	let page = await readNativeInventoryPage(prisma, {
		...libraryInput,
		domain: "library",
		limit: 200,
	});
	if (page.status !== "available" || page.itemCount > MAX_CONNECTION_ITEMS) return undefined;
	const generationId = page.generationId;
	const rows: NativeInventoryRow[] = [...page.rows];
	while (page.nextNativeId !== null) {
		const next = await readNativeInventoryPage(prisma, {
			...libraryInput,
			domain: "library",
			limit: 200,
			expectedGenerationId: generationId,
			afterNativeId: page.nextNativeId,
		});
		if (next.status !== "available" || next.generationId !== generationId) return undefined;
		rows.push(...next.rows);
		if (rows.length > MAX_CONNECTION_ITEMS) return undefined;
		page = next;
	}
	if (rows.length !== page.itemCount) return undefined;
	return { ...page, rows, instanceId: input.instanceId };
}

/** Filter only a complete, generation-pinned published library; no live provider read. */
async function readMissingTmdbLibraryPage(
	prisma: PrismaClient,
	input: InventoryConnectionReadInput,
) {
	const first = await readNativeInventoryPage(prisma, {
		userId: input.userId,
		instanceId: input.instanceId,
		domain: "library",
		limit: 1,
		now: input.now,
		expectedGenerationId: input.expectedGenerationId,
		includeAttempt: input.includeAttempt,
	});
	if (first.status !== "available") return first;
	const plex = await prisma.serviceInstance.findFirst({
		where: { id: input.instanceId, userId: input.userId, service: "PLEX" },
		select: { id: true },
	});
	if (!plex) return { status: "unavailable", reason: "unsupported-provider" } as const;
	if (first.itemCount > MAX_CONNECTION_ITEMS) {
		return { status: "unavailable", reason: "filter-limit-exceeded" } as const;
	}
	return prisma.$transaction(
		async (tx) => {
			const snapshot = await tx.providerNativeInventorySnapshot.findUnique({
				where: { instanceId_domain: { instanceId: input.instanceId, domain: "library" } },
				include: { publishedPass: true },
			});
			if (!snapshot || snapshot.generationId !== first.generationId)
				return { status: "unavailable", reason: "snapshot-changed" } as const;
			const pass = snapshot.publishedPass;
			if (snapshot.publishedPassId && (!pass || pass.state !== "complete"))
				return { status: "unavailable", reason: "malformed-publication" } as const;
			const priorPass = pass
				? await tx.providerNativeInventoryPass.findUnique({
						where: {
							runId_ordinal: { runId: pass.runId, ordinal: pass.ordinal - 1 },
						},
					})
				: null;
			if (
				pass &&
				(!priorPass ||
					priorPass.state !== "complete" ||
					priorPass.scopeDigest !== pass.scopeDigest ||
					priorPass.comparisonDigest !== pass.comparisonDigest)
			)
				return { status: "unavailable", reason: "malformed-publication" } as const;

			// Read only keys and normalized identifiers for the bounded publication.
			// The selected page's full rows are fetched separately below.
			const currentMetadata = pass
				? await tx.providerNativeInventoryStageItem.findMany({
						where: { passId: pass.id, domain: "library" },
						select: { nativeId: true, externalIds: true },
						orderBy: { nativeId: "asc" },
						take: MAX_CONNECTION_ITEMS + 1,
					})
				: await tx.providerNativeInventoryItem.findMany({
						where: { snapshotId: snapshot.id },
						select: { nativeId: true, externalIds: true },
						orderBy: { nativeId: "asc" },
						take: MAX_CONNECTION_ITEMS + 1,
					});
			if (currentMetadata.length !== first.itemCount)
				return { status: "unavailable", reason: "snapshot-changed" } as const;
			const priorMetadata = priorPass
				? await tx.providerNativeInventoryStageItem.findMany({
						where: { passId: priorPass.id, domain: "library" },
						select: { nativeId: true, externalIds: true },
						take: MAX_CONNECTION_ITEMS + 1,
					})
				: [];
			if (priorPass && priorMetadata.length !== currentMetadata.length)
				return { status: "unavailable", reason: "malformed-publication" } as const;
			const priorById = new Map(priorMetadata.map((row) => [row.nativeId, row.externalIds]));
			const missingIds: string[] = [];
			try {
				for (const row of currentMetadata) {
					const currentIds = normalizeNativeInventoryExternalIds(
						row.externalIds === null ? {} : JSON.parse(row.externalIds),
					);
					const priorRaw = priorById.get(row.nativeId);
					if (priorPass && priorRaw === undefined)
						return { status: "unavailable", reason: "malformed-publication" } as const;
					const priorIds = priorPass
						? normalizeNativeInventoryExternalIds(priorRaw === null ? {} : JSON.parse(priorRaw!))
						: null;
					const uniqueTmdb =
						currentIds.tmdb?.length === 1 &&
						(!priorIds || (priorIds.tmdb?.length === 1 && priorIds.tmdb[0] === currentIds.tmdb[0]));
					if (!uniqueTmdb) missingIds.push(row.nativeId);
				}
			} catch {
				return { status: "unavailable", reason: "malformed-publication" } as const;
			}
			const remainingIds = input.afterNativeId
				? missingIds.filter((nativeId) => nativeId > input.afterNativeId!)
				: missingIds;
			const limit = input.limit ?? 100;
			const pageIds = remainingIds.slice(0, limit);
			const currentItems = pageIds.length
				? pass
					? await tx.providerNativeInventoryStageItem.findMany({
							where: { passId: pass.id, domain: "library", nativeId: { in: pageIds } },
						})
					: await tx.providerNativeInventoryItem.findMany({
							where: { snapshotId: snapshot.id, nativeId: { in: pageIds } },
						})
				: [];
			const currentById = new Map(currentItems.map((item) => [item.nativeId, item]));
			const parsed = pageIds.map((nativeId) => {
				const item = currentById.get(nativeId);
				return item ? parseStoredItem(item, "library") : null;
			});
			if (parsed.some((row) => row === null))
				return { status: "unavailable", reason: "malformed-publication" } as const;
			let rows = parsed as NativeInventoryRow[];
			if (priorPass && pageIds.length > 0) {
				const priorItems = await tx.providerNativeInventoryStageItem.findMany({
					where: { passId: priorPass.id, domain: "library", nativeId: { in: pageIds } },
				});
				const priorItemsById = new Map(priorItems.map((item) => [item.nativeId, item]));
				const priorRows = pageIds.map((nativeId) => {
					const item = priorItemsById.get(nativeId);
					return item ? parseStoredItem(item, "library") : null;
				});
				if (priorRows.some((row) => row === null))
					return { status: "unavailable", reason: "malformed-publication" } as const;
				rows = reconcileNativeInventoryIdentifiers(priorRows as NativeInventoryRow[], rows);
			}
			return {
				...first,
				rows,
				filteredItemCount: missingIds.length,
				nextNativeId: remainingIds.length > limit ? (pageIds[pageIds.length - 1] ?? null) : null,
			} as const;
		},
		{ isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 },
	);
}

async function readOwnedArrCatalog(prisma: PrismaClient, userId: string) {
	const index = createArrConnectionIndex([]);
	let count = 0;
	let afterId: string | undefined;
	for (;;) {
		const page = await prisma.libraryCache.findMany({
			where: {
				instance: { userId, enabled: true, service: { in: ["SONARR", "RADARR"] } },
				itemType: { in: ["movie", "series"] },
				...(afterId ? { id: { gt: afterId } } : {}),
			},
			select: {
				id: true,
				instanceId: true,
				arrItemId: true,
				itemType: true,
				title: true,
				data: true,
			},
			orderBy: { id: "asc" },
			take: ARR_CATALOG_BATCH_SIZE,
		});
		const items: ArrConnectionItem[] = [];
		for (const row of page) {
			if (row.itemType !== "movie" && row.itemType !== "series") continue;
			items.push({ ...row, itemType: row.itemType });
		}
		count += page.length;
		if (count > MAX_CONNECTION_ITEMS) return undefined;
		for (const [key, values] of createArrConnectionIndex(items))
			index.set(key, [...(index.get(key) ?? []), ...values]);
		if (page.length < ARR_CATALOG_BATCH_SIZE) return index;
		afterId = page[page.length - 1]?.id;
	}
}

export async function readProviderInventoryConnections(
	prisma: PrismaClient,
	input: InventoryConnectionReadInput,
	log: FastifyBaseLogger,
	observe?: (timing: ProviderInventoryReadTiming) => void,
) {
	async function observeRead<T>(
		stage: ProviderInventoryReadTiming["stage"],
		read: () => Promise<T>,
	) {
		if (!observe) return read();
		const startedAt = performance.now();
		let outcome: ProviderInventoryReadTiming["outcome"] = "error";
		try {
			const value = await read();
			outcome = "returned";
			return value;
		} finally {
			try {
				observe({
					stage,
					outcome,
					elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
				});
			} catch {
				// Diagnostics cannot change the read's original value or error.
			}
		}
	}
	const now = input.now ?? new Date();
	const page = await observeRead("native-page", async () =>
		input.metadataFilter
			? await readMissingTmdbLibraryPage(prisma, { ...input, now })
			: await readNativeInventoryDisplayPage(prisma, { ...input, now }),
	);
	if (page.status !== "available") return page;
	const parentNativeIds = [
		...new Set(page.rows.flatMap((row) => (row.parentNativeId ? [row.parentNativeId] : []))),
	];
	const selection =
		input.domain === "episode" && parentNativeIds.length
			? await readNativeInventoryDisplayTargets(prisma, {
					userId: input.userId,
					instanceId: input.instanceId,
					now,
					nativeIds: parentNativeIds,
				}).catch(() => undefined)
			: undefined;
	let parents =
		selection?.status === "available" && selection.publicationItemCount <= MAX_CONNECTION_ITEMS
			? selection
			: undefined;
	const unknownWatch = new Map<string, ProviderNativeWatchDisplay>(
		page.rows.map((row) => [
			row.nativeId,
			{ state: "unknown", freshness: "unavailable", valueSemantics: "unknown", observedAt: null },
		]),
	);
	let watch =
		input.domain === "episode" ? unknownWatch : new Map<string, ProviderNativeWatchDisplay>();
	let includeWatchCoverage = false;
	if (input.domain === "episode") {
		try {
			const instance = await prisma.serviceInstance.findFirst({
				where: { id: input.instanceId, userId: input.userId, enabled: true },
				select: { service: true },
			});
			if (instance?.service === "PLEX" && parents) {
				const evidence = await new PlexAuthorityService({
					prisma,
					log,
				}).readPositiveEpisodeDisplayEvidence({
					userId: input.userId,
					instanceId: input.instanceId,
					now,
				});
				watch = new Map(
					projectPlexNativeEpisodeWatchPage({
						rows: page.rows,
						parents: parents.rows,
						evidence,
						inventoryFreshness: page.freshness,
						parentFreshness: parents.freshness,
						inventoryObservedAt: page.observedAt,
						parentObservedAt: parents.observedAt,
					}),
				);
			} else if (instance?.service === "JELLYFIN" || instance?.service === "EMBY") {
				includeWatchCoverage = true;
				watch = new Map(
					await readNativeEpisodeWatchPage(prisma, {
						userId: input.userId,
						instanceId: input.instanceId,
						rows: page.rows,
						now,
					}),
				);
			}
		} catch {
			watch = unknownWatch;
		}
	}
	let arrIndex: Awaited<ReturnType<typeof readOwnedArrCatalog>>;
	try {
		arrIndex = await observeRead(
			"arr-catalog",
			async () => await readOwnedArrCatalog(prisma, input.userId),
		);
	} catch {
		arrIndex = undefined;
	}
	if (parents) {
		const currentParent = await readNativeInventoryDisplayTargets(prisma, {
			userId: input.userId,
			instanceId: input.instanceId,
			now,
			nativeIds: parentNativeIds,
			expectedGenerationId: parents.generationId,
			expectedAuthority: input.expectedAuthority,
			maxAgeMs: input.maxAgeMs,
		});
		if (currentParent.status !== "available") {
			parents = undefined;
			watch = unknownWatch;
		}
	}
	const parentById = new Map(parents?.rows.map((row) => [row.nativeId, row]));
	const rows = page.rows.map((row) => {
		const parent = row.parentNativeId ? parentById.get(row.parentNativeId) : undefined;
		const subject =
			row.mediaType === "episode" ? (parent?.mediaType === "series" ? parent : undefined) : row;
		const connection: ProviderInventoryConnection = !arrIndex
			? { status: "unknown", reason: "arr-catalog-unavailable", arrItems: [] }
			: !subject
				? { status: "unknown", reason: "parent-unavailable", arrItems: [] }
				: resolveArrConnection(subject, arrIndex);
		return {
			...row,
			connection,
			...(watch.has(row.nativeId) ? { watch: watch.get(row.nativeId)! } : {}),
		};
	});
	// Do not attach relationships to a native page superseded during the ARR read.
	const latest = await observeRead(
		"native-postcheck",
		async () =>
			await readNativeInventoryDisplayPage(prisma, {
				...input,
				now,
				limit: 1,
				afterNativeId: undefined,
				expectedGenerationId: page.generationId,
			}),
	);
	if (latest.status !== "available") return latest;
	const watchCoverage: ProviderNativeWatchCoverage | undefined = includeWatchCoverage
		? await readOwnedNativeWatchCoverage(prisma, {
				userId: input.userId,
				instanceId: input.instanceId,
			}).catch(() => ({ status: "unavailable", reason: "malformed-publication" }) as const)
		: undefined;
	return {
		...latest,
		nextNativeId: page.nextNativeId,
		rows,
		...(watchCoverage ? { watchCoverage } : {}),
		...("filteredItemCount" in page ? { filteredItemCount: page.filteredItemCount } : {}),
	};
}
