/**
 * Pins the tolerant boundary behaviour of the Tracearr response schemas.
 *
 * The single most important case: Tracearr's OpenAPI spec DRIFTS from its
 * runtime. Verified live against supervised-v1.4.28, `GET /stats/today`
 * returns `todaySessions` (absent from the published spec) and omits
 * `timestamp` (marked required in the spec). A schema authored strictly
 * from the spec would 502 on the real response; a schema authored strictly
 * from the runtime would reject a future release that restored `timestamp`.
 * These tests lock in that BOTH shapes validate.
 *
 * The per-item schemas (Stream/SessionHistory) are also pinned as tolerant:
 * media-server data is structurally partial, so a movie session with none
 * of the episode/music fields must still parse.
 */

import { describe, expect, it } from "vitest";
import {
	tracearrHealthSchema,
	tracearrHistoryResponseSchema,
	tracearrStatsTodaySchema,
	tracearrStreamSchema,
	tracearrStreamsResponseSchema,
} from "../tracearr.js";

describe("tracearrHealthSchema", () => {
	it("parses the live health payload (empty servers)", () => {
		const live = {
			status: "ok",
			version: "v1.4.28",
			timestamp: "2026-07-01T14:50:28.536Z",
			servers: [],
		};
		expect(tracearrHealthSchema.parse(live)).toEqual(live);
	});

	it("degrades an unknown server type instead of throwing", () => {
		const parsed = tracearrHealthSchema.parse({
			status: "ok",
			version: "v1",
			timestamp: "t",
			servers: [{ id: "a", name: "X", type: "kodi", online: true, activeStreams: 0 }],
		});
		// `.catch("plex")` keeps the row usable rather than failing the whole response.
		expect(parsed.servers[0]?.type).toBe("plex");
	});
});

describe("tracearrStatsTodaySchema — spec-vs-runtime drift", () => {
	it("parses the RUNTIME shape (todaySessions present, timestamp absent)", () => {
		const runtime = {
			activeStreams: 0,
			todayPlays: 0,
			todaySessions: 0,
			watchTimeHours: 0,
			alertsLast24h: 0,
			activeUsersToday: 0,
		};
		const parsed = tracearrStatsTodaySchema.parse(runtime);
		expect(parsed.todaySessions).toBe(0);
		expect(parsed.timestamp).toBeUndefined();
	});

	it("parses the SPEC shape (timestamp present, todaySessions absent)", () => {
		const spec = {
			activeStreams: 1,
			todayPlays: 2,
			watchTimeHours: 1.5,
			alertsLast24h: 0,
			activeUsersToday: 1,
			timestamp: "2026-07-01T00:00:00.000Z",
		};
		const parsed = tracearrStatsTodaySchema.parse(spec);
		expect(parsed.timestamp).toBe("2026-07-01T00:00:00.000Z");
		expect(parsed.todaySessions).toBeUndefined();
	});
});

describe("tracearrStreamsResponseSchema", () => {
	it("parses the live empty envelope and keeps totalBitrate as a string", () => {
		const live = {
			data: [],
			summary: {
				total: 0,
				transcodes: 0,
				directStreams: 0,
				directPlays: 0,
				totalBitrate: "—",
				byServer: [],
			},
		};
		const parsed = tracearrStreamsResponseSchema.parse(live);
		// totalBitrate is a pre-formatted STRING, never coerced to a number.
		expect(parsed.summary.totalBitrate).toBe("—");
	});
});

describe("tracearrStreamSchema — partial media data", () => {
	it("parses a movie session that omits episode/music fields", () => {
		const movie = {
			id: "s1",
			username: "alice",
			mediaTitle: "Blade Runner 2049",
			mediaType: "movie",
			state: "playing",
			year: 2017,
		};
		const parsed = tracearrStreamSchema.parse(movie);
		expect(parsed.id).toBe("s1");
		expect(parsed.mediaType).toBe("movie");
		expect(parsed.seasonNumber).toBeUndefined();
	});

	it("degrades an unknown mediaType to 'unknown'", () => {
		const parsed = tracearrStreamSchema.parse({ id: "s2", mediaType: "hologram" });
		expect(parsed.mediaType).toBe("unknown");
	});

	it("strips unknown top-level keys rather than rejecting them", () => {
		const parsed = tracearrStreamSchema.parse({ id: "s3", brandNewFieldFromV2: 42 });
		expect(parsed.id).toBe("s3");
		expect("brandNewFieldFromV2" in parsed).toBe(false);
	});
});

describe("tracearrHistoryResponseSchema", () => {
	it("parses the live empty paginated envelope", () => {
		const live = { data: [], meta: { total: 0, page: 1, pageSize: 25 } };
		expect(tracearrHistoryResponseSchema.parse(live)).toEqual(live);
	});
});
