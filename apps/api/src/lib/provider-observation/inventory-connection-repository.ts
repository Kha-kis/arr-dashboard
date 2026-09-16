import type { ProviderInventoryConnection } from "@arr/shared";
import type { PrismaClient } from "../prisma.js";
import {
	createArrConnectionIndex,
	resolveArrConnection,
	type ArrConnectionItem,
} from "./inventory-connections.js";
import { readNativeInventoryPage, type NativeInventoryRow } from "./native-inventory.js";

const MAX_CONNECTION_ITEMS = 100_000;
type NativeReadInput = Parameters<typeof readNativeInventoryPage>[1];

/** Bounded, generation-pinned read. Partial pages never become a complete catalog. */
export async function readCompleteNativeLibrary(
	prisma: PrismaClient,
	input: {
		userId: string;
		instanceId: string;
		now?: Date;
	},
) {
	const libraryInput = { userId: input.userId, instanceId: input.instanceId, now: input.now };
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
			take: 200,
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
		if (page.length < 200) return index;
		afterId = page[page.length - 1]?.id;
	}
}

export async function readProviderInventoryConnections(
	prisma: PrismaClient,
	input: NativeReadInput,
) {
	const page = await readNativeInventoryPage(prisma, input);
	if (page.status !== "available") return page;
	let arrIndex: Awaited<ReturnType<typeof readOwnedArrCatalog>>;
	try {
		arrIndex = await readOwnedArrCatalog(prisma, input.userId);
	} catch {
		arrIndex = undefined;
	}
	let parents =
		input.domain === "episode" && page.rows.some((row) => row.parentNativeId)
			? await readCompleteNativeLibrary(prisma, input).catch(() => undefined)
			: undefined;
	if (parents) {
		const currentParent = await readNativeInventoryPage(prisma, {
			...input,
			domain: "library",
			afterNativeId: undefined,
			limit: 1,
			expectedGenerationId: parents.generationId,
		});
		if (currentParent.status !== "available") parents = undefined;
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
		return { ...row, connection };
	});
	// Do not attach relationships to a native page superseded during the ARR read.
	const latest = await readNativeInventoryPage(prisma, {
		...input,
		limit: 1,
		afterNativeId: undefined,
		expectedGenerationId: page.generationId,
	});
	if (latest.status !== "available") return latest;
	return { ...latest, nextNativeId: page.nextNativeId, rows };
}
