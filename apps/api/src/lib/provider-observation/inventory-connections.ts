import type { ProviderInventoryConnection } from "@arr/shared";

export type InventoryExternalIds = { tmdb?: number[]; tvdb?: number[] };
export interface ArrConnectionItem {
	instanceId: string;
	arrItemId: number;
	itemType: "movie" | "series";
	title: string;
	data: string;
}
type IndexedItem = Omit<ArrConnectionItem, "data"> & { externalIds: InventoryExternalIds };
export type ArrConnectionIndex = Map<string, IndexedItem[]>;

const families = ["tmdb", "tvdb"] as const;

export function normalizeConnectionIds(
	value: InventoryExternalIds | undefined,
): InventoryExternalIds {
	const result: InventoryExternalIds = {};
	for (const family of families) {
		const ids = value?.[family];
		if (Array.isArray(ids)) {
			const valid = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].sort(
				(a, b) => a - b,
			);
			if (valid.length) result[family] = valid;
		}
	}
	return result;
}

export function arrConnectionIds(data: string): InventoryExternalIds {
	try {
		const parsed = JSON.parse(data);
		const ids = parsed?.remoteIds;
		return normalizeConnectionIds({
			tmdb: [ids?.tmdbId, parsed?.tmdbId],
			tvdb: [ids?.tvdbId, parsed?.tvdbId],
		});
	} catch {
		return {};
	}
}

export function createArrConnectionIndex(items: readonly ArrConnectionItem[]): ArrConnectionIndex {
	const index: ArrConnectionIndex = new Map();
	for (const { data, ...item } of items) {
		const externalIds = arrConnectionIds(data);
		const entry = { ...item, externalIds };
		for (const family of families) {
			for (const id of externalIds[family] ?? []) {
				const key = `${item.itemType}:${family}:${id}`;
				const entries = index.get(key) ?? [];
				entries.push(entry);
				index.set(key, entries);
			}
		}
	}
	return index;
}

/** Content correlation only. This never identifies a physical file or authorizes a write. */
export function resolveArrConnection(
	item: { mediaType: string; externalIds?: InventoryExternalIds },
	index: ArrConnectionIndex,
	arrInstanceId?: string,
): ProviderInventoryConnection {
	const ids = normalizeConnectionIds(item.externalIds);
	if (families.every((family) => !ids[family]?.length)) {
		return { status: "unknown", reason: "missing-identifiers", arrItems: [] };
	}
	const matches = new Map<string, IndexedItem>();
	for (const family of families) {
		for (const id of ids[family] ?? []) {
			for (const candidate of index.get(`${item.mediaType}:${family}:${id}`) ?? []) {
				if (!arrInstanceId || candidate.instanceId === arrInstanceId) {
					matches.set(
						`${candidate.instanceId}:${candidate.itemType}:${candidate.arrItemId}`,
						candidate,
					);
				}
			}
		}
	}
	const candidates = [...matches.values()].sort(
		(a, b) => a.instanceId.localeCompare(b.instanceId) || a.arrItemId - b.arrItemId,
	);
	const arrItems = candidates.map(({ externalIds: _ids, ...candidate }) => candidate);
	const conflict =
		families.some((family) => (ids[family]?.length ?? 0) > 1) ||
		candidates.some((candidate) =>
			families.some(
				(family) =>
					(candidate.externalIds[family]?.length ?? 0) > 1 ||
					(ids[family]?.length &&
						candidate.externalIds[family]?.length &&
						JSON.stringify(ids[family]) !== JSON.stringify(candidate.externalIds[family])),
			),
		);
	if (conflict) return { status: "ambiguous", reason: "conflicting-identifiers", arrItems };
	if (arrItems.length > 1) return { status: "ambiguous", reason: "multiple-arr-items", arrItems };
	if (arrItems.length === 0) return { status: "unmatched", reason: "no-arr-match", arrItems };
	return { status: "matched", reason: "matched-identifiers", arrItems };
}
