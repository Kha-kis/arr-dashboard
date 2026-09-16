import { describe, expect, it } from "vitest";
import {
	createArrConnectionIndex,
	resolveArrConnection,
	type InventoryExternalIds,
} from "../inventory-connections.js";

const movie = (instanceId = "radarr", arrItemId = 1, remoteIds = { tmdbId: 42 }) => ({
	instanceId,
	arrItemId,
	itemType: "movie" as const,
	title: "Same title",
	data: JSON.stringify({ remoteIds }),
});
const resolve = (
	rows = [movie()],
	externalIds: InventoryExternalIds = { tmdb: [42] },
	mediaType = "movie",
) => resolveArrConnection({ mediaType, externalIds }, createArrConnectionIndex(rows));

describe("provider inventory connections", () => {
	it("links a provider object to the exact ARR instance and record", () => {
		expect(resolve()).toMatchObject({
			status: "matched",
			arrItems: [{ instanceId: "radarr", arrItemId: 1 }],
		});
	});
	it("keeps an unmapped native object unknown instead of matching its title", () => {
		expect(resolve([movie()], {})).toMatchObject({
			status: "unknown",
			reason: "missing-identifiers",
			arrItems: [],
		});
	});
	it("reports a known identifier without an ARR counterpart as unmatched", () => {
		expect(resolve([movie()], { tmdb: [99] })).toMatchObject({
			status: "unmatched",
			reason: "no-arr-match",
		});
	});
	it("does not join a series to a movie with the same numeric external ID", () => {
		expect(resolve([movie()], { tmdb: [42] }, "series").status).toBe("unmatched");
	});
	it("preserves both ARR instances and requires an explicit target to disambiguate", () => {
		const index = createArrConnectionIndex([movie(), movie("radarr-4k")]);
		expect(
			resolveArrConnection({ mediaType: "movie", externalIds: { tmdb: [42] } }, index),
		).toMatchObject({
			status: "ambiguous",
			arrItems: [{ instanceId: "radarr" }, { instanceId: "radarr-4k" }],
		});
		expect(
			resolveArrConnection({ mediaType: "movie", externalIds: { tmdb: [42] } }, index, "radarr-4k"),
		).toMatchObject({
			status: "matched",
			arrItems: [{ instanceId: "radarr-4k" }],
		});
	});
	it("rejects conflicting external identifiers even if one identifier agrees", () => {
		const index = createArrConnectionIndex([
			{ ...movie(), data: JSON.stringify({ remoteIds: { tmdbId: 42, tvdbId: 12 } }) },
		]);
		expect(
			resolveArrConnection({ mediaType: "movie", externalIds: { tmdb: [42], tvdb: [13] } }, index),
		).toMatchObject({
			status: "ambiguous",
			reason: "conflicting-identifiers",
		});
	});
	it("does not arbitrarily select one of several provider identifiers", () => {
		expect(resolve([movie()], { tmdb: [42, 99] })).toMatchObject({
			status: "ambiguous",
			reason: "conflicting-identifiers",
		});
	});
	it("matches fresh ARR API identities at the execution boundary", () => {
		expect(resolve([{ ...movie(), data: JSON.stringify({ tmdbId: 42 }) }]).status).toBe("matched");
	});
	it("does not hide contradictory nested and top-level ARR identifiers", () => {
		expect(
			resolve([{ ...movie(), data: JSON.stringify({ tmdbId: 99, remoteIds: { tmdbId: 42 } }) }])
				.status,
		).toBe("ambiguous");
	});
	it("does not authorize an ARR record with contradictory IDs in another identifier family", () => {
		expect(
			resolve([
				{ ...movie(), data: JSON.stringify({ tmdbId: 42, tvdbId: 10, remoteIds: { tvdbId: 11 } }) },
			]).status,
		).toBe("ambiguous");
	});
	it("rejects malformed external IDs instead of coercing them", () => {
		expect(resolve([movie()], { tmdb: [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1] }).status).toBe(
			"unknown",
		);
	});
});
