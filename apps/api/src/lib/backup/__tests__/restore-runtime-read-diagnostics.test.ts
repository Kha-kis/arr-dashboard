import { describe, expect, it } from "vitest";
import {
	classifyRuntimeReadRoute,
	getRuntimeReadSource,
	withRuntimeReadSource,
	type RuntimeReadSource,
} from "../restore-runtime-read-diagnostics.js";

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("fixed runtime read sources", () => {
	it.each([
		["/api/library/provider-inventory", "primary-inventory"],
		["/library/provider-inventory", "primary-inventory"],
		["/api/library/poster/:instanceId/:itemType/:itemId", "library-poster"],
		["/api/library", "arr-library"],
		["/api/library/episodes", "arr-library"],
		["/api/plex/sections/", "plex-sections"],
		["/api/plex/watch-enrichment", "plex-watch"],
		["/api/jellyfin/watch-enrichment/", "jellyfin-watch"],
		["/api/plex/series-progress", "plex-series"],
		["/api/jellyfin/series-progress", "jellyfin-series"],
		["/api/plex/on-deck", "plex-on-deck"],
		["/api/jellyfin/on-deck", "jellyfin-on-deck"],
		["/api/plex/recently-added", "plex-recent"],
		["/api/jellyfin/recently-added", "jellyfin-recent"],
		["/api/pulse/signals", "pulse"],
		["/api/dashboard/statistics", "dashboard"],
		["/api/qui/torrents", "qui"],
		["/api/seerr/requests", "seerr"],
		["/api/private-user/plex/sections", "other-http"],
		["/api/plex/sections-private-token", "other-http"],
		["/api/plex/watch-enrichment?token=private", "other-http"],
		["https://private.invalid/api/plex/sections", "other-http"],
		["/api/api/plex/sections", "other-http"],
		["/unknown/:privateIdentity", "other-http"],
		["", "other-http"],
	])("classifies only fixed server route families: %s", (route, expected) => {
		expect(classifyRuntimeReadRoute(route)).toBe(expected);
	});

	it("preserves exact return, rejection, thrown objects and safe invalid-label fallback", async () => {
		const value = {},
			sentinel = new Error("synthetic outcome"),
			promise = Promise.resolve(value);
		expect(withRuntimeReadSource("pulse", () => value)).toBe(value);
		expect(withRuntimeReadSource("pulse", () => promise)).toBe(promise);
		expect(() =>
			withRuntimeReadSource("pulse", () => {
				throw sentinel;
			}),
		).toThrow(sentinel);
		const rejected = Promise.reject(sentinel);
		expect(withRuntimeReadSource("pulse", () => rejected)).toBe(rejected);
		await expect(rejected).rejects.toBe(sentinel);
		for (const invalid of ["private arbitrary label", "__proto__", null, {}, undefined]) {
			expect(withRuntimeReadSource(invalid as RuntimeReadSource, getRuntimeReadSource)).toBe(
				"unscoped",
			);
		}
		expect(getRuntimeReadSource()).toBe("unscoped");
	});

	it("isolates concurrent nested and late children while restoring each parent", async () => {
		const release = signal(),
			started = [signal(), signal()];
		const children = (["plex-watch", "jellyfin-series"] as const).map((source, i) =>
			withRuntimeReadSource(source, async () => {
				expect(getRuntimeReadSource()).toBe(source);
				withRuntimeReadSource("library-poster", () =>
					expect(getRuntimeReadSource()).toBe("library-poster"),
				);
				expect(getRuntimeReadSource()).toBe(source);
				started[i]!.resolve();
				await release.promise;
				expect(getRuntimeReadSource()).toBe(source);
			}),
		);
		await Promise.all(started.map((s) => s.promise));
		expect(getRuntimeReadSource()).toBe("unscoped");
		release.resolve();
		await Promise.all(children);
		expect(getRuntimeReadSource()).toBe("unscoped");
	});
});
