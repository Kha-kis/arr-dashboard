import type { NormalizedHistoryObservation } from "../dashboard/history-utils.js";
import {
	HISTORY_COLLECTION_MAX_REQUESTS,
	HISTORY_COLLECTION_PAGE_SIZE,
} from "./history-source-contract.js";

export const HISTORY_SOURCE_MIN_BACKFILL_PAGE = 2;
export const HISTORY_SOURCE_MAX_BACKFILL_PAGE = HISTORY_COLLECTION_MAX_REQUESTS;
export const HISTORY_SOURCE_PAGE_SIZE = HISTORY_COLLECTION_PAGE_SIZE;

export type HistorySourcePhase = "head" | "backfill";

export type HistorySourceSchedule = {
	phase: HistorySourcePhase;
	collectionPage: number;
	backfillPage: number;
};

export type HistorySourceDatabaseSchedule = {
	collectHeadNext: boolean;
	nextBackfillPage: number;
	activeCollectionPage: number | null;
};

export type HistorySourcePageReceipt = {
	rawRecordCount: number;
	normalizedRows: readonly NormalizedHistoryObservation[];
	totalRecordsHint: number | null;
};

export type HistorySourcePageResult =
	| {
			result: "success";
			terminal: boolean;
			successor: HistorySourceSchedule;
			finish?: { result: "error"; reason: "provider-limit" };
	  }
	| { result: "error"; reason: "provider-limit" | "receipt-invalid" | "rows-inconsistent" };

export type ParsedHistorySourceSchedule =
	| { valid: true; schedule: HistorySourceSchedule }
	| { valid: false };

export function parseHistorySourceTerminalSchedule(value: unknown): ParsedHistorySourceSchedule {
	if (!isExactScheduleRecord(value)) return { valid: false };
	if (value.activeCollectionPage !== null) return { valid: false };
	return parseDatabaseSchedule(value);
}

export function parseHistorySourceRunningSchedule(value: unknown): ParsedHistorySourceSchedule {
	if (!isExactScheduleRecord(value)) return { valid: false };
	if (!isSafeActivePage(value.activeCollectionPage)) return { valid: false };
	const parsed = parseDatabaseSchedule(value);
	if (!parsed.valid) return parsed;
	if (
		(parsed.schedule.phase === "head" && value.activeCollectionPage !== 1) ||
		(parsed.schedule.phase === "backfill" &&
			value.activeCollectionPage !== parsed.schedule.backfillPage)
	)
		return { valid: false };
	return parsed;
}

export function historySourceScheduleToDatabase(
	schedule: HistorySourceSchedule,
	activeCollectionPage: number | null = null,
): HistorySourceDatabaseSchedule | null {
	if (!isValidSchedule(schedule)) return null;
	if (activeCollectionPage !== null && activeCollectionPage !== schedule.collectionPage)
		return null;
	return {
		collectHeadNext: schedule.phase === "head",
		nextBackfillPage: schedule.backfillPage,
		activeCollectionPage,
	};
}

export function deriveHistorySourceFailureSuccessor(
	schedule: HistorySourceSchedule,
): HistorySourceSchedule {
	if (schedule.phase === "head") {
		return {
			phase: "backfill",
			collectionPage: schedule.backfillPage,
			backfillPage: schedule.backfillPage,
		};
	}
	return { phase: "head", collectionPage: 1, backfillPage: schedule.backfillPage };
}

