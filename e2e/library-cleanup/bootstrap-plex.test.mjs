import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	assertHarnessPlexUrl,
	buildLibraryQuery,
	PLEX_LIBRARIES,
	parseSections,
} from "./bootstrap-plex.mjs";

test("loopback Plex history fixture has one stable nonempty history key", () => {
	const compose = readFileSync(new URL("./compose.yml", import.meta.url), "utf8");
	const historyFixture = compose.match(
		/if \(requestUrl\.pathname === "\/status\/sessions\/history\/all"\) \{([\s\S]*?)\n          \}/,
	)?.[1];

	assert.ok(historyFixture, "loopback Plex history fixture must be present");
	const historyKeys = [...historyFixture.matchAll(/historyKey:\s*"([^"]+)"/g)].map(
		([, historyKey]) => historyKey,
	);
	assert.deepEqual(historyKeys, ["lc-e2e-plex-history-pilot-17"]);
});

test("Plex URL stays on the exact isolated loopback bridge", () => {
	assert.equal(assertHarnessPlexUrl("http://plex:33240"), "http://plex:33240");
	for (const rejected of [
		"http://plex:32400",
		"http://127.0.0.1:33240",
		"https://plex:33240",
		"http://user:token@plex:33240",
	]) {
		assert.throws(() => assertHarnessPlexUrl(rejected));
	}
});

test("library creation preserves both exact roots", () => {
	const query = buildLibraryQuery(PLEX_LIBRARIES[0]);
	assert.deepEqual(query.getAll("location"), [
		"/plex/data/library/radarr-a",
		"/plex/data/library/radarr-b",
	]);
	assert.equal(query.get("type"), "movie");
});

test("section parser keeps keys, types, and all locations", () => {
	const sections = parseSections(
		`<?xml version="1.0"?><MediaContainer><Directory key="1" type="movie" title="Library Cleanup Movies"><Location id="1" path="/plex/data/library/radarr-a"/><Location id="2" path="/plex/data/library/radarr-b"/></Directory></MediaContainer>`,
	);
	assert.deepEqual(sections, [
		{
			key: "1",
			title: "Library Cleanup Movies",
			type: "movie",
			locations: ["/plex/data/library/radarr-a", "/plex/data/library/radarr-b"],
		},
	]);
});
