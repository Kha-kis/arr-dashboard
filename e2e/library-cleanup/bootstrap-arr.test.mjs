import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	ARR_FIXTURES,
	assertHarnessServiceUrl,
	assertUniqueProjectName,
	bootstrapFixture,
	buildFixtureRemoval,
	buildMovieAddBody,
	buildPlaceholderBuffer,
	buildPlexNotificationPayload,
	buildSeriesAddBody,
	classifyFixtureEpisodeAssociation,
	classifyFixtureFileState,
	fileRecordMatches,
	fixtureLibraryPath,
	isMissingPlexLibraryValidation,
	isPathWithinRoot,
	isRepeatedFixtureResetState,
	MOVIE,
	parseFilesystemComposeCommand,
	plexNotificationSaveEndpoint,
	SERIES,
	validateCredentials,
} from "./bootstrap-arr.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

test("filesystem command parsing accepts only the configured Docker executable", () => {
	const configuredDocker = "/opt/docker wrappers/docker";
	assert.deepEqual(
		parseFilesystemComposeCommand([configuredDocker, "compose"], configuredDocker),
		[configuredDocker, "compose"],
	);
	assert.throws(
		() => parseFilesystemComposeCommand(["docker", "compose"], configuredDocker),
		/resolved Docker Compose command/,
	);
});

test("filesystem bootstrap executes the resolved Docker Compose command vector", async (t) => {
	const tempDir = await mkdtemp(path.join(tmpdir(), "lc-e2e-bootstrap-arr-command-"));
	t.after(() => rm(tempDir, { recursive: true, force: true }));
	const composeLog = path.join(tempDir, "compose.log");
	const wrapperDir = path.join(tempDir, "docker wrappers");
	const fakeDocker = path.join(wrapperDir, "docker");
	await mkdir(wrapperDir);
	await writeFile(
		fakeDocker,
		`#!/bin/sh
{
	printf '%s\\n' "$@"
	printf '%s\\n' --
} >>"$ARR_COMPOSE_LOG"
`,
	);
	await chmod(fakeDocker, 0o755);
	const defaultDockerEnv = { ...process.env };
	delete defaultDockerEnv.ARR_DOCKER_BIN;
	delete defaultDockerEnv.ARR_COMPOSE_BIN;

	const result = spawnSync(
		process.execPath,
		[path.join(SCRIPT_DIR, "bootstrap-arr.mjs"), "--filesystem-only", "docker", "compose"],
		{
			encoding: "utf8",
			env: {
				...defaultDockerEnv,
				ARR_COMPOSE_LOG: composeLog,
				COMPOSE_PROJECT_NAME: "lc-e2e-690-20260810",
				FIXTURE_PUID: "1000",
				FIXTURE_PGID: "1000",
				PATH: `${wrapperDir}${path.delimiter}${process.env.PATH}`,
			},
		},
	);
	assert.equal(result.status, 0, result.stderr);

	const configuredResult = spawnSync(
		process.execPath,
		[path.join(SCRIPT_DIR, "bootstrap-arr.mjs"), "--filesystem-only", fakeDocker, "compose"],
		{
			encoding: "utf8",
			env: {
				...defaultDockerEnv,
				ARR_COMPOSE_LOG: composeLog,
				ARR_DOCKER_BIN: fakeDocker,
				COMPOSE_PROJECT_NAME: "lc-e2e-690-20260810",
				FIXTURE_PUID: "1000",
				FIXTURE_PGID: "1000",
			},
		},
	);
	assert.equal(configuredResult.status, 0, configuredResult.stderr);

	const invocations = (await readFile(composeLog, "utf8"))
		.trim()
		.split("--\n")
		.filter(Boolean)
		.map((invocation) => invocation.trim().split("\n"));
	assert.equal(invocations.length, ARR_FIXTURES.length * 4);
	for (const invocation of invocations) {
		assert.deepEqual(invocation.slice(0, 3), ["compose", "-p", "lc-e2e-690-20260810"]);
		const shellIndex = invocation.lastIndexOf("sh");
		assert.equal(invocation[shellIndex + 1], "-eu");
		assert.equal(invocation[shellIndex + 2], "-c");
	}
});

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
	const values = (payload) =>
		Object.fromEntries(payload.fields.map((field) => [field.name, field.value]));
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

test("Plex notification bootstrap explicitly defers library validation", () => {
	assert.equal(plexNotificationSaveEndpoint(undefined), "/api/v3/notification?forceSave=true");
	assert.equal(plexNotificationSaveEndpoint({ id: 19 }), "/api/v3/notification/19?forceSave=true");
	assert.throws(() => plexNotificationSaveEndpoint({ id: "19" }), /invalid identity/);
});

