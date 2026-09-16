import { describe, expect, it } from "vitest";
import {
	deriveHistorySourceFailureSuccessor,
	deriveHistorySourcePageResult,
	type HistorySourceSchedule,
	parseHistorySourceRunningSchedule,
	parseHistorySourceTerminalSchedule,
} from "../history-source-schedule.js";

const terminal = (overrides: Record<string, unknown> = {}) => ({
	collectHeadNext: true,
	nextBackfillPage: 2,
	activeCollectionPage: null,
	...overrides,
});

const running = (overrides: Record<string, unknown> = {}) => ({
	collectHeadNext: true,
	nextBackfillPage: 2,
	activeCollectionPage: 1,
	...overrides,
});

describe("History source scheduling authority", () => {
	it.each([
		["head", terminal(), { phase: "head", collectionPage: 1, backfillPage: 2 }],
		[
			"advanced backfill",
			terminal({ collectHeadNext: false, nextBackfillPage: 7 }),
			{ phase: "backfill", collectionPage: 7, backfillPage: 7 },
		],
	])("parses a valid terminal %s schedule", (_name, input, expected) => {
		expect(parseHistorySourceTerminalSchedule(input)).toEqual({ valid: true, schedule: expected });
	});

	it.each([
		["head page 1", running(), { phase: "head", collectionPage: 1, backfillPage: 2 }],
		[
			"retained backfill page 7",
			running({ collectHeadNext: false, nextBackfillPage: 7, activeCollectionPage: 7 }),
			{ phase: "backfill", collectionPage: 7, backfillPage: 7 },
		],
	])("parses a valid running %s schedule", (_name, input, expected) => {
		expect(parseHistorySourceRunningSchedule(input)).toEqual({ valid: true, schedule: expected });
	});

	it("rejects an active page from a terminal schedule", () => {
		expect(parseHistorySourceTerminalSchedule(terminal({ activeCollectionPage: 1 }))).toEqual({
			valid: false,
		});
	});

	it.each([
		["invalid backfill page", terminal({ collectHeadNext: false, nextBackfillPage: 1 })],
		["running without active page", running({ activeCollectionPage: undefined })],
		["running head with page 2", running({ activeCollectionPage: 2 })],
		[
			"running backfill with page mismatch",
			running({ collectHeadNext: false, nextBackfillPage: 7, activeCollectionPage: 8 }),
		],
		["fractional page", running({ activeCollectionPage: 1.5 })],
		["unknown field", { ...terminal(), desiredPage: 9 }],
	])("rejects %s", (_name, input) => {
		const result =
			input.activeCollectionPage === null
				? parseHistorySourceTerminalSchedule(input)
				: parseHistorySourceRunningSchedule(input);
		expect(result).toEqual({ valid: false });
	});

	it.each([
		[
			"head failure",
			{ phase: "head", collectionPage: 1, backfillPage: 2 },
			{ phase: "backfill", collectionPage: 2, backfillPage: 2 },
		],
		[
			"backfill failure",
			{ phase: "backfill", collectionPage: 9, backfillPage: 9 },
			{ phase: "head", collectionPage: 1, backfillPage: 9 },
		],
	])("derives the retained-cursor failure successor for %s", (_name, schedule, expected) => {
		expect(deriveHistorySourceFailureSuccessor(schedule as HistorySourceSchedule)).toEqual(
			expected,
		);
	});

	it.each([
		[
			"head terminal empty",
			{ phase: "head", collectionPage: 1, backfillPage: 2 },
			{ rawRecordCount: 0, normalizedRows: [], totalRecordsHint: null },
			{
				result: "success",
				terminal: true,
				successor: { phase: "head", collectionPage: 1, backfillPage: 2 },
			},
		],
		[
			"head full nonterminal",
			{ phase: "head", collectionPage: 1, backfillPage: 8 },
			{ rawRecordCount: 100, normalizedRows: Array(100).fill({}), totalRecordsHint: 250 },
			{
				result: "success",
				terminal: false,
				successor: { phase: "backfill", collectionPage: 8, backfillPage: 8 },
			},
		],
		[
			"backfill short",
			{ phase: "backfill", collectionPage: 9, backfillPage: 9 },
			{ rawRecordCount: 3, normalizedRows: Array(3).fill({}), totalRecordsHint: null },
			{
				result: "success",
				terminal: true,
				successor: { phase: "head", collectionPage: 1, backfillPage: 2 },
			},
		],
		[
			"backfill full nonterminal advances",
			{ phase: "backfill", collectionPage: 9, backfillPage: 9 },
			{ rawRecordCount: 100, normalizedRows: Array(100).fill({}), totalRecordsHint: 1_000 },
			{
				result: "success",
				terminal: false,
				successor: { phase: "head", collectionPage: 1, backfillPage: 10 },
			},
		],
		[
			"page 100 exact hint",
			{ phase: "backfill", collectionPage: 100, backfillPage: 100 },
			{ rawRecordCount: 100, normalizedRows: Array(100).fill({}), totalRecordsHint: 10_000 },
			{
				result: "success",
				terminal: true,
				successor: { phase: "head", collectionPage: 1, backfillPage: 2 },
			},
		],
		[
			"page 100 short null hint",
			{ phase: "backfill", collectionPage: 100, backfillPage: 100 },
			{ rawRecordCount: 0, normalizedRows: [], totalRecordsHint: null },
			{
				result: "success",
				terminal: true,
				successor: { phase: "head", collectionPage: 1, backfillPage: 2 },
			},
		],
		[
			"page 100 full null hint publishes with provider limit finish",
			{ phase: "backfill", collectionPage: 100, backfillPage: 100 },
			{ rawRecordCount: 100, normalizedRows: Array(100).fill({}), totalRecordsHint: null },
			{
				result: "success",
				terminal: true,
				successor: { phase: "head", collectionPage: 1, backfillPage: 2 },
				finish: { result: "error", reason: "provider-limit" },
			},
		],
		[
			"page 100 full greater hint publishes with provider limit finish",
			{ phase: "backfill", collectionPage: 100, backfillPage: 100 },
			{ rawRecordCount: 100, normalizedRows: Array(100).fill({}), totalRecordsHint: 10_001 },
			{
				result: "success",
				terminal: true,
				successor: { phase: "head", collectionPage: 1, backfillPage: 2 },
				finish: { result: "error", reason: "provider-limit" },
			},
		],
	])("classifies %s", (_name, schedule, receipt, expected) => {
		expect(deriveHistorySourcePageResult(schedule as HistorySourceSchedule, receipt)).toEqual(
			expected,
		);
	});

	it("rejects malformed counts, hints, row counts, and pages without guessing", () => {
		const schedule = {
			phase: "backfill",
			collectionPage: 2,
			backfillPage: 2,
		} as HistorySourceSchedule;
		for (const receipt of [
			{ rawRecordCount: -1, normalizedRows: [], totalRecordsHint: null },
			{ rawRecordCount: 1.5, normalizedRows: [{}], totalRecordsHint: null },
			{ rawRecordCount: 101, normalizedRows: Array(101).fill({}), totalRecordsHint: 201 },
			{ rawRecordCount: 1, normalizedRows: [], totalRecordsHint: null },
			{ rawRecordCount: 1, normalizedRows: [{}], totalRecordsHint: 100 },
			{ rawRecordCount: 1, normalizedRows: [{}], totalRecordsHint: -1 },
		]) {
			const expectedReason =
				receipt.rawRecordCount === 1 && receipt.normalizedRows.length === 0
					? "rows-inconsistent"
					: "receipt-invalid";
			expect(deriveHistorySourcePageResult(schedule, receipt)).toEqual({
				result: "error",
				reason: expectedReason,
			});
		}
		for (const malformed of [
			{ phase: "head", collectionPage: 2, backfillPage: 2 },
			{ phase: "backfill", collectionPage: 1, backfillPage: 2 },
			{ phase: "backfill", collectionPage: 101, backfillPage: 101 },
		]) {
			expect(
				deriveHistorySourcePageResult(malformed as HistorySourceSchedule, {
					rawRecordCount: 0,
					normalizedRows: [],
					totalRecordsHint: null,
				}),
			).toEqual({ result: "error", reason: "receipt-invalid" });
		}
	});
});
