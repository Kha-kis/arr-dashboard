#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILES = [
	path.join(SCRIPT_DIR, "compose.yml"),
	path.join(SCRIPT_DIR, "compose.debug.yml"),
];
const REQUEST_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;
const FILE_RECORD_TIMEOUT_MS = 45_000;

// A deterministic 16x16 FFV1 + FLAC Matroska stream with an 11-minute duration.
// It is intentionally tiny, but includes the video and audio tracks required by
// current ARR import validation. A fixture-specific marker gives every file a
// distinct content hash without changing the Matroska streams.
const MKV_PLACEHOLDER_BASE64 = [
	"GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAAEPhFNm3TAv4RxKyGHTbuLU6uEFUmpZlOs",
	"gaFNu4tTq4QWVK5rU6yB8U27jFOrhBJUw2dTrIIB9U27jFOrhBxTu2tTrIIEIuwBAAAAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAA",
	"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsu/hIECyV8q",
	"17GDD0JATYCNTGF2ZjYwLjE2LjEwMFdBjUxhdmY2MC4xNi4xMDBzpJDkNBP3ae+DP0soMwr9Hr96RImIQSQsEAAAAAAWVK5rQP6/",
	"hDJgWrauAQAAAAAAAHzXgQFzxYhjQzFGtACfyJyBACK1nIN1bmSIgQCDgQEj44OEO5rKAIaPVl9NUy9WRlcvRk9VUkND4ImwgRC6",
	"gRCagQJV7oEA7AEAAAAAAAACAABjoqgoAAAAEAAAABAAAAABABgARkZWMQADAAAAAAAAAAAAAAAAAAAAAAAArgEAAAAAAABq14EC",
	"c8WIH8liEvAhg0qcgQAitZyDdW5kiIEAhoZBX0ZMQUODgQLhkZ+BAbWIQL9AAAAAAABiZIEQVe6BAGOiqmZMYUOAAAAiAkACQAAA",
	"CwAACwH0APAAAB9AHuAZNnFgnH1jz+ibkgrTExJUw2dA17+E74YkD3NzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjAuMTYuMTAw",
	"c3PUY8CLY8WIY0MxRrQAn8hnyJ9Fo4dFTkNPREVSRIeSTGF2YzYwLjMxLjEwMiBmZnYxZ8ihRaOIRFVSQVRJT05Eh5MwMDoxMTow",
	"MS4wMDAwMDAwMDAAc3PUY8CLY8WIH8liEvAhg0pnyJ9Fo4dFTkNPREVSRIeSTGF2YzYwLjMxLjEwMiBmbGFjZ8ihRaOIRFVSQVRJ",
	"T05Eh5MwMDowMDowMS4wMDAwMDAwMDAAH0O2dUEjv4TefC2p54EAo6qBAACA9MdXMano6XcQAXxw/aIIa7VqbQDSv/5////4AD0l",
	"fP//n7/v//ijj4IAAID/+CQIAMoAAADOdqOPggBIgP/4JAgBzQAAAKIOo4+CAJCA//gkCALEAAAAFoajj4IA2ID/+CQIA8MAAAB6",
	"/qOPggEggP/4JAgE1gAAAP+To4+CAWiA//gkCAXRAAAAk+ujj4IBsID/+CQIBtgAAAAnY6OPggH4gP/4JAgH3wAAAEsbo4+CAkCA",
	"//gkCAjyAAAArbyjj4ICiID/+CQICfUAAADBxKOPggLQgP/4JAgK/AAAAHVMo4+CAxiA//gkCAv7AAAAGTSjj4IDYID/+CQIDO4A",
	"AACcWaOPggOogP/4lAgNAwAAAMMMH0O2daK/hJsnX8jngwoSIKOVgQAAAAA5//7////z6/3//z4////gHFO7a5e/hDGgbfO7j7OB",
	"ALeK94EB8YIC0vCBCQ==",
].join("");

export const MOVIE = Object.freeze({
	title: "The Matrix",
	year: 1999,
	tmdbId: 603,
});

export const SERIES = Object.freeze({
	title: "Breaking Bad",
	year: 2008,
	tvdbId: 81189,
});

