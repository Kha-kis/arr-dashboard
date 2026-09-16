import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	deriveHistoryRowAuthority,
	HISTORY_CURSOR_MAX_LENGTH,
	HISTORY_SEARCH_TEXT_MAX_LENGTH,
	type HistoryReadFilter,
	historyFilterDigest,
	historySourceStateDigest,
	parseHistoryReadQuery,
} from "../history-read-contract.js";

const DATE = "2026-09-03T12:00:00.000Z";
const FILTER: HistoryReadFilter = {
	startDate: DATE,
	endDate: null,
	search: "grabbed test",
	service: "sonarr",
	instanceId: "instance-a",
	eventType: "grabbed",
	hideProwlarrRss: false,
};

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		instanceId: "instance-a",
		service: "sonarr",
		connectionGeneration: 1,
		publicationRevision: 2,
		retentionEpoch: 3,
		rowAuthority: "positive",
		...overrides,
	};
}

describe("History read query contract", () => {
	it("canonicalizes every query field and returns exact internal keys", () => {
		const result = parseHistoryReadQuery({
			limit: "7",
			startDate: DATE,
			endDate: "2026-09-04T12:00:00.000Z",
			search: "  GrAbBeD\u2003  Test ",
			service: "sonarr",
			instanceId: "instance-a",
			eventType: " Grabbed ",
			hideProwlarrRss: "true",
		});
		expect(result).toEqual({
			ok: true,
			query: {
				limit: 7,
				cursor: null,
				filter: {
					startDate: DATE,
					endDate: "2026-09-04T12:00:00.000Z",
					search: "grabbed test",
					service: "sonarr",
					instanceId: "instance-a",
					eventType: "grabbed",
					hideProwlarrRss: true,
				},
			},
		});
		expect(Object.keys((result as { query: unknown }).query as object).sort()).toEqual([
			"cursor",
			"filter",
			"limit",
		]);
	});

	it("uses bounded defaults and canonicalizes Unicode whitespace", () => {
		const result = parseHistoryReadQuery({ search: "\u00a0 Grabbed\u2003Test \u200b" });
		expect(result).toEqual({
			ok: true,
			query: {
				limit: 50,
				cursor: null,
				filter: {
					startDate: null,
					endDate: null,
					search: "grabbed test \u200b",
					service: null,
					instanceId: null,
					eventType: null,
					hideProwlarrRss: false,
				},
			},
		});
	});

	it.each([
		{ unknown: "x" },
		{ limit: ["2"] },
		{ limit: "01" },
		{ limit: "101" },
		{ limit: "1.0" },
		{ hideProwlarrRss: true },
		{ hideProwlarrRss: "yes" },
		{ startDate: "2026-09-03T12:00:00Z" },
		{ startDate: "2026-09-04T00:00:00.000Z", endDate: "2026-09-03T00:00:00.000Z" },
		{ service: "Sonarr" },
		{ instanceId: "https://bad" },
		{ eventType: "status\n" },
		{ search: "https://bad" },
		{ cursor: "opaque\n" },
	])("rejects malformed strict query %#", (input) => {
		expect(parseHistoryReadQuery(input)).toEqual({ ok: false });
	});

	it("rejects empty or oversized canonical search", () => {
		expect(parseHistoryReadQuery({ search: " \t\n " })).toEqual({ ok: false });
		expect(
			parseHistoryReadQuery({ search: `${" ".repeat(HISTORY_SEARCH_TEXT_MAX_LENGTH + 1)}x` }),
		).toEqual({
			ok: false,
		});
		expect(parseHistoryReadQuery({ search: "x\ty" })).toEqual({ ok: false });
		expect(
			parseHistoryReadQuery({ search: "x".repeat(HISTORY_SEARCH_TEXT_MAX_LENGTH + 1) }),
		).toEqual({
			ok: false,
		});
	});

	it("produces a fixed-key deterministic filter digest", () => {
		const expected = createHash("sha256").update(JSON.stringify(FILTER)).digest("hex");
		const reordered = {
			hideProwlarrRss: false,
			eventType: "grabbed",
			instanceId: "instance-a",
			service: "sonarr",
			search: "grabbed test",
			endDate: null,
			startDate: DATE,
		} satisfies HistoryReadFilter;
		expect(historyFilterDigest(FILTER)).toBe(expected);
		expect(historyFilterDigest(reordered)).toBe(historyFilterDigest(FILTER));
		expect(historyFilterDigest({ ...FILTER, service: "radarr" })).not.toBe(expected);
		expect(parseHistoryReadQuery({ eventType: `${" ".repeat(128 + 1)}grabbed` })).toEqual({
			ok: false,
		});
	});
});

