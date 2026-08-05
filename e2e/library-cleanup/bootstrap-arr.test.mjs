import assert from "node:assert/strict";
import test from "node:test";

import {
	ARR_FIXTURES,
	assertHarnessServiceUrl,
	assertUniqueProjectName,
	buildMovieAddBody,
	buildPlexNotificationPayload,
	buildPlaceholderBuffer,
	buildSeriesAddBody,
	fileRecordMatches,
	isPathWithinRoot,
	MOVIE,
	SERIES,
	validateCredentials,
} from "./bootstrap-arr.mjs";

test("project guard accepts only unique disposable harness names", () => {
	assert.equal(assertUniqueProjectName("lc-e2e-616-20260804"), "lc-e2e-616-20260804");
	for (const rejected of [
		"arr-dashboard",
		"lc-e2e-test-20260804",
		"lc-e2e-production-20260804",
		"lc-e2e-run",
	]) {
		assert.throws(() => assertUniqueProjectName(rejected));
	}
});

test("service URLs are restricted to exact isolated Compose endpoints", () => {
	assert.equal(assertHarnessServiceUrl("http://radarr-a:7878", "radarr-a"), "http://radarr-a:7878");
	for (const rejected of [
		"http://localhost:7878",
		"http://192.168.0.185:7878",
		"https://radarr-a:7878",
		"http://user:secret@radarr-a:7878",
	]) {
		assert.throws(() => assertHarnessServiceUrl(rejected, "radarr-a"));
	}
});

test("credential input requires the exact four-service key set", () => {
	const credentials = {
		RADARR_A_KEY: "a".repeat(32),
		RADARR_B_KEY: "b".repeat(32),
		SONARR_A_KEY: "c".repeat(32),
		SONARR_B_KEY: "d".repeat(32),
	};
	assert.equal(validateCredentials(credentials), credentials);
	assert.throws(() => validateCredentials({ ...credentials, EXTRA_KEY: "e".repeat(32) }));
	assert.throws(() => validateCredentials({ ...credentials, SONARR_B_KEY: "bad key" }));
	const missing = { ...credentials };
	delete missing.RADARR_A_KEY;
	assert.throws(() => validateCredentials(missing));
});

test("known IDs are added without triggering searches", () => {
	assert.deepEqual(
		buildMovieAddBody(
			1,
			"/radarr-a/data/library/radarr-a",
			"/radarr-a/data/library/radarr-a/The Matrix (1999)",
		),
		{
			title: "The Matrix",
			year: 1999,
			tmdbId: 603,
			qualityProfileId: 1,
			rootFolderPath: "/radarr-a/data/library/radarr-a",
			path: "/radarr-a/data/library/radarr-a/The Matrix (1999)",
			monitored: true,
			minimumAvailability: "released",
			addOptions: { searchForMovie: false },
		},
	);
	assert.deepEqual(
		buildSeriesAddBody(
			2,
			"/sonarr-a/data/library/sonarr-a",
			"/sonarr-a/data/library/sonarr-a/Breaking Bad",
		),
		{
			title: "Breaking Bad",
			year: 2008,
			tvdbId: 81189,
			qualityProfileId: 2,
			rootFolderPath: "/sonarr-a/data/library/sonarr-a",
			path: "/sonarr-a/data/library/sonarr-a/Breaking Bad",
			monitored: true,
			seasonFolder: true,
			addOptions: { searchForMissingEpisodes: false },
		},
	);
	assert.equal(MOVIE.tmdbId, 603);
	assert.equal(SERIES.tvdbId, 81189);
});

test("fixtures use distinct exact roots and torrent sources on the shared volume", () => {
	assert.equal(ARR_FIXTURES.length, 4);
	assert.equal(new Set(ARR_FIXTURES.map((fixture) => fixture.rootFolderPath)).size, 4);
	assert.equal(new Set(ARR_FIXTURES.map((fixture) => fixture.sourcePath)).size, 4);
	for (const fixture of ARR_FIXTURES) {
		assert.equal(isPathWithinRoot(fixture.rootFolderPath, fixture.mountRoot), true);
		assert.equal(isPathWithinRoot(fixture.sourcePath, fixture.mountRoot), true);
		assert.match(fixture.sourcePath, /\/torrents\/(?:radarr|sonarr)-[ab]\//);
		assert.match(fixture.plexRootPath, /^\/plex\/data\/library\/(?:radarr|sonarr)-[ab]$/);
		assert.match(fixture.fileName, /\.mkv$/);
		assert.match(fixture.legacySha256, /^[a-f0-9]{64}$/);
	}
});

test("Plex notifications carry exact per-instance path mappings and delete events", () => {
	const schema = {
		implementation: "PlexServer",
		implementationName: "Plex Media Server",
		configContract: "PlexServerSettings",
		fields: [
			"host",
			"port",
			"useSsl",
			"urlBase",
			"authToken",
			"updateLibrary",
			"mapFrom",
			"mapTo",
		].map((name) => ({ name })),
	};
	const radarr = buildPlexNotificationPayload(schema, ARR_FIXTURES[0]);
	const sonarr = buildPlexNotificationPayload(schema, ARR_FIXTURES[2]);
	const values = (payload) => Object.fromEntries(payload.fields.map((field) => [field.name, field.value]));
	assert.deepEqual(values(radarr), {
		host: "plex",
		port: 33240,
		useSsl: false,
		urlBase: "",
		authToken: "lc-e2e-local",
		updateLibrary: true,
		mapFrom: "/radarr-a/data/library/radarr-a",
		mapTo: "/plex/data/library/radarr-a",
	});
	assert.equal(radarr.onMovieDelete, true);
	assert.equal(radarr.onMovieFileDelete, true);
	assert.equal(sonarr.onSeriesDelete, true);
	assert.equal(sonarr.onEpisodeFileDelete, true);
	assert.throws(() => buildPlexNotificationPayload({ ...schema, fields: [] }, ARR_FIXTURES[0]));
});

test("placeholder media has a Matroska header and unique per-instance content", () => {
	const buffers = ARR_FIXTURES.map((fixture) => buildPlaceholderBuffer(fixture));
	assert.equal(new Set(buffers.map((buffer) => buffer.toString("base64"))).size, 4);
	for (const buffer of buffers) {
		assert.equal(buffer.subarray(0, 4).toString("hex"), "1a45dfa3");
		assert.ok(buffer.length > 1_000 && buffer.length < 4_096);
		assert.match(buffer.toString("utf8", buffer.length - 128), /ARR-DASHBOARD-LIBRARY-CLEANUP-E2E/);
	}
});

test("file record verification accepts only the expected absolute or relative path", () => {
	const itemPath = "/sonarr-a/data/library/sonarr-a/Breaking Bad";
	const expectedPath = `${itemPath}/Season 01/Breaking.Bad.S01E01.1080p.mkv`;
	assert.equal(fileRecordMatches({ path: expectedPath }, itemPath, expectedPath), true);
	assert.equal(
		fileRecordMatches(
			{ relativePath: "Season 01/Breaking.Bad.S01E01.1080p.mkv" },
			itemPath,
			expectedPath,
		),
		true,
	);
	assert.equal(
		fileRecordMatches(
			{ relativePath: "Season 02/Breaking.Bad.S01E01.1080p.mkv" },
			itemPath,
			expectedPath,
		),
		false,
	);
});