export const ARR_FIXTURES = Object.freeze([
	{
		kind: "movie",
		service: "radarr-a",
		baseUrl: "http://radarr-a:7878",
		apiKeyEnv: "RADARR_A_KEY",
		mountRoot: "/radarr-a/data",
		rootFolderPath: "/radarr-a/data/library/radarr-a",
		plexRootPath: "/plex/data/library/radarr-a",
		itemPath: "/radarr-a/data/library/radarr-a/The Matrix (1999)",
		sourcePath: "/radarr-a/data/torrents/radarr-a/The.Matrix.1999.1080p.BluRay.x264-LCE2E.mkv",
		fileName: "The.Matrix.1999.1080p.BluRay.x264-LCE2E.mkv",
		quality: "1080p",
		legacySha256: "ef336dac8124d271c209dd18e2e848d641a662544f9c5bed99f56a5dc7d05b49",
	},
	{
		kind: "movie",
		service: "radarr-b",
		baseUrl: "http://radarr-b:7878",
		apiKeyEnv: "RADARR_B_KEY",
		mountRoot: "/radarr-b/data",
		rootFolderPath: "/radarr-b/data/library/radarr-b",
		plexRootPath: "/plex/data/library/radarr-b",
		itemPath: "/radarr-b/data/library/radarr-b/The Matrix (1999)",
		sourcePath: "/radarr-b/data/torrents/radarr-b/The.Matrix.1999.2160p.UHD.BluRay.x265-LCE2E.mkv",
		fileName: "The.Matrix.1999.2160p.UHD.BluRay.x265-LCE2E.mkv",
		quality: "2160p",
		legacySha256: "20d81e2cf76326618a2503e7ec0ddf179032adacc0ce4e44010f8c840f1651ea",
	},
	{
		kind: "series",
		service: "sonarr-a",
		baseUrl: "http://sonarr-a:8989",
		apiKeyEnv: "SONARR_A_KEY",
		mountRoot: "/sonarr-a/data",
		rootFolderPath: "/sonarr-a/data/library/sonarr-a",
		plexRootPath: "/plex/data/library/sonarr-a",
		itemPath: "/sonarr-a/data/library/sonarr-a/Breaking Bad",
		sourcePath: "/sonarr-a/data/torrents/sonarr-a/Breaking.Bad.S01E01.1080p.BluRay.x264-LCE2E.mkv",
		fileName: "Breaking.Bad.S01E01.1080p.BluRay.x264-LCE2E.mkv",
		quality: "1080p",
		legacySha256: "dc0c0ec342b38d734b268d171cbcf604e48aff4879b02861c3b2ee250a4ea108",
	},
	{
		kind: "series",
		service: "sonarr-b",
		baseUrl: "http://sonarr-b:8989",
		apiKeyEnv: "SONARR_B_KEY",
		mountRoot: "/sonarr-b/data",
		rootFolderPath: "/sonarr-b/data/library/sonarr-b",
		plexRootPath: "/plex/data/library/sonarr-b",
		itemPath: "/sonarr-b/data/library/sonarr-b/Breaking Bad",
		sourcePath:
			"/sonarr-b/data/torrents/sonarr-b/Breaking.Bad.S01E01.2160p.UHD.BluRay.x265-LCE2E.mkv",
		fileName: "Breaking.Bad.S01E01.2160p.UHD.BluRay.x265-LCE2E.mkv",
		quality: "2160p",
		legacySha256: "ade7b27ae345804a2a08aa69d867fb17dae12302fb37b362c853413e1c7f0b3e",
	},
]);

export function assertUniqueProjectName(projectName) {
	if (!/^lc-e2e-[a-z0-9][a-z0-9-]{0,31}$/.test(projectName)) {
		throw new Error("COMPOSE_PROJECT_NAME is not a Library Cleanup harness project");
	}
	const parts = projectName.slice("lc-e2e-".length).split("-");
	const generic = new Set(["default", "demo", "dev", "local", "shared", "test"]);
	if (
		projectName.length < 16 ||
		!/[0-9]/.test(projectName) ||
		parts.some(
			(part) =>
				generic.has(part) || ["main", "prod", "stable"].some((prefix) => part.startsWith(prefix)),
		)
	) {
		throw new Error("COMPOSE_PROJECT_NAME is not unique and disposable");
	}
	return projectName;
}

export function assertHarnessServiceUrl(value, service) {
	const url = new URL(value);
	const expectedPort = service.startsWith("radarr-") ? "7878" : "8989";
	if (
		url.protocol !== "http:" ||
		url.hostname !== service ||
		url.port !== expectedPort ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error(`${service} must use its exact uncredentialed harness-network endpoint`);
	}
	return url.origin;
}

export function buildMovieAddBody(qualityProfileId, rootFolderPath, itemPath) {
	return {
		title: MOVIE.title,
		year: MOVIE.year,
		tmdbId: MOVIE.tmdbId,
		qualityProfileId,
		rootFolderPath,
		path: itemPath,
		monitored: true,
		minimumAvailability: "released",
		addOptions: { searchForMovie: false },
	};
}

