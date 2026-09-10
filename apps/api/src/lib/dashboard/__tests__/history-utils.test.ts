import {
	HISTORY_CUSTOM_FORMAT_MAX_COUNT,
	HISTORY_DISPLAY_TEXT_MAX_LENGTH,
	HISTORY_IDENTIFIER_TEXT_MAX_LENGTH,
	HISTORY_NORMALIZED_JSON_MAX_BYTES,
	HISTORY_SEARCH_TEXT_MAX_LENGTH,
} from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	buildHistorySearchText,
	decodeHistoryNormalizedPayload,
	normalizeHistoryObservation,
} from "../history-utils.js";

const date = "2026-09-03T12:34:56-05:00";

const inputs = {
	sonarr: {
		id: 1,
		date,
		eventType: " Downloaded ",
		title: "Synthetic Episode",
		sourceTitle: "synthetic.episode.1080p",
		size: 100,
		quality: { quality: { name: "WEB-DL" } },
		downloadId: "download-sonarr",
		series: { id: 10, title: "Synthetic Series", titleSlug: "synthetic-series" },
		episode: { id: 20 },
		customFormats: [
			{ id: 2, name: "HDR" },
			{ id: 1, name: "Preferred" },
		],
		customFormatScore: -2,
		downloadClient: "qbit",
		indexer: "synthetic-indexer",
		protocol: "torrent",
	},
	radarr: {
		id: 2,
		date,
		eventType: "Grabbed",
		movie: { id: 30, title: "Synthetic Movie", titleSlug: "synthetic-movie" },
		sourceTitle: "synthetic.movie.2160p",
	},
	prowlarr: {
		id: 3,
		date,
		eventType: "Indexer Search",
		indexerId: 40,
		data: {
			releaseTitle: "Synthetic Release",
			indexer: "Synthetic Indexer",
			host: "https://private.example.invalid",
			error: "provider-secret-error",
			reason: "private-reason",
		},
	},
	lidarr: {
		id: 4,
		date,
		eventType: "Imported",
		artist: { id: 50, artistName: "Synthetic Artist" },
		album: { id: 60, title: "Synthetic Album" },
		track: { id: 70 },
	},
	readarr: {
		id: 5,
		date,
		eventType: "Book Grabbed",
		author: { id: 80, authorName: "Synthetic Author" },
		book: { id: 90, title: "Synthetic Book" },
	},
} as const;

