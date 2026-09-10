import { describe, expect, it } from "vitest";
import {
	HISTORY_CURSOR_MAX_LENGTH,
	HISTORY_CUSTOM_FORMAT_MAX_COUNT,
	HISTORY_DISPLAY_TEXT_MAX_LENGTH,
	HISTORY_EVENT_TYPE_MAX_LENGTH,
	HISTORY_IDENTIFIER_TEXT_MAX_LENGTH,
	HISTORY_NORMALIZED_JSON_MAX_BYTES,
	HISTORY_PAGE_MAX_ITEMS,
	HISTORY_SEARCH_TEXT_MAX_LENGTH,
	HISTORY_SOURCE_MAX_COUNT,
	historyItemV2Schema,
	historyNormalizedPayloadV1Schema,
	historyPageInfoV2Schema,
	historyResponseV2Schema,
	historyServiceSchema,
	historySourceV2Schema,
	multiInstanceHistoryResponseSchema,
} from "../dashboard";

const common = {
	version: 1 as const,
	providerEventId: 42,
	eventAt: "2026-09-03T12:00:00.000Z",
	eventType: "grabbed",
};

const payloadFor = (service: "sonarr" | "radarr" | "prowlarr" | "lidarr" | "readarr") => ({
	...common,
	service,
	...(service === "sonarr" ? { seriesId: 1, seriesSlug: "synthetic-series", episodeId: 2 } : {}),
	...(service === "radarr" ? { movieId: 1, movieSlug: "synthetic-movie" } : {}),
	...(service === "prowlarr" ? { indexerId: 1 } : {}),
	...(service === "lidarr" ? { artistId: 1, albumId: 2, trackId: 3 } : {}),
	...(service === "readarr" ? { authorId: 1, bookId: 2 } : {}),
});