export function buildSeriesAddBody(qualityProfileId, rootFolderPath, itemPath) {
	return {
		title: SERIES.title,
		year: SERIES.year,
		tvdbId: SERIES.tvdbId,
		qualityProfileId,
		rootFolderPath,
		path: itemPath,
		monitored: true,
		seasonFolder: true,
		addOptions: { searchForMissingEpisodes: false },
	};
}

export function buildPlexNotificationPayload(schema, fixture) {
	if (
		!schema ||
		typeof schema !== "object" ||
		schema.implementation !== "PlexServer" ||
		!Array.isArray(schema.fields)
	) {
		throw new Error(`${fixture.service} returned an invalid Plex notification schema`);
	}
	const values = {
		host: "plex",
		port: 33240,
		useSsl: false,
		urlBase: "",
		authToken: "lc-e2e-local",
		updateLibrary: true,
		mapFrom: fixture.rootFolderPath,
		mapTo: fixture.plexRootPath,
	};
	for (const name of Object.keys(values)) {
		if (!schema.fields.some((field) => field?.name === name)) {
			throw new Error(`${fixture.service} Plex schema is missing ${name}`);
		}
	}
	const eventFields =
		fixture.kind === "movie"
			? {
					onMovieDelete: true,
					onMovieFileDelete: true,
					onMovieFileDeleteForUpgrade: true,
				}
			: {
					onSeriesDelete: true,
					onEpisodeFileDelete: true,
					onEpisodeFileDeleteForUpgrade: true,
				};
	return {
		...schema,
		...eventFields,
		name: "Library Cleanup Plex",
		fields: schema.fields.map((field) =>
			Object.hasOwn(values, field.name) ? { ...field, value: values[field.name] } : field,
		),
		tags: [],
	};
}

export function isPathWithinRoot(candidate, root) {
	return candidate === root || candidate.startsWith(`${root}/`);
}

export function fileRecordMatches(record, itemPath, expectedPath) {
	if (!record || typeof record !== "object") return false;
	if (record.path === expectedPath) return true;
	const expectedRelative = path.posix.relative(itemPath, expectedPath);
	return record.relativePath === expectedRelative;
}

export function fixtureLibraryPath(fixture) {
	return fixture.kind === "movie"
		? path.posix.join(fixture.itemPath, fixture.fileName)
		: path.posix.join(fixture.itemPath, "Season 01", fixture.fileName);
}

export function classifyFixtureFileState({ fixture, item, records, associatedFileId }) {
	if (!Number.isSafeInteger(item?.id) || item.id <= 0 || item.path !== fixture.itemPath) {
		throw new Error(`${fixture.service} has an invalid fixture item identity`);
	}
	if (!Array.isArray(records)) {
		throw new Error(`${fixture.service} returned an invalid ${fixture.kind} file list`);
	}
	if (
		associatedFileId !== null &&
		(!Number.isSafeInteger(associatedFileId) || associatedFileId <= 0)
	) {
		throw new Error(`${fixture.service} returned an invalid parent file association`);
	}

	const expectedPath = fixtureLibraryPath(fixture);
	const parentField = fixture.kind === "movie" ? "movieId" : "seriesId";
	for (const record of records) {
		if (!fileRecordMatches(record, item.path, expectedPath)) {
			throw new Error(`${fixture.service} returned a foreign file path for the controlled fixture`);
		}
		if (!Number.isSafeInteger(record?.id) || record.id <= 0 || record[parentField] !== item.id) {
			throw new Error(
				`${fixture.service} returned an invalid file identity for the controlled fixture`,
			);
		}
	}

	if (records.length === 0) {
		if (associatedFileId !== null) {
			throw new Error(
				`${fixture.service} returned a conflicting file association without a file row`,
			);
		}
		return { kind: "absent" };
	}
	if (records.length > 1) {
		return {
			kind: "reset",
			reason: "duplicate",
			recordIds: records.map((record) => record.id).sort((left, right) => left - right),
		};
	}

	const record = records[0];
	if (associatedFileId === null) {
		return { kind: "reset", reason: "detached", recordIds: [record.id] };
	}
	if (associatedFileId !== record.id) {
		throw new Error(`${fixture.service} returned a conflicting file association`);
	}
	if (!Number.isFinite(Number(record.size)) || Number(record.size) <= 0) {
		return { kind: "pending" };
	}
	return { kind: "ready", record };
}

