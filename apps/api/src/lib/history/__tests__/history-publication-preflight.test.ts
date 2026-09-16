import type { HistoryService } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	type NormalizedHistoryObservation,
	normalizeHistoryObservation,
} from "../../dashboard/history-utils.js";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import { decodeHistoryObservationMetadata } from "../history-observation-metadata.js";
import {
	buildHistoryPublicationPreflight,
	HISTORY_OBSERVATION_RETENTION_WINDOW_MS,
	type HistoryPublicationPreflightInput,
} from "../history-publication-preflight.js";
import { historyServiceToCoverageProvider } from "../history-source-contract.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const ATTEMPT = new Date("2026-09-03T11:59:00.000Z");
const SERVICES: readonly HistoryService[] = ["sonarr", "radarr", "prowlarr", "lidarr", "readarr"];

function observation(
	service: HistoryService,
	providerEventId: number,
	eventAt = NOW,
): NormalizedHistoryObservation {
	const raw = {
		id: providerEventId,
		date: eventAt.toISOString(),
		eventType: "Downloaded",
		title: `${service}-${providerEventId}`,
	};
	const normalized = normalizeHistoryObservation(raw, service);
	if (!normalized.ok) throw new Error("test fixture normalization failed");
	return normalized.observation;
}

function input(
	service: HistoryService,
	rows: readonly NormalizedHistoryObservation[],
	overrides: Partial<HistoryPublicationPreflightInput> = {},
): HistoryPublicationPreflightInput {
	return {
		service,
		connectionGeneration: 4,
		databaseNow: NOW,
		attemptStartedAt: ATTEMPT,
		normalizedRows: rows,
		rawObserved: rows.length,
		pagesAttempted: 1,
		pagesCompleted: 1,
		fatalCount: 0,
		outcome: { result: "success" },
		...overrides,
	};
}

function publish(value: HistoryPublicationPreflightInput) {
	const result = buildHistoryPublicationPreflight(value);
	expect(result.kind).toBe("publish");
	if (result.kind !== "publish") throw new Error("expected publish result");
	return result;
}