test("only the exact missing Plex library validation is deferrable", () => {
	assert.equal(
		isMissingPlexLibraryValidation(
			new Error("POST failed with HTTP 400: At least one Movie library is required"),
			"movie",
		),
		true,
	);
	assert.equal(
		isMissingPlexLibraryValidation(
			new Error("POST failed with HTTP 400: Authentication Token is invalid"),
			"movie",
		),
		false,
	);
	assert.equal(
		isMissingPlexLibraryValidation(
			new Error("POST failed with HTTP 400: At least one Movie library is required"),
			"series",
		),
		false,
	);
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
	assert.equal(
		fileRecordMatches(
			{
				path: `${itemPath}/Season 02/Breaking.Bad.S01E01.1080p.mkv`,
				relativePath: "Season 01/Breaking.Bad.S01E01.1080p.mkv",
			},
			itemPath,
			expectedPath,
		),
		false,
	);
});

test("fixture state reuses only one exact freshly associated ARR file", () => {
	const fixture = ARR_FIXTURES[0];
	const libraryPath = fixtureLibraryPath(fixture);
	const record = { id: 41, movieId: 7, path: libraryPath, size: 1_024 };
	assert.deepEqual(
		classifyFixtureFileState({
			fixture,
			item: { id: 7, path: fixture.itemPath },
			records: [record],
			associatedFileId: 41,
		}),
		{ kind: "ready", record },
	);
});

test("fixture state treats import transitions between separate reads as transient", () => {
	const fixture = ARR_FIXTURES[2];
	const libraryPath = fixtureLibraryPath(fixture);
	const item = { id: 9, path: fixture.itemPath };
	assert.deepEqual(
		classifyFixtureFileState({ fixture, item, records: [], associatedFileId: null }),
		{ kind: "absent" },
	);
	assert.deepEqual(
		classifyFixtureFileState({
			fixture,
			item,
			records: [{ id: 12, seriesId: 9, path: libraryPath, size: 512 }],
			associatedFileId: null,
		}),
		{ kind: "transient", reason: "association-behind", recordIds: [12] },
	);
	assert.deepEqual(
		classifyFixtureFileState({
			fixture,
			item,
			records: [],
			associatedFileId: 12,
		}),
		{ kind: "transient", reason: "association-ahead", recordIds: [] },
	);
	assert.deepEqual(
		classifyFixtureFileState({
			fixture,
			item,
			records: [{ id: 12, seriesId: 9, path: libraryPath, size: 512 }],
			associatedFileId: 13,
		}),
		{ kind: "transient", reason: "association-mismatch", recordIds: [12] },
	);

	assert.deepEqual(
		classifyFixtureFileState({
			fixture,
			item,
			records: [
				{ id: 14, seriesId: 9, path: libraryPath, size: 512 },
				{ id: 13, seriesId: 9, relativePath: `Season 01/${fixture.fileName}`, size: 512 },
			],
			associatedFileId: 14,
		}),
		{ kind: "reset", reason: "duplicate", recordIds: [13, 14] },
	);
});

test("Sonarr episode creation is pending until exactly one valid S01E01 exists", () => {
	assert.deepEqual(classifyFixtureEpisodeAssociation([], 9), { kind: "pending" });
	assert.deepEqual(
		classifyFixtureEpisodeAssociation(
			[{ id: 4, seriesId: 9, seasonNumber: 1, episodeNumber: 1, hasFile: false }],
			9,
		),
		{ kind: "ready", fileId: null },
	);
	assert.throws(
		() =>
			classifyFixtureEpisodeAssociation(
				[
					{ id: 4, seriesId: 9, seasonNumber: 1, episodeNumber: 1, hasFile: false },
					{ id: 5, seriesId: 9, seasonNumber: 1, episodeNumber: 1, hasFile: false },
				],
				9,
			),
		/duplicate S01E01/,
	);
});

test("fixture reset authorization requires identical duplicate snapshots", () => {
	const duplicate = { kind: "reset", reason: "duplicate", recordIds: [13, 14] };
	assert.equal(isRepeatedFixtureResetState(duplicate, duplicate), true);
	assert.equal(
		isRepeatedFixtureResetState(duplicate, {
			kind: "reset",
			reason: "duplicate",
			recordIds: [13, 15],
		}),
		false,
	);
	assert.equal(
		isRepeatedFixtureResetState(duplicate, {
			kind: "transient",
			reason: "association-behind",
			recordIds: [13, 14],
		}),
		false,
	);
	assert.equal(isRepeatedFixtureResetState(duplicate, { kind: "ready", record: {} }), false);
});