export function buildFixtureRemoval(fixture, item) {
	if (!Number.isSafeInteger(item?.id) || item.id <= 0) {
		throw new Error(`${fixture.service} has an invalid item identity for fixture removal`);
	}
	return {
		endpoint:
			fixture.kind === "movie"
				? `/api/v3/movie/${item.id}?deleteFiles=false&addImportExclusion=false`
				: `/api/v3/series/${item.id}?deleteFiles=false&addImportListExclusion=false`,
		method: "DELETE",
	};
}

export function buildPlaceholderBuffer(fixture) {
	const marker = [
		"",
		"ARR-DASHBOARD-LIBRARY-CLEANUP-E2E",
		`${fixture.service}:${fixture.kind}:${fixture.quality}`,
		fixture.kind === "movie" ? `tmdb:${MOVIE.tmdbId}` : `tvdb:${SERIES.tvdbId}:S01E01`,
		"",
	].join("\n");
	return Buffer.concat([
		Buffer.from(MKV_PLACEHOLDER_BASE64, "base64"),
		Buffer.from(marker, "utf8"),
	]);
}

function requireEnvironment(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export function validateCredentials(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("ARR credentials must be a JSON object");
	}
	const expectedNames = new Set(ARR_FIXTURES.map((fixture) => fixture.apiKeyEnv));
	if (
		Object.keys(value).length !== expectedNames.size ||
		Object.keys(value).some((name) => !expectedNames.has(name))
	) {
		throw new Error("ARR credentials do not match the exact fixture service set");
	}
	for (const name of expectedNames) {
		if (!/^[A-Za-z0-9_-]{16,128}$/.test(value[name])) {
			throw new Error(`${name} is missing or malformed`);
		}
	}
	return value;
}

async function requestJson(baseUrl, apiKey, endpoint, init = {}) {
	const response = await fetch(`${baseUrl}${endpoint}`, {
		...init,
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"x-api-key": apiKey,
			...init.headers,
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`${init.method ?? "GET"} ${endpoint} failed with HTTP ${response.status}: ${text.slice(0, 500)}`,
		);
	}
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${init.method ?? "GET"} ${endpoint} returned non-JSON data`);
	}
}

async function waitForService(baseUrl, apiKey, service) {
	const deadline = Date.now() + REQUEST_TIMEOUT_MS;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const status = await requestJson(baseUrl, apiKey, "/api/v3/system/status");
			if (status && typeof status.version === "string") return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(
		`${service} did not become API-ready: ${lastError instanceof Error ? lastError.message : "unknown error"}`,
	);
}

function composeExec(service, variables, script) {
	const projectName = assertUniqueProjectName(requireEnvironment("COMPOSE_PROJECT_NAME"));
	const composeBin = requireEnvironment("ARR_COMPOSE_BIN");
	const args = ["-p", projectName];
	for (const composeFile of COMPOSE_FILES) args.push("-f", composeFile);
	args.push("exec", "-T", "--user", "0");
	for (const [name, value] of Object.entries(variables)) {
		args.push("-e", `${name}=${value}`);
	}
	args.push(service, "sh", "-eu", "-c", script);

	const result = spawnSync(composeBin, args, {
		cwd: SCRIPT_DIR,
		encoding: "utf8",
		env: process.env,
		maxBuffer: 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${service} fixture filesystem setup failed: ${(result.stderr || result.stdout).trim().slice(-1_000)}`,
		);
	}
}

function prepareRootFolder(fixture) {
	composeExec(
		fixture.service,
		{
			FIXTURE_ROOT: fixture.rootFolderPath,
			FIXTURE_UID: requireEnvironment("FIXTURE_PUID"),
			FIXTURE_GID: requireEnvironment("FIXTURE_PGID"),
		},
		`mkdir -p "$FIXTURE_ROOT"
chown "$FIXTURE_UID:$FIXTURE_GID" "$FIXTURE_ROOT"
chmod 0775 "$FIXTURE_ROOT"`,
	);
}

