import type { TautulliHistoryItem, TautulliHistorySnapshot } from "@arr/shared";

export function createTautulliHistorySnapshot(
	items: TautulliHistoryItem[],
	recordsFiltered: number,
	recordsTotal: number,
	complete: boolean,
	incompleteReason?: TautulliHistorySnapshot["incompleteReason"],
): TautulliHistorySnapshot {
	return {
		items,
		recordsFiltered,
		recordsTotal,
		complete,
		...(incompleteReason ? { incompleteReason } : {}),
	};
}
