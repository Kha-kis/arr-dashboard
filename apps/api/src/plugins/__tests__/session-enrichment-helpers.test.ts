import { describe, expect, it } from "vitest";
import {
	normalizeJellyfinMediaType,
	normalizePlexMediaType,
	type PlexSessionInput,
	toEnrichedSessions,
} from "../lib/session-enrichment-helpers.js";

function session(overrides: Partial<PlexSessionInput> = {}): PlexSessionInput {
	return {
		user: { title: "alice" },
		title: "Dune",
		ratingKey: "rk-1",
		state: "playing",
		videoDecision: "directplay",
		audioDecision: "directplay",
		bandwidth: 12000,
		player: { title: "Living Room TV", platform: "Roku" },
		...overrides,
	};
}

describe("toEnrichedSessions", () => {
	it("sources platform/player/audioDecision from the Plex session natively", () => {
		const [enriched] = toEnrichedSessions([session()]);

		expect(enriched).toMatchObject({
			user: "alice",
			title: "Dune",
			platform: "Roku",
			player: "Living Room TV",
			audioDecision: "directplay",
			videoDecision: "directplay",
			bandwidth: 12000,
			state: "playing",
		});
	});

	it("leaves codec/resolution fields null pending the Tracearr-era rewrite (ADR-0007)", () => {
		const [enriched] = toEnrichedSessions([session()]);

		expect(enriched?.videoCodec).toBeNull();
		expect(enriched?.audioCodec).toBeNull();
		expect(enriched?.videoResolution).toBeNull();
	});

	it("tolerates sessions with no player block", () => {
		const [enriched] = toEnrichedSessions([session({ player: null, audioDecision: null })]);

		expect(enriched?.platform).toBeNull();
		expect(enriched?.player).toBeNull();
		expect(enriched?.audioDecision).toBeNull();
	});

	it("formats grandparentTitle as 'Show - Episode' and normalizes media type", () => {
		const [enriched] = toEnrichedSessions([
			session({ title: "Part One", grandparentTitle: "Dune: Prophecy", type: "episode" }),
		]);

		expect(enriched?.title).toBe("Dune: Prophecy - Part One");
		expect(enriched?.grandparentTitle).toBe("Dune: Prophecy");
		expect(enriched?.mediaType).toBe("series");
	});

	it("defaults missing bandwidth to 0", () => {
		const [enriched] = toEnrichedSessions([session({ bandwidth: null })]);
		expect(enriched?.bandwidth).toBe(0);
	});
});

describe("media type normalization", () => {
	it("maps Plex types", () => {
		expect(normalizePlexMediaType("movie")).toBe("movie");
		expect(normalizePlexMediaType("episode")).toBe("series");
		expect(normalizePlexMediaType("track")).toBe("music");
		expect(normalizePlexMediaType("photo")).toBe("other");
		expect(normalizePlexMediaType(undefined)).toBe("other");
	});

	it("maps Jellyfin types", () => {
		expect(normalizeJellyfinMediaType("Movie")).toBe("movie");
		expect(normalizeJellyfinMediaType("Episode")).toBe("series");
		expect(normalizeJellyfinMediaType("Audio")).toBe("music");
		expect(normalizeJellyfinMediaType("Photo")).toBe("other");
	});
});