function createHardlinkedFixture(fixture, libraryPath) {
	const contentBuffer = buildPlaceholderBuffer(fixture);
	const expectedSha256 = createHash("sha256").update(contentBuffer).digest("hex");

	composeExec(
		fixture.service,
		{
			FIXTURE_SOURCE: fixture.sourcePath,
			FIXTURE_LIBRARY: libraryPath,
			FIXTURE_BASE64: contentBuffer.toString("base64"),
			FIXTURE_SHA256: expectedSha256,
			FIXTURE_LEGACY_SHA256: fixture.legacySha256,
			FIXTURE_UID: requireEnvironment("FIXTURE_PUID"),
			FIXTURE_GID: requireEnvironment("FIXTURE_PGID"),
		},
		`source_parent=$(dirname "$FIXTURE_SOURCE")
library_parent=$(dirname "$FIXTURE_LIBRARY")
mkdir -p "$source_parent" "$library_parent"
chown "$FIXTURE_UID:$FIXTURE_GID" "$source_parent" "$library_parent"
chmod 0775 "$source_parent" "$library_parent"
replace_legacy=0
if [ -e "$FIXTURE_SOURCE" ]; then
	actual_sha256=$(sha256sum "$FIXTURE_SOURCE" | awk '{print $1}')
	if [ "$actual_sha256" != "$FIXTURE_SHA256" ]; then
		if [ "$actual_sha256" != "$FIXTURE_LEGACY_SHA256" ]; then
			echo "refusing to replace an unexpected source fixture" >&2
			exit 1
		fi
		if [ -e "$FIXTURE_LIBRARY" ] && ! [ "$FIXTURE_SOURCE" -ef "$FIXTURE_LIBRARY" ]; then
			echo "refusing to migrate a library file that is not the expected hardlink" >&2
			exit 1
		fi
		replace_legacy=1
	fi
fi
if [ ! -e "$FIXTURE_SOURCE" ] || [ "$replace_legacy" -eq 1 ]; then
	temporary_source="$FIXTURE_SOURCE.tmp"
	printf '%s' "$FIXTURE_BASE64" | base64 -d >"$temporary_source"
	actual_sha256=$(sha256sum "$temporary_source" | awk '{print $1}')
	if [ "$actual_sha256" != "$FIXTURE_SHA256" ]; then
		echo "fixture checksum verification failed" >&2
		exit 1
	fi
	if [ "$replace_legacy" -eq 1 ]; then
		rm -f "$FIXTURE_LIBRARY"
	fi
	mv "$temporary_source" "$FIXTURE_SOURCE"
fi
if [ -e "$FIXTURE_LIBRARY" ]; then
	if ! [ "$FIXTURE_SOURCE" -ef "$FIXTURE_LIBRARY" ]; then
		echo "refusing to replace a library file that is not the expected hardlink" >&2
		exit 1
	fi
else
	ln "$FIXTURE_SOURCE" "$FIXTURE_LIBRARY"
fi
test "$FIXTURE_SOURCE" -ef "$FIXTURE_LIBRARY"
chown "$FIXTURE_UID:$FIXTURE_GID" "$FIXTURE_SOURCE"
chmod 0664 "$FIXTURE_SOURCE"`,
	);
}

async function ensureRootFolder(baseUrl, apiKey, fixture) {
	const roots = await requestJson(baseUrl, apiKey, "/api/v3/rootfolder");
	if (!Array.isArray(roots))
		throw new Error(`${fixture.service} returned an invalid root-folder list`);
	let root = roots.find((candidate) => candidate.path === fixture.rootFolderPath);
	if (!root) {
		root = await requestJson(baseUrl, apiKey, "/api/v3/rootfolder", {
			method: "POST",
			body: { path: fixture.rootFolderPath },
		});
	}
	if (root?.path !== fixture.rootFolderPath || root.accessible === false) {
		throw new Error(`${fixture.service} did not accept the exact fixture root folder`);
	}
}

async function ensurePlexNotification(baseUrl, apiKey, fixture) {
	const schemas = await requestJson(baseUrl, apiKey, "/api/v3/notification/schema");
	if (!Array.isArray(schemas)) {
		throw new Error(`${fixture.service} returned an invalid notification schema list`);
	}
	const plexSchemas = schemas.filter((schema) => schema.implementation === "PlexServer");
	if (plexSchemas.length !== 1) {
		throw new Error(`${fixture.service} did not return exactly one Plex notification schema`);
	}
	const desired = buildPlexNotificationPayload(plexSchemas[0], fixture);
	const notifications = await requestJson(baseUrl, apiKey, "/api/v3/notification");
	if (!Array.isArray(notifications)) {
		throw new Error(`${fixture.service} returned an invalid notification list`);
	}
	const matching = notifications.filter((notification) => notification.name === desired.name);
	if (matching.length > 1) {
		throw new Error(`${fixture.service} has duplicate Library Cleanup Plex notifications`);
	}
	const current = matching[0];
	const saved = await requestJson(
		baseUrl,
		apiKey,
		current ? `/api/v3/notification/${current.id}` : "/api/v3/notification",
		{
			method: current ? "PUT" : "POST",
			body: current ? { ...desired, id: current.id } : desired,
		},
	);
	if (!Number.isSafeInteger(saved?.id) || saved.implementation !== "PlexServer") {
		throw new Error(`${fixture.service} did not persist the Plex notification`);
	}
	const fieldValues = Object.fromEntries(
		(saved.fields ?? []).map((field) => [field.name, field.value]),
	);
	if (
		fieldValues.host !== "plex" ||
		Number(fieldValues.port) !== 33240 ||
		fieldValues.updateLibrary !== true ||
		fieldValues.mapFrom !== fixture.rootFolderPath ||
		fieldValues.mapTo !== fixture.plexRootPath
	) {
		throw new Error(`${fixture.service} Plex path mapping did not round-trip exactly`);
	}
}