test("duplicate ARR reset deletes bodylessly, verifies absence, recreates one row, and retains the file", async (t) => {
	const tempDir = await mkdtemp(path.join(tmpdir(), "lc-e2e-duplicate-reset-"));
	t.after(() => rm(tempDir, { recursive: true, force: true }));
	const fixture = {
		...ARR_FIXTURES[0],
		rootFolderPath: path.join(tempDir, "root"),
		itemPath: path.join(tempDir, "library", "The Matrix (1999)"),
		sourcePath: path.join(tempDir, "torrents", "The.Matrix.1999.1080p.BluRay.x264-LCE2E.mkv"),
	};
	const libraryPath = fixtureLibraryPath(fixture);
	const fixtureContent = buildPlaceholderBuffer(fixture);
	await mkdir(path.dirname(libraryPath), { recursive: true });
	await writeFile(libraryPath, fixtureContent);

	const oldMovie = {
		id: 7,
		tmdbId: MOVIE.tmdbId,
		path: fixture.itemPath,
		hasFile: true,
		movieFile: { id: 14 },
	};
	const recreatedMovie = {
		id: 8,
		tmdbId: MOVIE.tmdbId,
		path: fixture.itemPath,
		hasFile: true,
		movieFile: { id: 22 },
	};
	const duplicateRecords = [
		{ id: 13, movieId: oldMovie.id, path: libraryPath, size: fixtureContent.length },
		{ id: 14, movieId: oldMovie.id, path: libraryPath, size: fixtureContent.length },
	];
	const calls = [];
	let deleted = false;
	let recreated = false;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		calls.push({ method, path: `${url.pathname}${url.search}`, body: init.body });
		const json = (value) => new Response(JSON.stringify(value), { status: 200 });
		if (url.pathname === "/api/v3/system/status") return json({ version: "5.0" });
		if (url.pathname === "/api/v3/rootfolder") {
			return method === "POST"
				? json({ path: fixture.rootFolderPath, accessible: true })
				: json([]);
		}
		if (url.pathname === "/api/v3/notification/schema") {
			return json([
				{
					implementation: "PlexServer",
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
				},
			]);
		}
		if (url.pathname === "/api/v3/notification") {
			if (method === "GET") return json([]);
			return json({ ...JSON.parse(init.body), id: 1 });
		}
		if (url.pathname === "/api/v3/qualityprofile") return json([{ id: 1 }]);
		if (url.pathname === "/api/v3/moviefile") {
			return json(
				recreated
					? [{ id: 22, movieId: recreatedMovie.id, path: libraryPath, size: fixtureContent.length }]
					: duplicateRecords,
			);
		}
		if (url.pathname === "/api/v3/movie/7") {
			if (method === "DELETE") {
				deleted = true;
				return new Response(null, { status: 200 });
			}
			return json(oldMovie);
		}
		if (url.pathname === "/api/v3/movie/8") return json(recreatedMovie);
		if (url.pathname === "/api/v3/movie") {
			if (method === "POST") {
				recreated = true;
				return json(recreatedMovie);
			}
			if (!deleted) return json([oldMovie]);
			return json(recreated ? [recreatedMovie] : []);
		}
		throw new Error(`unexpected request ${method} ${url.pathname}${url.search}`);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	await bootstrapFixture(fixture, "a".repeat(32));

	const deletion = calls.find((call) => call.method === "DELETE");
	assert.deepEqual(deletion, {
		method: "DELETE",
		path: "/api/v3/movie/7?deleteFiles=false&addImportExclusion=false",
		body: undefined,
	});
	const deletionIndex = calls.indexOf(deletion);
	assert.deepEqual(calls[deletionIndex + 1], {
		method: "GET",
		path: "/api/v3/movie",
		body: undefined,
	});
	assert.equal(calls[deletionIndex + 2].method, "GET");
	assert.deepEqual(calls[deletionIndex + 4], {
		method: "POST",
		path: "/api/v3/movie",
		body: JSON.stringify(buildMovieAddBody(1, fixture.rootFolderPath, fixture.itemPath)),
	});
	assert.equal(calls.filter((call) => call.path === "/api/v3/moviefile?movieId=7").length, 3);
	assert.deepEqual(
		calls.filter((call) => call.path === "/api/v3/moviefile?movieId=8"),
		[{ method: "GET", path: "/api/v3/moviefile?movieId=8", body: undefined }],
	);
	assert.deepEqual(await readFile(libraryPath), fixtureContent);
});

test("fixture state fails closed for foreign paths or malformed rows", () => {
	const fixture = ARR_FIXTURES[0];
	const libraryPath = fixtureLibraryPath(fixture);
	const item = { id: 7, path: fixture.itemPath };
	assert.throws(
		() =>
			classifyFixtureFileState({
				fixture,
				item,
				records: [{ id: 41, movieId: 7, path: `${fixture.itemPath}/foreign.mkv`, size: 1 }],
				associatedFileId: null,
			}),
		/foreign file path/,
	);
	assert.throws(
		() =>
			classifyFixtureFileState({
				fixture,
				item,
				records: [{ id: "41", movieId: 7, path: libraryPath, size: 1 }],
				associatedFileId: null,
			}),
		/invalid file identity/,
	);
});

test("fixture removal always preserves files and disables exclusion side effects", () => {
	assert.deepEqual(buildFixtureRemoval(ARR_FIXTURES[0], { id: 7 }), {
		endpoint: "/api/v3/movie/7?deleteFiles=false&addImportExclusion=false",
		method: "DELETE",
	});
	assert.deepEqual(buildFixtureRemoval(ARR_FIXTURES[2], { id: 9 }), {
		endpoint: "/api/v3/series/9?deleteFiles=false&addImportListExclusion=false",
		method: "DELETE",
	});
	assert.throws(() => buildFixtureRemoval(ARR_FIXTURES[0], { id: "7" }), /invalid item identity/);
});