describe("buildHistoryPublicationPreflight", () => {
	it("constructs provider-bound metadata for every History service", () => {
		for (const service of SERVICES) {
			const result = publish(input(service, [observation(service, 1)]));
			expect(result.finish).toEqual({ result: "success", reason: null });
			const decoded = decodeHistoryObservationMetadata(result.publicationMetadata, NOW);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) continue;
			expect(decoded.metadata.service).toBe(service);
			expect(decoded.metadata.coverageReceipt.provider).toBe(
				historyServiceToCoverageProvider(service),
			);
			expect(decoded.metadata.coverageReceipt.publishedCanonicalEntities).toBe(1);
		}
	});

	it("revalidates, sorts, deduplicates, and does not mutate input rows", () => {
		const first = observation("sonarr", 9);
		const second = observation("sonarr", 2);
		const duplicate = observation("sonarr", 9);
		const rows = [first, second, duplicate];
		const before = structuredClone(rows);
		const result = publish(input("sonarr", rows));
		expect(result.rows.map((row) => row.providerEventId)).toEqual([2, 9]);
		expect(result.rows[0]?.eventAt).toEqual(new Date(NOW));
		expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual([
			"eventAt",
			"eventTypeKey",
			"normalizedPayload",
			"providerEventId",
			"searchText",
		]);
		expect(result.rows[0]?.eventAt).not.toBe(NOW);
		expect(result.observedAt).not.toBe(NOW);
		expect(result.observedAt).not.toBe(ATTEMPT);
		expect(rows).toEqual(before);
		expect(buildHistoryPublicationPreflight(input("sonarr", rows))).toEqual(
			buildHistoryPublicationPreflight(input("sonarr", rows)),
		);
	});

	it("accounts current and old occurrences exactly, including the inclusive boundary", () => {
		const boundary = new Date(NOW.getTime() - HISTORY_OBSERVATION_RETENTION_WINDOW_MS);
		const old = new Date(boundary.getTime() - 1);
		const result = publish(
			input("radarr", [observation("radarr", 1, boundary), observation("radarr", 2, old)]),
		);
		const unit = JSON.parse(result.publicationMetadata).coverageReceipt.units[0];
		expect(unit).toMatchObject({
			rawObserved: 2,
			sourceBindings: 1,
			canonicalEntities: 1,
		});
		expect(JSON.parse(result.publicationMetadata).coverageReceipt.publishedCanonicalEntities).toBe(
			1,
		);
		expect(unit.acceptedSkips).toEqual([{ reason: "bounded-window-truncation", count: 1 }]);
		const decoded = decodeHistoryObservationMetadata(result.publicationMetadata, NOW);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) {
			expect(evaluateProviderCoverageReceipt(decoded.metadata.coverageReceipt).reasonCodes).toEqual(
				["positive-only", "provider-limit", "accepted-skips", "coverage-incomplete"],
			);
		}
	});

	it("keeps identical duplicates as source bindings while publishing one entity", () => {
		const result = publish(
			input("prowlarr", [observation("prowlarr", 7), observation("prowlarr", 7)]),
		);
		const unit = JSON.parse(result.publicationMetadata).coverageReceipt.units[0];
		expect(result.rows).toHaveLength(1);
		expect(unit).toMatchObject({ rawObserved: 2, sourceBindings: 2, canonicalEntities: 1 });
		expect(result.observedIdentities).toEqual([{ providerEventId: 7, eventAt: new Date(NOW) }]);
	});

	it("returns every unique identity, including old rows, without row payload fields", () => {
		const boundary = new Date(NOW.getTime() - HISTORY_OBSERVATION_RETENTION_WINDOW_MS);
		const old = new Date(boundary.getTime() - 1);
		const result = publish(
			input("radarr", [observation("radarr", 4, old), observation("radarr", 2, boundary)]),
		);
		expect(result.observedIdentities).toEqual([
			{ providerEventId: 2, eventAt: boundary },
			{ providerEventId: 4, eventAt: old },
		]);
		expect(result.rows.map((row) => row.providerEventId)).toEqual([2]);
		for (const identity of result.observedIdentities) {
			expect(Object.keys(identity).sort()).toEqual(["eventAt", "providerEventId"]);
			expect(identity.eventAt).not.toBe(old);
			expect(identity.eventAt).not.toBe(boundary);
		}
		expect(JSON.stringify(result.observedIdentities)).not.toContain("radarr");
		expect(JSON.stringify(result.observedIdentities)).not.toContain("title");
	});

	it.each([
		[
			"payload",
			(row: NormalizedHistoryObservation) => ({
				...row,
				normalizedPayload: `${row.normalizedPayload} `,
			}),
		],
		[
			"payload object",
			(row: NormalizedHistoryObservation) => ({
				...row,
				payload: { ...row.payload, eventType: "tampered" },
			}),
		],
		["search", (row: NormalizedHistoryObservation) => ({ ...row, searchText: "tampered" })],
		["extra row key", (row: NormalizedHistoryObservation) => ({ ...row, extra: "sentinel" })],
		[
			"missing row key",
			(row: NormalizedHistoryObservation) => {
				const copy: Record<string, unknown> = { ...row };
				delete copy.searchText;
				return copy;
			},
		],
		[
			"provider ID",
			(row: NormalizedHistoryObservation) => ({
				...row,
				normalizedPayload: JSON.stringify({ ...row.payload, providerEventId: 99 }),
			}),
		],
		[
			"event time",
			(row: NormalizedHistoryObservation) => ({
				...row,
				normalizedPayload: JSON.stringify({ ...row.payload, eventAt: "2026-09-03T12:00:00.001Z" }),
			}),
		],
		[
			"event type",
			(row: NormalizedHistoryObservation) => ({
				...row,
				normalizedPayload: JSON.stringify({ ...row.payload, eventType: "tampered" }),
			}),
		],
	] as const)("preserves without echoing a tampered %s", (_label, mutate) => {
		const result = buildHistoryPublicationPreflight(
			input("sonarr", [
				mutate(observation("sonarr", 1)) as unknown as NormalizedHistoryObservation,
			]),
		);
		expect(result).toEqual({ kind: "preserve", reason: "rows-inconsistent" });
		expect(JSON.stringify(result)).not.toContain("sentinel");
	});

	it("rejects a valid canonical payload from the wrong service", () => {
		const wrongService = observation("radarr", 1);
		const result = buildHistoryPublicationPreflight(input("sonarr", [wrongService]));
		expect(result).toEqual({ kind: "preserve", reason: "rows-inconsistent" });
	});

	it("rejects same-ID same-time observations with different canonical payloads", () => {
		const first = observation("sonarr", 8, NOW);
		const secondRaw = normalizeHistoryObservation(
			{ id: 8, date: NOW.toISOString(), eventType: "Downloaded", title: "different" },
			"sonarr",
		);
		expect(secondRaw.ok).toBe(true);
		if (!secondRaw.ok) return;
		expect(
			buildHistoryPublicationPreflight(input("sonarr", [first, secondRaw.observation])),
		).toEqual({
			kind: "preserve",
			reason: "rows-inconsistent",
		});
	});

	it("rejects a provider-event conflict before retention filtering", () => {
		const current = observation("sonarr", 3, NOW);
		const old = observation(
			"sonarr",
			3,
			new Date(NOW.getTime() - HISTORY_OBSERVATION_RETENTION_WINDOW_MS - 1),
		);
		const result = buildHistoryPublicationPreflight(input("sonarr", [current, old]));
		expect(result).toEqual({ kind: "preserve", reason: "rows-inconsistent" });
	});

	it("publishes a zero-row page without claiming provider absence", () => {
		const result = publish(input("lidarr", []));
		expect(result.rows).toEqual([]);
		expect(result.publishedObservationCount).toBe(0);
		const decoded = decodeHistoryObservationMetadata(result.publicationMetadata, NOW);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.metadata.coverageReceipt.evidence).toBe("positive-only");
		expect(decoded.metadata.coverageReceipt.units[0]?.rawObserved).toBe(0);
		expect(evaluateProviderCoverageReceipt(decoded.metadata.coverageReceipt).reasonCodes).toEqual([
			"positive-only",
			"coverage-incomplete",
		]);
	});

	it("preserves an explicit zero-request provider-limit stop", () => {
		const result = buildHistoryPublicationPreflight(
			input("sonarr", [], {
				pagesAttempted: 0,
				pagesCompleted: 0,
				fatalCount: 0,
				outcome: { result: "error", reason: "provider-limit" },
			}),
		);
		expect(result).toEqual({ kind: "preserve", reason: "provider-limit" });
	});

	it("does not authorize a zero-request provider-unavailable outcome", () => {
		const result = buildHistoryPublicationPreflight(
			input("sonarr", [], {
				pagesAttempted: 0,
				pagesCompleted: 0,
				fatalCount: 0,
				outcome: { result: "error", reason: "provider-unavailable" },
			}),
		);
		expect(result).toEqual({ kind: "preserve", reason: "receipt-invalid" });
	});

	it.each([
		["provider-unavailable", "provider-unavailable"],
		["provider-limit", "provider-limit"],
	] as const)("publishes prior rows after a later-page %s failure", (_label, reason) => {
		const result = publish(
			input("readarr", [observation("readarr", 1)], {
				pagesAttempted: 2,
				pagesCompleted: 1,
				fatalCount: 1,
				outcome: { result: "error", reason },
			}),
		);
		expect(result.finish).toEqual({ result: "error", reason });
	});

	it("publishes observed rows on a bounded provider-limit stop without invented skips", () => {
		const result = publish(
			input("sonarr", [observation("sonarr", 1)], {
				outcome: { result: "error", reason: "provider-limit" },
			}),
		);
		expect(result.finish).toEqual({ result: "error", reason: "provider-limit" });
		expect(JSON.parse(result.publicationMetadata).coverageReceipt.units[0].acceptedSkips).toEqual(
			[],
		);
	});

	it.each(["rows-inconsistent", "receipt-invalid", "unknown-failure"] as const)(
		"does not publish prior rows for completed-page %s outcomes",
		(reason) => {
			const result = buildHistoryPublicationPreflight(
				input("sonarr", [observation("sonarr", 1)], {
					outcome: { result: "error", reason },
				}),
			);
			expect(result).toEqual({ kind: "preserve", reason });
		},
	);

	it.each([
		"provider-unavailable",
		"provider-limit",
		"rows-inconsistent",
		"receipt-invalid",
		"unknown-failure",
	] as const)("preserves first/no-page %s failure", (reason) => {
		const result = buildHistoryPublicationPreflight(
			input("sonarr", [], {
				pagesAttempted: 1,
				pagesCompleted: 0,
				fatalCount: 1,
				outcome: { result: "error", reason },
			}),
		);
		expect(result).toEqual({ kind: "preserve", reason });
	});

	it.each([
		["negative counter", () => ({ rows: [], pagesAttempted: -1 }), "receipt-invalid"],
		["fractional counter", () => ({ rows: [], pagesAttempted: 1.5 }), "receipt-invalid"],
		["negative raw count", () => ({ rows: [], rawObserved: -1 }), "receipt-invalid"],
		["fractional raw count", () => ({ rows: [], rawObserved: 1.5 }), "receipt-invalid"],
		[
			"unsafe raw count",
			() => ({ rows: [], rawObserved: Number.MAX_SAFE_INTEGER + 1 }),
			"receipt-invalid",
		],
		["negative completed count", () => ({ rows: [], pagesCompleted: -1 }), "receipt-invalid"],
		["fractional completed count", () => ({ rows: [], pagesCompleted: 1.5 }), "receipt-invalid"],
		[
			"unsafe completed count",
			() => ({ rows: [], pagesCompleted: Number.MAX_SAFE_INTEGER + 1 }),
			"receipt-invalid",
		],
		["negative fatal count", () => ({ rows: [], fatalCount: -1 }), "receipt-invalid"],
		["fractional fatal count", () => ({ rows: [], fatalCount: 1.5 }), "receipt-invalid"],
		[
			"unsafe fatal count",
			() => ({ rows: [], fatalCount: Number.MAX_SAFE_INTEGER + 1 }),
			"receipt-invalid",
		],
	] as const)("preserves invalid completed-page %s", (_label, makeOverride, reason) => {
		const override = makeOverride();
		const rows = override.rows;
		const result = buildHistoryPublicationPreflight(
			input("sonarr", rows, override as Partial<HistoryPublicationPreflightInput>),
		);
		expect(result).toEqual({ kind: "preserve", reason });
	});

	it.each([
		["future event", () => ({ rows: [observation("sonarr", 1, new Date(NOW.getTime() + 1))] })],
		["raw gap", () => ({ rows: [observation("sonarr", 1)], rawObserved: 2 })],
	] as const)("preserves %s as a row inconsistency", (_label, makeOverride) => {
		const override = makeOverride();
		const result = buildHistoryPublicationPreflight(
			input("sonarr", override.rows, override as Partial<HistoryPublicationPreflightInput>),
		);
		expect(result).toEqual({ kind: "preserve", reason: "rows-inconsistent" });
	});

	it.each([
		["invalid service", { service: "plex" }],
		["negative generation", { connectionGeneration: -1 }],
		["fractional generation", { connectionGeneration: 1.5 }],
		["unsafe generation", { connectionGeneration: Number.MAX_SAFE_INTEGER + 1 }],
		["invalid database time", { databaseNow: new Date("invalid") }],
		["invalid attempt time", { attemptStartedAt: new Date("invalid") }],
		["attempt after database time", { attemptStartedAt: new Date(NOW.getTime() + 1) }],
		["completed exceeds attempted", { pagesCompleted: 2, pagesAttempted: 1 }],
		["successful incomplete", { pagesAttempted: 2, pagesCompleted: 1 }],
		["successful fatal", { fatalCount: 1 }],
		["multiple fatal", { fatalCount: 2 }],
		[
			"error page mismatch",
			{
				pagesAttempted: 2,
				pagesCompleted: 1,
				fatalCount: 0,
				outcome: { result: "error", reason: "provider-unavailable" },
			},
		],
		["raw exceeds completed capacity", { rawObserved: 101 }],
	] as const)("rejects contradictory or invalid %s", (_label, override) => {
		const result = buildHistoryPublicationPreflight(
			input(
				"sonarr",
				[observation("sonarr", 1)],
				override as Partial<HistoryPublicationPreflightInput>,
			),
		);
		expect(result).toEqual({ kind: "preserve", reason: "receipt-invalid" });
	});

	it.each([
		["requests over bound", { pagesAttempted: 101 }],
		["completed pages over bound", { pagesAttempted: 101, pagesCompleted: 101 }],
	] as const)("preserves hard collection %s as provider-limit", (_label, override) => {
		const result = buildHistoryPublicationPreflight(
			input(
				"sonarr",
				[observation("sonarr", 1)],
				override as Partial<HistoryPublicationPreflightInput>,
			),
		);
		expect(result).toEqual({ kind: "preserve", reason: "provider-limit" });
	});

	it("uses provider-limit for a true 10,001-row hard bound before row validation", () => {
		const rows = Array.from({ length: 10_001 }, (_, id) => observation("sonarr", id));
		const result = buildHistoryPublicationPreflight(input("sonarr", rows, { rawObserved: 10_001 }));
		expect(result).toEqual({ kind: "preserve", reason: "provider-limit" });
	});

	it.each([null, "not-an-array", {}, 1] as const)(
		"fails closed for a runtime non-array normalizedRows value: %p",
		(normalizedRows) => {
			const result = buildHistoryPublicationPreflight({
				...input("sonarr", []),
				normalizedRows,
			} as unknown as HistoryPublicationPreflightInput);
			expect(result).toEqual({ kind: "preserve", reason: "receipt-invalid" });
		},
	);

	it("rejects malformed canonical payloads and never echoes their content", () => {
		const row = observation("sonarr", 1);
		const candidates = [
			{ ...row, normalizedPayload: "not-json" },
			{ ...row, normalizedPayload: JSON.stringify({ ...row.payload, eventType: "tampered" }) },
			{ ...row, normalizedPayload: `${"x".repeat(8192)}` },
		];
		for (const candidate of candidates) {
			const result = buildHistoryPublicationPreflight(input("sonarr", [candidate]));
			expect(result).toEqual({ kind: "preserve", reason: "rows-inconsistent" });
			expect(JSON.stringify(result)).not.toContain("tampered");
		}
	});

	it("does not expose caller-controlled publication or private fields", () => {
		const result = buildHistoryPublicationPreflight({
			...input("sonarr", [observation("sonarr", 1)]),
			receipt: { token: "secret" },
			providerTotal: 999,
			rawError: "private",
			url: "https://private.example.invalid/secret",
			cursor: "cursor-secret",
			ownerLabel: "owner-secret",
			instanceLabel: "instance-secret",
		} as HistoryPublicationPreflightInput & Record<string, unknown>);
		expect(result.kind).toBe("publish");
		if (result.kind !== "publish") return;
		expect(result).not.toHaveProperty("receipt");
		expect(result).not.toHaveProperty("providerTotal");
		expect(result).not.toHaveProperty("rawError");
		expect(result.publicationMetadata).not.toContain("secret");
		expect(result.publicationMetadata).not.toContain("private");
		expect(Object.keys(JSON.parse(result.publicationMetadata)).sort()).toEqual([
			"completeness",
			"connectionGeneration",
			"coverageReceipt",
			"observedAt",
			"publicationLevel",
			"publishedObservationCount",
			"service",
			"version",
		]);
		expect(result.publicationMetadata).not.toContain("reasonCodes");
		expect(result.publicationMetadata).not.toContain("providerTotal");
		expect(result.publicationMetadata).not.toContain("private.example.invalid");
		expect(result.publicationMetadata).not.toContain("cursor-secret");
		expect(result.publicationMetadata).not.toContain("owner-secret");
		expect(result.publicationMetadata).not.toContain("instance-secret");
	});
});