async function firstQualityProfileId(baseUrl, apiKey, service) {
	const profiles = await requestJson(baseUrl, apiKey, "/api/v3/qualityprofile");
	if (!Array.isArray(profiles))
		throw new Error(`${service} returned an invalid quality-profile list`);
	const profile = [...profiles]
		.filter((candidate) => Number.isSafeInteger(candidate.id) && candidate.id > 0)
		.sort((left, right) => left.id - right.id)[0];
	if (!profile) throw new Error(`${service} has no usable quality profile`);
	return profile.id;
}

async function ensureMovie(baseUrl, apiKey, fixture) {
	const movies = await requestJson(baseUrl, apiKey, "/api/v3/movie");
	if (!Array.isArray(movies)) throw new Error(`${fixture.service} returned an invalid movie list`);
	const matching = movies.filter((movie) => movie.tmdbId === MOVIE.tmdbId);
	if (matching.length > 1)
		throw new Error(`${fixture.service} has duplicate TMDb ${MOVIE.tmdbId} movies`);
	let movie = matching[0];
	let created = false;
	if (!movie) {
		const qualityProfileId = await firstQualityProfileId(baseUrl, apiKey, fixture.service);
		await requestJson(baseUrl, apiKey, "/api/v3/movie", {
			method: "POST",
			body: buildMovieAddBody(qualityProfileId, fixture.rootFolderPath, fixture.itemPath),
		});
		const refreshed = await requestJson(baseUrl, apiKey, "/api/v3/movie");
		movie = refreshed.find((candidate) => candidate.tmdbId === MOVIE.tmdbId);
		created = true;
	}
	if (!Number.isSafeInteger(movie?.id) || movie?.path !== fixture.itemPath) {
		throw new Error(`${fixture.service} movie is missing or outside its exact fixture root`);
	}
	return { item: movie, created };
}

async function ensureSeries(baseUrl, apiKey, fixture) {
	const allSeries = await requestJson(baseUrl, apiKey, "/api/v3/series");
	if (!Array.isArray(allSeries))
		throw new Error(`${fixture.service} returned an invalid series list`);
	const matching = allSeries.filter((series) => series.tvdbId === SERIES.tvdbId);
	if (matching.length > 1)
		throw new Error(`${fixture.service} has duplicate TVDb ${SERIES.tvdbId} series`);
	let series = matching[0];
	let created = false;
	if (!series) {
		const qualityProfileId = await firstQualityProfileId(baseUrl, apiKey, fixture.service);
		await requestJson(baseUrl, apiKey, "/api/v3/series", {
			method: "POST",
			body: buildSeriesAddBody(qualityProfileId, fixture.rootFolderPath, fixture.itemPath),
		});
		const refreshed = await requestJson(baseUrl, apiKey, "/api/v3/series");
		series = refreshed.find((candidate) => candidate.tvdbId === SERIES.tvdbId);
		created = true;
	}
	if (!Number.isSafeInteger(series?.id) || series?.path !== fixture.itemPath) {
		throw new Error(`${fixture.service} series is missing or outside its exact fixture root`);
	}
	return { item: series, created };
}

function assertControlledItem(fixture, item) {
	const externalId = fixture.kind === "movie" ? item?.tmdbId : item?.tvdbId;
	const expectedExternalId = fixture.kind === "movie" ? MOVIE.tmdbId : SERIES.tvdbId;
	if (
		!Number.isSafeInteger(item?.id) ||
		item.id <= 0 ||
		item.path !== fixture.itemPath ||
		externalId !== expectedExternalId
	) {
		throw new Error(`${fixture.service} changed the controlled fixture identity`);
	}
	return item;
}