describe("strict History v2 shared contract", () => {
	it("exports the configured bounds", () => {
		expect(HISTORY_NORMALIZED_JSON_MAX_BYTES).toBe(8192);
		expect(HISTORY_SEARCH_TEXT_MAX_LENGTH).toBe(2048);
		expect(HISTORY_PAGE_MAX_ITEMS).toBe(100);
		expect(HISTORY_EVENT_TYPE_MAX_LENGTH).toBe(128);
		expect(HISTORY_DISPLAY_TEXT_MAX_LENGTH).toBe(512);
		expect(HISTORY_IDENTIFIER_TEXT_MAX_LENGTH).toBe(256);
		expect(HISTORY_CUSTOM_FORMAT_MAX_COUNT).toBe(32);
		expect(HISTORY_SOURCE_MAX_COUNT).toBe(1000);
		expect(HISTORY_CURSOR_MAX_LENGTH).toBe(4096);
	});

	it.each(["sonarr", "radarr", "prowlarr", "lidarr", "readarr"] as const)(
		"accepts a minimal %s payload branch",
		(service) => {
			expect(historyServiceSchema.parse(service)).toBe(service);
			expect(historyNormalizedPayloadV1Schema.parse(payloadFor(service))).toEqual(
				payloadFor(service),
			);
		},
	);

	it("rejects unknown and cross-service payload keys", () => {
		expect(
			historyNormalizedPayloadV1Schema.safeParse({
				...payloadFor("sonarr"),
				movieId: 9,
			}).success,
		).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({
				...payloadFor("radarr"),
				unexpected: "sentinel",
			}).success,
		).toBe(false);
	});

	it("enforces required canonical and bounded fields", () => {
		const base = payloadFor("sonarr");
		expect(
			historyNormalizedPayloadV1Schema.safeParse({ ...base, providerEventId: -1 }).success,
		).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({ ...base, providerEventId: 1.2 }).success,
		).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({ ...base, eventAt: "2026-09-03T12:00:00Z" })
				.success,
		).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({ ...base, eventType: " Grabbed " }).success,
		).toBe(false);
		expect(historyNormalizedPayloadV1Schema.safeParse({ ...base, eventType: "" }).success).toBe(
			false,
		);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({
				...base,
				eventType: "x".repeat(HISTORY_EVENT_TYPE_MAX_LENGTH + 1),
			}).success,
		).toBe(false);
	});

	it("accepts bounded optional fields and rejects malformed optional values", () => {
		const valid = {
			...payloadFor("sonarr"),
			downloadId: "download-1",
			title: "Synthetic title",
			sourceTitle: "Synthetic source",
			size: 1.5,
			qualityName: "WEB-DL",
			customFormats: [{ id: 1, name: "Preferred" }],
			customFormatScore: -10,
			downloadClient: "qbit",
			indexer: "indexer",
			protocol: "torrent",
		};
		expect(historyNormalizedPayloadV1Schema.safeParse(valid).success).toBe(true);
		expect(historyNormalizedPayloadV1Schema.safeParse({ ...valid, size: -1 }).success).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({
				...valid,
				title: "safe https://sentinel.invalid",
			}).success,
		).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({
				...valid,
				downloadClient: "client www.sentinel.invalid",
			}).success,
		).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({ ...valid, indexer: "prefix data:secret" })
				.success,
		).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({ ...valid, customFormatScore: 1.5 }).success,
		).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({
				...valid,
				customFormats: [{ id: -1, name: "bad" }],
			}).success,
		).toBe(false);
		expect(
			historyNormalizedPayloadV1Schema.safeParse({
				...valid,
				customFormats: Array.from({ length: HISTORY_CUSTOM_FORMAT_MAX_COUNT + 1 }, (_, id) => ({
					id,
					name: `format-${id}`,
				})),
			}).success,
		).toBe(false);
	});

	it("accepts strict item, source, page info, and response projections", () => {
		const item = {
			providerEventId: 42,
			eventAt: "2026-09-03T12:00:00.000Z",
			eventType: "grabbed",
			id: "observation-1",
			instanceId: "instance-1",
			instanceName: "Synthetic Sonarr",
			service: "sonarr" as const,
			seriesId: 1,
			seriesSlug: "synthetic-series",
			episodeId: 2,
		};
		const source = {
			instanceId: "instance-1",
			instanceName: "Synthetic Sonarr",
			service: "sonarr" as const,
			providerStatus: {
				availability: "partial" as const,
				evidence: "positive-only" as const,
				observedAt: "2026-09-03T12:00:00.000Z",
				ageSeconds: 30,
				latestAttempt: "successful" as const,
				reasonCodes: ["positive-only" as const],
			},
			retainedObservationCount: 1,
		};
		const pageInfo = { nextCursor: "cursor-1", hasNextPage: true, matchingObservedCount: 1 };
		expect(historyItemV2Schema.safeParse(item).success).toBe(true);
		expect(historySourceV2Schema.safeParse(source).success).toBe(true);
		expect(historyPageInfoV2Schema.safeParse(pageInfo).success).toBe(true);
		expect(
			historyResponseV2Schema.safeParse({ version: 2, items: [item], sources: [source], pageInfo })
				.success,
		).toBe(true);
		expect(historyItemV2Schema.safeParse({ ...item, version: 1 }).success).toBe(false);
	});

	it("accepts bounded URL-looking instance labels while rejecting unsafe labels", () => {
		const item = {
			id: "observation-1",
			instanceId: "instance-1",
			instanceName: "https://Synthetic Sonarr",
			service: "sonarr" as const,
			providerEventId: 42,
			eventAt: "2026-09-03T12:00:00.000Z",
			eventType: "grabbed",
		};
		expect(historyItemV2Schema.safeParse(item).success).toBe(true);
		expect(historyItemV2Schema.safeParse({ ...item, instanceName: "bad\nlabel" }).success).toBe(
			false,
		);
		expect(historyItemV2Schema.safeParse({ ...item, instanceName: "x".repeat(513) }).success).toBe(
			false,
		);
		expect(
			historySourceV2Schema.safeParse({
				instanceId: "instance-1",
				instanceName: "mailto:synthetic-label",
				service: "sonarr",
				providerStatus: {
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "idle",
					reasonCodes: ["no-publication"],
				},
				retainedObservationCount: 0,
			}).success,
		).toBe(true);
	});

	it("accepts only the central positive and unavailable status pairs", () => {
		const base = {
			instanceId: "instance-1",
			instanceName: "Synthetic Sonarr",
			service: "sonarr" as const,
			retainedObservationCount: 0,
		};
		const positive = {
			availability: "partial" as const,
			evidence: "positive-only" as const,
			observedAt: "2026-09-03T12:00:00.000Z",
			ageSeconds: 30,
			latestAttempt: "successful" as const,
			reasonCodes: ["positive-only" as const],
		};
		const unavailable = {
			availability: "unavailable" as const,
			evidence: "unknown" as const,
			observedAt: null,
			ageSeconds: null,
			latestAttempt: "idle" as const,
			reasonCodes: ["no-publication" as const],
		};
		expect(historySourceV2Schema.safeParse({ ...base, providerStatus: positive }).success).toBe(
			true,
		);
		expect(
			historySourceV2Schema.safeParse({
				...base,
				providerStatus: { ...positive, availability: "last-known" },
			}).success,
		).toBe(true);
		expect(historySourceV2Schema.safeParse({ ...base, providerStatus: unavailable }).success).toBe(
			true,
		);
		for (const providerStatus of [
			{ ...positive, availability: "current", evidence: "complete" },
			{ ...positive, evidence: "unknown" },
			{ ...unavailable, evidence: "positive-only", reasonCodes: ["positive-only"] },
		]) {
			expect(historySourceV2Schema.safeParse({ ...base, providerStatus }).success).toBe(false);
		}
	});

	it("rejects unsafe sources, response totals, over-cap items, and incoherent cursors", () => {
		const source = {
			instanceId: "instance-1",
			instanceName: "Synthetic Sonarr",
			service: "sonarr" as const,
			providerStatus: {
				availability: "partial" as const,
				evidence: "positive-only" as const,
				observedAt: "2026-09-03T12:00:00.000Z",
				ageSeconds: 0,
				latestAttempt: "successful" as const,
				reasonCodes: ["positive-only" as const],
			},
			retainedObservationCount: 1,
		};
		const item = {
			id: "observation-1",
			instanceId: "instance-1",
			instanceName: "Synthetic Sonarr",
			service: "sonarr" as const,
			providerEventId: 42,
			eventAt: "2026-09-03T12:00:00.000Z",
			eventType: "grabbed",
		};
		expect(historySourceV2Schema.safeParse(source).success).toBe(true);
		expect(
			historySourceV2Schema.safeParse({
				...source,
				providerStatus: {
					...source.providerStatus,
					availability: "current",
					evidence: "complete",
					reasonCodes: [],
				},
			}).success,
		).toBe(false);
		expect(
			historyPageInfoV2Schema.safeParse({
				nextCursor: null,
				hasNextPage: true,
				matchingObservedCount: 0,
			}).success,
		).toBe(false);
		expect(
			historyPageInfoV2Schema.safeParse({
				nextCursor: "",
				hasNextPage: false,
				matchingObservedCount: 0,
			}).success,
		).toBe(false);
		expect(
			historyResponseV2Schema.safeParse({
				version: 2,
				items: [],
				sources: [],
				pageInfo: { nextCursor: null, hasNextPage: false, matchingObservedCount: 0 },
				totalCount: 0,
			}).success,
		).toBe(false);
		expect(
			historyResponseV2Schema.safeParse({
				version: 2,
				items: Array.from({ length: HISTORY_PAGE_MAX_ITEMS + 1 }, () => item),
				sources: [],
				pageInfo: { nextCursor: null, hasNextPage: false, matchingObservedCount: 0 },
			}).success,
		).toBe(false);
		expect(
			historyResponseV2Schema.safeParse({
				version: 2,
				items: [],
				sources: Array.from({ length: HISTORY_SOURCE_MAX_COUNT + 1 }, () => source),
				pageInfo: { nextCursor: null, hasNextPage: false, matchingObservedCount: 0 },
			}).success,
		).toBe(false);
		expect(
			historyResponseV2Schema.safeParse({
				version: 2,
				items: [],
				sources: [],
				pageInfo: { nextCursor: null, hasNextPage: false, matchingObservedCount: 0 },
				totalRecords: 1,
			}).success,
		).toBe(false);
	});

	it("keeps the legacy contained fixture parseable", () => {
		expect(
			multiInstanceHistoryResponseSchema.safeParse({
				instances: [
					{
						instanceId: "legacy-instance",
						instanceName: "Legacy Sonarr",
						service: "sonarr",
						data: [
							{
								id: 1,
								instanceId: "legacy-instance",
								instanceName: "Legacy Sonarr",
								service: "sonarr",
								title: "Legacy",
							},
						],
					},
				],
				aggregated: [
					{
						id: 1,
						instanceId: "legacy-instance",
						instanceName: "Legacy Sonarr",
						service: "sonarr",
						title: "Legacy",
					},
				],
				totalCount: 1,
			}).success,
		).toBe(true);
	});
});
