import { describe, expect, it } from "vitest";
import { arrPolicyEvidenceFromRaw } from "./arr-policy-evidence.js";

describe("arrPolicyEvidenceFromRaw", () => {
	it.each([
		{
			service: "radarr",
			raw: { monitored: false, hasFile: false, sizeOnDisk: 0 },
		},
		{
			service: "radarr",
			raw: { monitored: true, hasFile: true, sizeOnDisk: 1024 },
		},
		{
			service: "sonarr",
			raw: { monitored: false, statistics: { episodeFileCount: 0, sizeOnDisk: 0 } },
		},
		{
			service: "sonarr",
			raw: { monitored: true, statistics: { episodeFileCount: 3, sizeOnDisk: 1024 } },
		},
	])(
		"accepts explicit positive and zero/false $service fields as known evidence",
		({ service, raw }) => {
			expect(arrPolicyEvidenceFromRaw(raw, service)).toEqual({
				monitored: true,
				hasFile: true,
				sizeOnDisk: true,
				rating: false,
				imdbRating: false,
			});
		},
	);

	it.each(["radarr", "sonarr"])(
		"does not treat normalized defaults as authoritative for %s",
		(service) => {
			expect(arrPolicyEvidenceFromRaw({}, service)).toEqual({
				monitored: false,
				hasFile: false,
				sizeOnDisk: false,
				rating: false,
				imdbRating: false,
			});
		},
	);

	it("rejects malformed numeric availability fields", () => {
		expect(
			arrPolicyEvidenceFromRaw(
				{ monitored: true, statistics: { episodeFileCount: -1, sizeOnDisk: 1.5 } },
				"sonarr",
			),
		).toEqual({
			monitored: true,
			hasFile: false,
			sizeOnDisk: false,
			rating: false,
			imdbRating: false,
		});
	});

	it("distinguishes complete missing/zero ratings from malformed rating evidence", () => {
		expect(arrPolicyEvidenceFromRaw({ ratings: {} }, "radarr")).toMatchObject({
			rating: true,
			imdbRating: true,
		});
		expect(
			arrPolicyEvidenceFromRaw({ ratings: { tmdb: { value: 0 }, imdb: { value: 10 } } }, "radarr"),
		).toMatchObject({ rating: true, imdbRating: true });
		expect(
			arrPolicyEvidenceFromRaw(
				{ ratings: { tmdb: { value: Number.NaN }, imdb: { value: 11 } } },
				"radarr",
			),
		).toMatchObject({ rating: false, imdbRating: false });
		expect(arrPolicyEvidenceFromRaw({ ratings: { value: 0 } }, "sonarr")).toMatchObject({
			rating: true,
			imdbRating: false,
		});
	});
});