function assertGuardedFixtureFile(fixture) {
	const libraryPath = fixtureLibraryPath(fixture);
	let content;
	try {
		content = readFileSync(libraryPath);
	} catch (error) {
		throw new Error(
			`${fixture.service} guarded fixture file is unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		!content.includes(Buffer.from("ARR-DASHBOARD-LIBRARY-CLEANUP-E2E")) ||
		!content.includes(Buffer.from(`${fixture.service}:${fixture.kind}:${fixture.quality}`))
	) {
		throw new Error(`${fixture.service} refused to normalize an unguarded fixture file`);
	}
}

async function associatedFileId(baseUrl, apiKey, fixture, item) {
	if (fixture.kind === "movie") {
		const current = assertControlledItem(
			fixture,
			await requestJson(baseUrl, apiKey, `/api/v3/movie/${item.id}`),
		);
		if (current.hasFile === false) return null;
		if (current.hasFile !== true || !Number.isSafeInteger(current.movieFile?.id)) {
			throw new Error(`${fixture.service} returned an invalid movie-file association`);
		}
		return current.movieFile.id;
	}

	const episodes = await requestJson(baseUrl, apiKey, `/api/v3/episode?seriesId=${item.id}`);
	if (!Array.isArray(episodes)) {
		throw new Error(`${fixture.service} returned an invalid episode list`);
	}
	const matching = episodes.filter(
		(episode) => episode.seasonNumber === 1 && episode.episodeNumber === 1,
	);
	if (matching.length !== 1) {
		throw new Error(`${fixture.service} did not return exactly one S01E01 fixture episode`);
	}
	const episode = matching[0];
	if (!Number.isSafeInteger(episode?.id) || episode.seriesId !== item.id) {
		throw new Error(`${fixture.service} returned an invalid S01E01 identity`);
	}
	if (episode.hasFile === false) return null;
	if (episode.hasFile !== true || !Number.isSafeInteger(episode.episodeFileId)) {
		throw new Error(`${fixture.service} returned an invalid episode-file association`);
	}
	return episode.episodeFileId;
}

function fixtureFileEndpoint(fixture, item) {
	return fixture.kind === "movie"
		? `/api/v3/moviefile?movieId=${item.id}`
		: `/api/v3/episodefile?seriesId=${item.id}`;
}

async function readFixtureFileState(baseUrl, apiKey, fixture, item) {
	const records = await requestJson(baseUrl, apiKey, fixtureFileEndpoint(fixture, item));
	return classifyFixtureFileState({
		fixture,
		item,
		records,
		associatedFileId: await associatedFileId(baseUrl, apiKey, fixture, item),
	});
}

async function resetControlledFixture(baseUrl, apiKey, fixture, item) {
	assertGuardedFixtureFile(fixture);
	const current = assertControlledItem(
		fixture,
		await requestJson(
			baseUrl,
			apiKey,
			fixture.kind === "movie" ? `/api/v3/movie/${item.id}` : `/api/v3/series/${item.id}`,
		),
	);
	const state = await readFixtureFileState(baseUrl, apiKey, fixture, current);
	if (state.kind === "ready") return false;
	if (state.kind !== "reset") {
		throw new Error(`${fixture.service} refused to reset fixture state ${state.kind}`);
	}

	const removal = buildFixtureRemoval(fixture, current);
	await requestJson(baseUrl, apiKey, removal.endpoint, { method: removal.method });
	assertGuardedFixtureFile(fixture);

	const items = await requestJson(
		baseUrl,
		apiKey,
		fixture.kind === "movie" ? "/api/v3/movie" : "/api/v3/series",
	);
	if (!Array.isArray(items)) {
		throw new Error(`${fixture.service} returned an invalid item list after fixture reset`);
	}
	const expectedExternalId = fixture.kind === "movie" ? MOVIE.tmdbId : SERIES.tvdbId;
	const remaining = items.filter((candidate) =>
		fixture.kind === "movie"
			? candidate.tmdbId === expectedExternalId
			: candidate.tvdbId === expectedExternalId,
	);
	if (remaining.length !== 0) {
		throw new Error(`${fixture.service} did not remove the controlled fixture database entry`);
	}
	return true;
}

async function runRescan(baseUrl, apiKey, fixture, itemId) {
	const commandName = fixture.kind === "movie" ? "RescanMovie" : "RescanSeries";
	const idField = fixture.kind === "movie" ? "movieId" : "seriesId";
	const command = await requestJson(baseUrl, apiKey, "/api/v3/command", {
		method: "POST",
		body: { name: commandName, [idField]: itemId },
	});
	if (!Number.isSafeInteger(command?.id)) {
		throw new Error(`${fixture.service} did not return a command ID for ${commandName}`);
	}

	const deadline = Date.now() + COMMAND_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = await requestJson(baseUrl, apiKey, `/api/v3/command/${command.id}`);
		const status = String(current?.status ?? "").toLowerCase();
		if (status === "completed") return;
		if (["failed", "aborted", "cancelled"].includes(status)) {
			throw new Error(`${fixture.service} ${commandName} ended with status ${status}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`${fixture.service} ${commandName} did not finish in time`);
}

async function waitForFileRecord(baseUrl, apiKey, fixture, item) {
	const deadline = Date.now() + FILE_RECORD_TIMEOUT_MS;
	let lastState = "absent";
	while (Date.now() < deadline) {
		const state = await readFixtureFileState(baseUrl, apiKey, fixture, item);
		lastState = state.kind === "reset" ? state.reason : state.kind;
		if (state.kind === "ready") return state.record;
		if (state.kind === "reset" && state.reason === "duplicate") {
			throw new Error(
				`${fixture.service} still returned duplicate exact fixture rows after normalization: ${state.recordIds.join(", ")}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(
		`${fixture.service} did not create one freshly associated ${fixture.kind} file record (last state: ${lastState})`,
	);
}

async function bootstrapFixture(fixture, apiKey) {
	const baseUrl = assertHarnessServiceUrl(fixture.baseUrl, fixture.service);
	await waitForService(baseUrl, apiKey, fixture.service);
	await ensureRootFolder(baseUrl, apiKey, fixture);
	await ensurePlexNotification(baseUrl, apiKey, fixture);

	let ensured =
		fixture.kind === "movie"
			? await ensureMovie(baseUrl, apiKey, fixture)
			: await ensureSeries(baseUrl, apiKey, fixture);
	let state = await readFixtureFileState(baseUrl, apiKey, fixture, ensured.item);
	if (state.kind === "ready") {
		process.stdout.write(
			`${fixture.service}: ${fixture.quality} ${fixture.kind} fixture ready (item ${ensured.item.id}, file ${state.record.id})\n`,
		);
		return;
	}

	if (state.kind === "reset") {
		const reset = await resetControlledFixture(baseUrl, apiKey, fixture, ensured.item);
		if (!reset) {
			state = await readFixtureFileState(baseUrl, apiKey, fixture, ensured.item);
			if (state.kind !== "ready") {
				throw new Error(
					`${fixture.service} fixture changed while normalization was being authorized`,
				);
			}
			process.stdout.write(
				`${fixture.service}: ${fixture.quality} ${fixture.kind} fixture ready (item ${ensured.item.id}, file ${state.record.id})\n`,
			);
			return;
		}
		ensured =
			fixture.kind === "movie"
				? await ensureMovie(baseUrl, apiKey, fixture)
				: await ensureSeries(baseUrl, apiKey, fixture);
		if (!ensured.created) {
			throw new Error(`${fixture.service} did not recreate the normalized fixture`);
		}
	} else if (state.kind === "absent" && !ensured.created) {
		await runRescan(baseUrl, apiKey, fixture, ensured.item.id);
	} else if (state.kind !== "absent" && state.kind !== "pending") {
		throw new Error(`${fixture.service} returned unsupported fixture state ${state.kind}`);
	}

	const record = await waitForFileRecord(baseUrl, apiKey, fixture, ensured.item);
	process.stdout.write(
		`${fixture.service}: ${fixture.quality} ${fixture.kind} fixture ready (item ${ensured.item.id}, file ${record.id})\n`,
	);
}

export function prepareFilesystem() {
	assertUniqueProjectName(requireEnvironment("COMPOSE_PROJECT_NAME"));
	for (const fixture of ARR_FIXTURES) {
		prepareRootFolder(fixture);
		createHardlinkedFixture(fixture, fixtureLibraryPath(fixture));
	}
}

export async function bootstrapApis(credentials) {
	assertUniqueProjectName(requireEnvironment("COMPOSE_PROJECT_NAME"));
	const validatedCredentials = validateCredentials(credentials);
	for (const fixture of ARR_FIXTURES) {
		await bootstrapFixture(fixture, validatedCredentials[fixture.apiKeyEnv]);
	}
}

export async function main() {
	const mode = process.argv[2];
	if (mode === "--filesystem-only") {
		prepareFilesystem();
		return;
	}
	if (mode === "--api-only") {
		let credentials;
		try {
			credentials = JSON.parse(readFileSync(0, "utf8"));
		} catch {
			throw new Error("expected ARR credentials as JSON on standard input");
		}
		await bootstrapApis(credentials);
		return;
	}
	throw new Error("expected --filesystem-only or --api-only");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main().catch((error) => {
		process.stderr.write(
			`ARR/media bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
