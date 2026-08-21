import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createEvidenceFingerprintArrayAccumulator,
	evidenceFingerprint,
} from "../evidence-fingerprint.js";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

describe("evidence fingerprint", () => {
	it("hashes canonical evidence without changing JSON text values", () => {
		const value = {
			z: null,
			when: new Date("2026-08-20T12:00:00.000Z"),
			collections: '[{"name":"Keep this text"}]',
			nested: { b: 2, a: 1 },
		};

		expect(evidenceFingerprint(value)).toBe(
			sha256(
				'{"collections":"[{\\"name\\":\\"Keep this text\\"}]","nested":{"a":1,"b":2},"when":"2026-08-20T12:00:00.000Z","z":null}',
			),
		);
	});

	it("matches materialized canonical array hashes across empty and multiple batches", () => {
		const rows = [
			{ z: null, b: 2, a: 1, when: new Date("2026-08-20T12:00:00.000Z") },
			{ labels: '["do-not-parse"]', a: { d: 4, c: 3 } },
		];
		const accumulator = createEvidenceFingerprintArrayAccumulator();
		for (const batch of [rows.slice(0, 1), rows.slice(1)]) {
			for (const row of batch) accumulator.append(row);
		}

		const canonicalArray =
			'[{"a":1,"b":2,"when":"2026-08-20T12:00:00.000Z","z":null},{"a":{"c":3,"d":4},"labels":"[\\"do-not-parse\\"]"}]';
		expect(createEvidenceFingerprintArrayAccumulator().digest()).toBe(sha256("[]"));
		expect(evidenceFingerprint([])).toBe(sha256("[]"));
		expect(accumulator.digest()).toBe(sha256(canonicalArray));
		expect(accumulator.digest()).toBe(evidenceFingerprint(rows));
	});

	it("preserves the main-compatible policy-row fingerprint across instances and pages", () => {
		const rows = [
			{
				id: "a-1",
				instanceId: "plex-a",
				tmdbId: 1,
				mediaType: "movie",
				sectionId: "movies",
				sectionTitle: "Movies",
				lastWatchedAt: null,
				watchCount: 0,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: '["A"]',
				labels: "[]",
				addedAt: new Date("2026-08-20T12:00:00.000Z"),
				connectionGeneration: 4,
				identityGeneration: 9,
			},
			{
				id: "b-1",
				instanceId: "plex-b",
				tmdbId: 2,
				mediaType: "series",
				sectionId: "shows",
				sectionTitle: "Shows",
				lastWatchedAt: new Date("2026-08-20T13:00:00.000Z"),
				watchCount: 3,
				watchedByUsers: '["alice"]',
				onDeck: true,
				userRating: 8.5,
				collections: "[]",
				labels: '["keep"]',
				addedAt: null,
				connectionGeneration: 4,
				identityGeneration: 9,
			},
		];
		const streamed = createEvidenceFingerprintArrayAccumulator();
		for (const page of [rows.slice(0, 1), rows.slice(1)]) {
			for (const row of page) streamed.append(row);
		}

		expect(streamed.digest()).toBe(evidenceFingerprint(rows));
	});
});