export function deriveHistorySourcePageResult(
	schedule: HistorySourceSchedule,
	receipt: unknown,
): HistorySourcePageResult {
	if (!isValidSchedule(schedule)) {
		return { result: "error", reason: "receipt-invalid" };
	}
	if (
		isRecord(receipt) &&
		isSafeCount(receipt.rawRecordCount) &&
		Array.isArray(receipt.normalizedRows)
	) {
		if (receipt.normalizedRows.length !== receipt.rawRecordCount) {
			return { result: "error", reason: "rows-inconsistent" };
		}
	}
	if (!isValidReceipt(receipt, schedule.collectionPage)) {
		return { result: "error", reason: "receipt-invalid" };
	}
	const fullPage = receipt.rawRecordCount === HISTORY_SOURCE_PAGE_SIZE;
	const terminal =
		receipt.rawRecordCount < HISTORY_SOURCE_PAGE_SIZE ||
		(receipt.totalRecordsHint !== null &&
			schedule.collectionPage * HISTORY_SOURCE_PAGE_SIZE >= receipt.totalRecordsHint);
	if (schedule.collectionPage === HISTORY_SOURCE_MAX_BACKFILL_PAGE && fullPage && !terminal) {
		return {
			result: "success",
			terminal: true,
			successor: {
				phase: "head",
				collectionPage: 1,
				backfillPage: HISTORY_SOURCE_MIN_BACKFILL_PAGE,
			},
			finish: { result: "error", reason: "provider-limit" },
		};
	}
	if (terminal) {
		return {
			result: "success",
			terminal: true,
			successor: {
				phase: "head",
				collectionPage: 1,
				backfillPage: HISTORY_SOURCE_MIN_BACKFILL_PAGE,
			},
		};
	}
	if (schedule.phase === "head") {
		return {
			result: "success",
			terminal: false,
			successor: {
				phase: "backfill",
				collectionPage: schedule.backfillPage,
				backfillPage: schedule.backfillPage,
			},
		};
	}
	if (schedule.collectionPage >= HISTORY_SOURCE_MAX_BACKFILL_PAGE) {
		return { result: "error", reason: "provider-limit" };
	}
	return {
		result: "success",
		terminal: false,
		successor: {
			phase: "head",
			collectionPage: 1,
			backfillPage: schedule.collectionPage + 1,
		},
	};
}

function parseDatabaseSchedule(value: HistorySourceDatabaseSchedule): ParsedHistorySourceSchedule {
	if (!isSafePage(value.nextBackfillPage)) return { valid: false };
	if (value.collectHeadNext) {
		return {
			valid: true,
			schedule: { phase: "head", collectionPage: 1, backfillPage: value.nextBackfillPage },
		};
	}
	return {
		valid: true,
		schedule: {
			phase: "backfill",
			collectionPage: value.nextBackfillPage,
			backfillPage: value.nextBackfillPage,
		},
	};
}

function isValidSchedule(value: unknown): value is HistorySourceSchedule {
	if (!isRecord(value)) return false;
	return (
		(value.phase === "head" && value.collectionPage === 1 && isSafePage(value.backfillPage)) ||
		(value.phase === "backfill" &&
			isSafePage(value.collectionPage) &&
			value.collectionPage === value.backfillPage)
	);
}

function isValidReceipt(value: unknown, collectionPage: number): value is HistorySourcePageReceipt {
	if (
		!isRecord(value) ||
		!isSafeCount(value.rawRecordCount) ||
		value.rawRecordCount > HISTORY_SOURCE_PAGE_SIZE
	)
		return false;
	if (!Array.isArray(value.normalizedRows) || value.normalizedRows.length !== value.rawRecordCount)
		return false;
	if (value.totalRecordsHint !== null && !isSafeCount(value.totalRecordsHint)) return false;
	if (
		value.totalRecordsHint !== null &&
		value.totalRecordsHint < (collectionPage - 1) * HISTORY_SOURCE_PAGE_SIZE + value.rawRecordCount
	)
		return false;
	return true;
}

function isExactScheduleRecord(value: unknown): value is HistorySourceDatabaseSchedule {
	return (
		isRecord(value) &&
		Object.keys(value).sort().join(",") ===
			"activeCollectionPage,collectHeadNext,nextBackfillPage" &&
		typeof value.collectHeadNext === "boolean"
	);
}

function isSafePage(value: unknown): value is number {
	return (
		isSafeCount(value) &&
		value >= HISTORY_SOURCE_MIN_BACKFILL_PAGE &&
		value <= HISTORY_SOURCE_MAX_BACKFILL_PAGE
	);
}

function isSafeActivePage(value: unknown): value is number {
	return value === 1 || isSafePage(value);
}

function isSafeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