describe("normalizeHistoryObservation", () => {
	it.each([
		["sonarr", inputs.sonarr, { seriesId: 10, seriesSlug: "synthetic-series", episodeId: 20 }],
		["radarr", inputs.radarr, { movieId: 30, movieSlug: "synthetic-movie" }],
		["prowlarr", inputs.prowlarr, { indexerId: 40 }],
		["lidarr", inputs.lidarr, { artistId: 50, albumId: 60, trackId: 70 }],
		["readarr", inputs.readarr, { authorId: 80, bookId: 90 }],
	] as const)(
		"normalizes useful %s observations to a strict branch",
		(service, input, specific) => {
			const result = normalizeHistoryObservation(input, service);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.observation.payload).toMatchObject({
				version: 1,
				service,
				providerEventId: input.id,
				eventAt: "2026-09-03T17:34:56.000Z",
				eventType: input.eventType.trim().toLowerCase(),
				...specific,
			});
			expect(result.observation.normalizedPayload).toBe(JSON.stringify(result.observation.payload));
			expect(result.observation.searchText).toContain(result.observation.payload.eventType);
			expect(result.observation.searchText.length).toBeLessThanOrEqual(
				HISTORY_SEARCH_TEXT_MAX_LENGTH,
			);
		},
	);

	it("rejects missing, aliased, unsafe, or non-object required fields", () => {
		for (const input of [
			undefined,
			null,
			[],
			{ date, eventType: "grabbed" },
			{ id: "1", date, eventType: "grabbed" },
			{ id: -1, date, eventType: "grabbed" },
			{ id: 1.5, date, eventType: "grabbed" },
			{ eventId: 1, date, eventType: "grabbed" },
			{ id: 1, eventDate: date, eventType: "grabbed" },
			{ id: 1, date, status: "grabbed" },
			{ id: 1, date, event: "grabbed" },
			{ id: 1, date, eventType: " " },
			{ id: 1, date, eventType: "https://sentinel.invalid" },
			{ id: 1, date, eventType: "x".repeat(129) },
			{ id: 1, date: "invalid-date", eventType: "grabbed" },
			{ id: 1, date: "2026-09-03T12:00:00.000Z".repeat(3), eventType: "grabbed" },
			{ id: 1, date: "2026-09-03T12:00:00.000Z\n", eventType: "grabbed" },
		]) {
			expect(normalizeHistoryObservation(input, "sonarr")).toEqual({ ok: false });
		}
	});

	it("excludes raw provider/private fields and unknown sentinel values", () => {
		const result = normalizeHistoryObservation(
			{
				...inputs.prowlarr,
				sentinel: "discard-me",
				language: "en",
				url: "https://sentinel.invalid/url",
				link: "https://sentinel.invalid/link",
				message: "sentinel-message",
				error: "sentinel-error",
				reason: "sentinel-reason",
				credentials: { token: "sentinel-token" },
			},
			"prowlarr",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.observation.normalizedPayload).not.toContain("sentinel");
		expect(result.observation.searchText).not.toContain("sentinel");
		expect(result.observation.payload).not.toHaveProperty("data");
		expect(result.observation.payload).not.toHaveProperty("host");
	});

	it("does not coerce invalid optional values and derives known nested values", () => {
		const result = normalizeHistoryObservation(
			{
				...inputs.sonarr,
				title: "safe https://sentinel.invalid/embedded",
				sourceTitle: { value: "not text" },
				size: "100",
				downloadClient: "client www.sentinel.invalid/client",
				protocol: { name: "torrent" },
				indexer: "prefix magnet:?xt=sentinel",
				seriesSlug: "https://sentinel.invalid/slug",
				seriesId: "10",
				series: { id: 10, title: "Nested Title" },
			},
			"sonarr",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.observation.payload).not.toHaveProperty("size");
		expect(result.observation.payload).not.toHaveProperty("sourceTitle");
		expect(result.observation.payload).not.toHaveProperty("downloadClient");
		expect(result.observation.payload).not.toHaveProperty("protocol");
		expect(result.observation.payload).not.toHaveProperty("indexer");
		expect(result.observation.payload).not.toHaveProperty("seriesSlug");
		expect(result.observation.payload.service).toBe("sonarr");
		expect(result.observation.payload.title).toBe("Nested Title");
		if (result.observation.payload.service === "sonarr") {
			expect(result.observation.payload.seriesId).toBe(10);
		}
		expect(result.observation.payload.title).toBe("Nested Title");
	});

	it("filters, deduplicates, sorts, bounds, and truncates accepted values", () => {
		const result = normalizeHistoryObservation(
			{
				...inputs.sonarr,
				title: "T".repeat(HISTORY_DISPLAY_TEXT_MAX_LENGTH + 100),
				downloadId: "D".repeat(HISTORY_IDENTIFIER_TEXT_MAX_LENGTH + 1),
				seriesSlug: "S".repeat(HISTORY_IDENTIFIER_TEXT_MAX_LENGTH + 1),
				series: { id: 10, title: "Synthetic Series" },
				customFormats: [
					{ id: 2, name: "B" },
					{ id: 1, name: "Z" },
					{ id: 1, name: "Z" },
					{ id: -1, name: "bad" },
					{ id: "3", name: "bad" },
					...Array.from({ length: HISTORY_CUSTOM_FORMAT_MAX_COUNT + 2 }, (_, id) => ({
						id: id + 10,
						name: `format-${id}`,
					})),
				],
			},
			"sonarr",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.observation.payload.title).toHaveLength(HISTORY_DISPLAY_TEXT_MAX_LENGTH);
		expect(result.observation.payload).not.toHaveProperty("downloadId");
		expect(result.observation.payload).not.toHaveProperty("seriesSlug");
		expect(result.observation.payload.customFormats).toEqual(
			result.observation.payload.customFormats
				?.slice()
				.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name)),
		);
		expect(result.observation.payload.customFormats?.length).toBeLessThanOrEqual(
			HISTORY_CUSTOM_FORMAT_MAX_COUNT,
		);
	});

	it("rejects an oversized normalized payload", () => {
		expect(
			normalizeHistoryObservation(
				{
					id: 1,
					date,
					eventType: "grabbed",
					customFormats: Array.from({ length: HISTORY_CUSTOM_FORMAT_MAX_COUNT }, (_, id) => ({
						id,
						name: `${id}-${"x".repeat(HISTORY_DISPLAY_TEXT_MAX_LENGTH - 10)}`,
					})),
				},
				"sonarr",
			),
		).toEqual({ ok: false });
		expect(
			new TextEncoder().encode(
				JSON.stringify(
					Array.from({ length: HISTORY_CUSTOM_FORMAT_MAX_COUNT }, () =>
						"x".repeat(HISTORY_DISPLAY_TEXT_MAX_LENGTH),
					),
				),
			).byteLength,
		).toBeGreaterThan(HISTORY_NORMALIZED_JSON_MAX_BYTES);
	});

	it("is byte-identical for repeated semantic inputs", () => {
		const left = normalizeHistoryObservation(inputs.sonarr, "sonarr");
		const right = normalizeHistoryObservation({ ...inputs.sonarr }, "sonarr");
		expect(left).toEqual(right);
	});
});

describe("decodeHistoryNormalizedPayload", () => {
	it("exports the canonical search projection used by normalized observations", () => {
		const normalized = normalizeHistoryObservation(inputs.sonarr, "sonarr");
		expect(normalized.ok).toBe(true);
		if (!normalized.ok) return;
		expect(buildHistorySearchText(normalized.observation.payload)).toBe(
			normalized.observation.searchText,
		);
	});

	it("round-trips normalized payloads", () => {
		const normalized = normalizeHistoryObservation(inputs.radarr, "radarr");
		expect(normalized.ok).toBe(true);
		if (!normalized.ok) return;
		expect(decodeHistoryNormalizedPayload(normalized.observation.normalizedPayload)).toEqual({
			ok: true,
			payload: normalized.observation.payload,
		});
	});

	it("returns only a generic failure for malformed, noncanonical, extra-keyed, and oversized input", () => {
		const valid = normalizeHistoryObservation(inputs.radarr, "radarr");
		expect(valid.ok).toBe(true);
		if (!valid.ok) return;
		const payload = JSON.parse(valid.observation.normalizedPayload) as Record<string, unknown>;
		for (const candidate of [
			"not-json",
			JSON.stringify([]),
			JSON.stringify({ ...payload, data: { sentinel: "discard-me" } }),
			JSON.stringify({ ...payload, eventAt: date }),
			JSON.stringify({
				eventType: payload.eventType,
				version: 1,
				providerEventId: payload.providerEventId,
				eventAt: payload.eventAt,
				service: payload.service,
			}),
			`"${"x".repeat(HISTORY_NORMALIZED_JSON_MAX_BYTES)}"`,
		]) {
			expect(decodeHistoryNormalizedPayload(candidate)).toEqual({ ok: false });
		}
	});
});
