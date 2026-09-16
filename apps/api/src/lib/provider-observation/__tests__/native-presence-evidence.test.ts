import { describe, expect, it } from "vitest";
import {
	createNativePresenceEvidence,
	resolveNativePresence,
} from "../native-presence-evidence.js";

const target = {
	instanceId: "radarr",
	arrItemId: 1,
	itemType: "movie" as const,
	title: "Fixture",
	data: JSON.stringify({ remoteIds: { tmdbId: 42 } }),
};
const row = {
	nativeId: "native",
	mediaType: "movie" as const,
	libraryIds: ["movies"],
	parentNativeId: null,
	seasonNumber: null,
	episodeNumber: null,
	title: "Fixture",
	externalIds: { tmdb: [42] },
};
const evidence = (rows = [row]) =>
	createNativePresenceEvidence("owner", "plex", "generation", rows);

describe("positive native presence for an explicitly selected ARR target", () => {
	it("uses a native ID match without requiring a watch cache", () => {
		expect(resolveNativePresence(target, evidence())).toBe("present");
	});
	it("keeps missing provider evidence unknown", () => {
		expect(resolveNativePresence(target, undefined)).toBe("provider-unavailable");
	});
	it("does not interpret missing matches as proven absence", () => {
		expect(resolveNativePresence(target, evidence([]))).toBe("no-verified-match");
	});
	it("rejects ambiguous provider editions rather than selecting the first", () => {
		expect(resolveNativePresence(target, evidence([row, { ...row, nativeId: "other" }]))).toBe(
			"ambiguous-match",
		);
	});
	it("reevaluates the current ARR identifiers instead of a cached match", () => {
		expect(
			resolveNativePresence(
				{ ...target, data: JSON.stringify({ remoteIds: { tmdbId: 99 } }) },
				evidence(),
			),
		).toBe("no-verified-match");
	});
	it("rejects conflicting metadata even when one ID matches", () => {
		expect(
			resolveNativePresence(target, evidence([{ ...row, externalIds: { tmdb: [42, 99] } }])),
		).toBe("ambiguous-match");
	});
});