describe("History source-state digest", () => {
	it("sorts only the explicit source projection and changes for every authority input", () => {
		const base = [source(), source({ instanceId: "instance-b", service: "radarr" })];
		const reversed = [...base].reverse();
		expect(historySourceStateDigest(base)).toBe(historySourceStateDigest(reversed));
		for (const overrides of [
			{ instanceId: "instance-c" },
			{ service: "radarr" },
			{ connectionGeneration: 2 },
			{ publicationRevision: 3 },
			{ retentionEpoch: 4 },
			{ rowAuthority: "unavailable" },
			{ publicationRevision: null },
			{ retentionEpoch: null },
		]) {
			expect(historySourceStateDigest([source(overrides)])).not.toBe(
				historySourceStateDigest([source()]),
			);
		}
	});

	it.each([
		[source(), source()],
		[source({ extra: true })],
		[source({ instanceId: "bad\n" })],
		[source({ connectionGeneration: -1 })],
		[source({ connectionGeneration: 1.5 })],
		[source({ publicationRevision: -1 })],
		[source({ retentionEpoch: 1.5 })],
		[source({ rowAuthority: "partial" })],
		[source({ service: "unknown" })],
	])("rejects malformed source state %#", (...args: unknown[]) => {
		expect(historySourceStateDigest(args)).toBeNull();
	});

	it("derives positive row authority only from the positive-only partial/last-known projection", () => {
		expect(deriveHistoryRowAuthority({ availability: "partial", evidence: "positive-only" })).toBe(
			"positive",
		);
		expect(
			deriveHistoryRowAuthority({ availability: "last-known", evidence: "positive-only" }),
		).toBe("positive");
		expect(deriveHistoryRowAuthority({ availability: "current", evidence: "positive-only" })).toBe(
			"unavailable",
		);
		expect(deriveHistoryRowAuthority({ availability: "partial", evidence: "unknown" })).toBe(
			"unavailable",
		);
	});

	it("rejects source extras instead of hashing them", () => {
		expect(historySourceStateDigest([source({ extra: true })])).toBeNull();
	});

	it("canonicalizes source field order before hashing", () => {
		const reordered = {
			rowAuthority: "positive",
			retentionEpoch: 3,
			publicationRevision: 2,
			connectionGeneration: 1,
			service: "sonarr",
			instanceId: "instance-a",
		};
		expect(historySourceStateDigest([reordered])).toBe(historySourceStateDigest([source()]));
	});

	it("requires revision and retention epoch to be a coherent pair", () => {
		expect(historySourceStateDigest([source({ publicationRevision: null })])).toBeNull();
		expect(historySourceStateDigest([source({ retentionEpoch: null })])).toBeNull();
		expect(
			historySourceStateDigest([
				source({ publicationRevision: null, retentionEpoch: null, rowAuthority: "unavailable" }),
			]),
		).toMatch(/^[a-f0-9]{64}$/);
		expect(
			historySourceStateDigest([
				source({ publicationRevision: 0, retentionEpoch: 0, rowAuthority: "unavailable" }),
			]),
		).toMatch(/^[a-f0-9]{64}$/);
		expect(
			historySourceStateDigest([
				source({ publicationRevision: null, retentionEpoch: null, rowAuthority: "positive" }),
			]),
		).toBeNull();
	});

	it("enforces the shared source cap", () => {
		const states = Array.from({ length: 1001 }, (_, index) =>
			source({ instanceId: `instance-${index}` }),
		);
		expect(historySourceStateDigest(states)).toBeNull();
	});

	it("keeps cursor bound available to callers", () => {
		expect(HISTORY_CURSOR_MAX_LENGTH).toBe(4096);
	});
});
