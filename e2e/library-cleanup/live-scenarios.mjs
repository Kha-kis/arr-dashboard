#!/usr/bin/env node

import fs from "node:fs/promises";

const API_BASE = "http://127.0.0.1:3001";
const PLEX_BASE = "http://plex:33240";
const RULE_PREFIX = "LC E2E ";
const USERNAME = "gauntlet-admin";
const PASSWORD = "LibraryCleanupGauntlet2026!";
const LEGACY_HARNESS_RULE_NAMES = new Set(["qUI seeding exclusion"]);

const ARR = Object.freeze({
	"radarr-hd": {
		label: "Library Cleanup Radarr HD",
		service: "RADARR",
		baseUrl: "http://radarr-a:7878",
		apiKeyEnv: "RADARR_A_KEY",
		kind: "movie",
		quality: "1080p",
		libraryPath: "/radarr-a/data/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264-LCE2E.mkv",
		plexPath:
			"/plex/data/library/radarr-a/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264-LCE2E.mkv",
	},
	"radarr-uhd": {
		label: "Library Cleanup Radarr UHD",
		service: "RADARR",
		baseUrl: "http://radarr-b:7878",
		apiKeyEnv: "RADARR_B_KEY",
		kind: "movie",
		quality: "2160p",
		libraryPath: "/radarr-b/data/The Matrix (1999)/The.Matrix.1999.2160p.UHD.BluRay.x265-LCE2E.mkv",
		plexPath:
			"/plex/data/library/radarr-b/The Matrix (1999)/The.Matrix.1999.2160p.UHD.BluRay.x265-LCE2E.mkv",
	},
	"sonarr-hd": {
		label: "Library Cleanup Sonarr HD",
		service: "SONARR",
		baseUrl: "http://sonarr-a:8989",
		apiKeyEnv: "SONARR_A_KEY",
		kind: "series",
		quality: "1080p",
		libraryPath:
			"/sonarr-a/data/Breaking Bad/Season 01/Breaking.Bad.S01E01.1080p.BluRay.x264-LCE2E.mkv",
		plexPath:
			"/plex/data/library/sonarr-a/Breaking Bad/Season 01/Breaking.Bad.S01E01.1080p.BluRay.x264-LCE2E.mkv",
	},
	"sonarr-uhd": {
		label: "Library Cleanup Sonarr UHD",
		service: "SONARR",
		baseUrl: "http://sonarr-b:8989",
		apiKeyEnv: "SONARR_B_KEY",
		kind: "series",
		quality: "2160p",
		libraryPath:
			"/sonarr-b/data/Breaking Bad/Season 01/Breaking.Bad.S01E01.2160p.UHD.BluRay.x265-LCE2E.mkv",
		plexPath:
			"/plex/data/library/sonarr-b/Breaking Bad/Season 01/Breaking.Bad.S01E01.2160p.UHD.BluRay.x265-LCE2E.mkv",
	},
});

function invariant(condition, message) {
	if (!condition) throw new Error(message);
}

function env(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable ${name}`);
	return value;
}

async function parseResponse(response, label) {
	const text = await response.text();
	if (!response.ok)
		throw new Error(`${label} failed with HTTP ${response.status}: ${text.slice(0, 800)}`);
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${label} returned non-JSON data`);
	}
}

async function authenticate() {
	// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request --
	// This disposable Compose harness exposes the dashboard API on loopback only.
	const setup = await fetch(`${API_BASE}/auth/setup-required`).then((response) =>
		parseResponse(response, "setup-required"),
	);
	const response = await fetch(`${API_BASE}/auth/${setup.required ? "register" : "login"}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username: USERNAME, password: PASSWORD, rememberMe: false }),
	});
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	await parseResponse(response, "dashboard authentication");
	invariant(cookie, "Dashboard authentication did not return a session cookie");
	return cookie;
}

function makeApi(cookie) {
	return async (path, options = {}) => {
		const body = options.body === undefined ? undefined : JSON.stringify(options.body);
		return await fetch(`${API_BASE}${path}`, {
			...options,
			body,
			headers: {
				cookie,
				...(body ? { "content-type": "application/json" } : {}),
				...options.headers,
			},
		}).then((response) => parseResponse(response, `${options.method ?? "GET"} ${path}`));
	};
}

function makeArrRequest(spec) {
	const key = env(spec.apiKeyEnv);
	return async (path, options = {}) => {
		const body = options.body === undefined ? undefined : JSON.stringify(options.body);
		return await fetch(`${spec.baseUrl}${path}`, {
			...options,
			body,
			headers: {
				"X-Api-Key": key,
				...(body ? { "content-type": "application/json" } : {}),
			},
		}).then((response) =>
			parseResponse(response, `${spec.label} ${options.method ?? "GET"} ${path}`),
		);
	};
}

async function getContext(api) {
	const services = (await api("/api/services")).services;
	invariant(Array.isArray(services), "Dashboard returned an invalid service inventory");
	const byLabel = new Map();
	for (const service of services) {
		if (byLabel.has(service.label)) throw new Error(`Duplicate service label ${service.label}`);
		byLabel.set(service.label, service);
	}
	for (const spec of Object.values(ARR)) {
		const instance = byLabel.get(spec.label);
		invariant(instance?.id, `Missing exact fixture service ${spec.label}`);
		spec.instanceId = instance.id;
	}
	const plex = byLabel.get("Library Cleanup Plex");
	invariant(plex?.id, "Missing exact fixture service Library Cleanup Plex");
	return { api, plex };
}

async function resetRules(api) {
	const config = await api("/api/library-cleanup/config");
	const foreignRules = config.rules.filter(
		(rule) => !rule.name.startsWith(RULE_PREFIX) && !LEGACY_HARNESS_RULE_NAMES.has(rule.name),
	);
	invariant(
		foreignRules.length === 0,
		`Refusing to alter cleanup configuration containing non-harness rules: ${foreignRules.map((rule) => rule.name).join(", ")}`,
	);
	for (const rule of config.rules) {
		await api(`/api/library-cleanup/rules/${rule.id}`, { method: "DELETE" });
	}
}

async function configure(api, overrides = {}) {
	return await api("/api/library-cleanup/config", {
		method: "PUT",
		body: {
			enabled: true,
			intervalHours: 24,
			dryRunMode: true,
			maxRemovalsPerRun: 10,
			requireApproval: false,
			respectQuiSeeding: false,
			rejectionMemoryDays: 0,
			...overrides,
		},
	});
}

async function createRule(api, rule) {
	const { name, ...fields } = rule;
	return await api("/api/library-cleanup/rules", {
		method: "POST",
		body: {
			enabled: true,
			priority: 0,
			targetScope: "series",
			action: "delete",
			retentionMode: false,
			useGlobalRejectionMemory: false,
			rejectionMemoryDays: 0,
			...fields,
			name: `${RULE_PREFIX}${name}`,
		},
	});
}

function assertPreview(preview, expectedLabels, expectedAction, expectedStatus = "selected") {
	invariant(preview.selectionCountsComplete === true, "Preview selection counts were incomplete");
	invariant(preview.display?.complete === true, "Preview display was unexpectedly truncated");
	const actual = preview.items.map((item) => item.instanceLabel).sort();
	const expected = [...expectedLabels].sort();
	invariant(
		JSON.stringify(actual) === JSON.stringify(expected),
		`Preview target mismatch: expected ${expected.join(", ") || "none"}; got ${actual.join(", ") || "none"}; evaluated=${preview.totalEvaluated}, flagged=${preview.totalFlagged}, warnings=${JSON.stringify(preview.warnings ?? [])}, health=${JSON.stringify(preview.prefetchHealth ?? {})}`,
	);
	for (const item of preview.items) {
		invariant(
			item.plannedAction === expectedAction,
			`Preview planned ${item.plannedAction ?? item.action}, expected ${expectedAction}`,
		);
		if (expectedStatus) {
			invariant(
				item.selectionStatus === expectedStatus,
				`${item.instanceLabel} status was not ${expectedStatus}: ${JSON.stringify(item)}`,
			);
		}
	}
}

async function preview(api) {
	return await api("/api/library-cleanup/preview", { method: "POST", body: {} });
}

async function execute(api) {
	return await api("/api/library-cleanup/execute", { method: "POST", body: {} });
}

async function waitForLibrarySync(api, instanceId) {
	await api(`/api/library/sync/${instanceId}`, { method: "POST", body: {} });
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const status = (await api("/api/library/sync/status")).instances.find(
			(candidate) => candidate.instanceId === instanceId,
		);
		if (
			status?.syncStatus?.syncInProgress === false &&
			status.syncStatus.lastError == null &&
			status.syncStatus.lastFullSync != null
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`Library sync did not finish for ${instanceId}`);
}

async function requestPlex(path, options = {}) {
	return await fetch(`${PLEX_BASE}${path}`, {
		...options,
		headers: { accept: "application/json", "X-Plex-Token": "lc-e2e-local" },
	}).then((response) => parseResponse(response, `Plex ${options.method ?? "GET"} ${path}`));
}

async function refreshPlexAndRead(sectionId, readPath, predicate) {
	await requestPlex(`/library/sections/${sectionId}/refresh`, { method: "POST" });
	return await readPlexUntil(readPath, predicate);
}

async function readPlexUntil(readPath, predicate) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const payload = await requestPlex(readPath);
		if (predicate(payload)) return payload;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`Plex did not reach the expected state for ${readPath}`);
}

async function arrItems(spec) {
	const request = makeArrRequest(spec);
	return await request(spec.kind === "movie" ? "/api/v3/movie" : "/api/v3/series");
}

async function assertArrPresent(spec, expectedFile) {
	const request = makeArrRequest(spec);
	const items = await arrItems(spec);
	const matches = items.filter((item) =>
		spec.kind === "movie" ? item.tmdbId === 603 : item.tvdbId === 81189,
	);
	invariant(matches.length === 1, `${spec.label} did not retain exactly one fixture item`);
	if (spec.kind === "movie") {
		const files = await request(`/api/v3/moviefile?movieId=${matches[0].id}`);
		invariant(
			files.length === (expectedFile ? 1 : 0),
			`${spec.label} movie-file state was unexpected`,
		);
	} else {
		const files = await request(`/api/v3/episodefile?seriesId=${matches[0].id}`);
		invariant(
			files.length === (expectedFile ? 1 : 0),
			`${spec.label} episode-file state was unexpected`,
		);
	}
}

async function assertArrRemoved(spec) {
	const matches = (await arrItems(spec)).filter((item) =>
		spec.kind === "movie" ? item.tmdbId === 603 : item.tvdbId === 81189,
	);
	invariant(matches.length === 0, `${spec.label} still contains the deleted fixture item`);
	await fs.access(spec.libraryPath).then(
		() => {
			throw new Error(`${spec.label} library file still exists after deletion`);
		},
		(error) => {
			if (error?.code !== "ENOENT") throw error;
		},
	);
}

async function assertQuiSourcesRemain(api) {
	const summary = await api("/api/qui/summary");
	invariant(
		summary.configuredInstances === 2 && summary.totalTorrents === 4,
		`qUI source inventory changed: ${summary.configuredInstances} instances, ${summary.totalTorrents} torrents`,
	);
}

async function runPolicyScenarios(ctx, { includeGate = true, includeCore = true } = {}) {
	const { api } = ctx;
	if (includeGate) {
		await resetRules(api);
		await configure(api, { respectQuiSeeding: true });
		await createRule(api, {
			name: "qUI seeding exclusion",
			ruleType: "monitored",
			parameters: {},
			serviceFilter: ["RADARR"],
			instanceFilter: [ARR["radarr-hd"].instanceId, ARR["radarr-uhd"].instanceId],
		});
		assertPreview(await preview(api), [], "delete");
		await configure(api, { respectQuiSeeding: false });
		assertPreview(
			await preview(api),
			[ARR["radarr-hd"].label, ARR["radarr-uhd"].label],
			"delete",
			null,
		);
		process.stdout.write("PASS qUI seeding gate excludes exact active fixture files\n");
	}
	if (!includeCore) {
		await resetRules(api);
		return;
	}

	await resetRules(api);
	await configure(api);
	const imdb = await createRule(api, {
		name: "issue 660 IMDb under ten",
		ruleType: "imdb_rating",
		parameters: { operator: "less_than", score: 10 },
		serviceFilter: ["RADARR"],
		instanceFilter: [ARR["radarr-hd"].instanceId, ARR["radarr-uhd"].instanceId],
	});
	invariant(imdb.parameters?.score === 10, "IMDb score did not round-trip");
	assertPreview(
		await preview(api),
		[ARR["radarr-hd"].label, ARR["radarr-uhd"].label],
		"delete",
		null,
	);
	const imdbRun = await execute(api);
	invariant(imdbRun.isDryRun === true && imdbRun.itemsRemoved === 0, "IMDb dry-run mutated data");
	await assertArrPresent(ARR["radarr-hd"], true);
	await assertArrPresent(ARR["radarr-uhd"], true);
	process.stdout.write(
		"PASS #660 IMDb less-than 10 matches both real Radarr instances without mutation\n",
	);

	await resetRules(api);
	const expression = {
		version: 1,
		root: {
			type: "group",
			operator: "OR",
			children: [
				{
					type: "group",
					operator: "AND",
					children: [
						{ type: "condition", ruleType: "monitored", parameters: {} },
						{
							type: "condition",
							ruleType: "year_range",
							parameters: { operator: "after", year: 1990 },
						},
					],
				},
				{
					type: "group",
					operator: "AND",
					children: [
						{ type: "condition", ruleType: "monitored", parameters: {} },
						{
							type: "not",
							child: {
								type: "condition",
								ruleType: "year_range",
								parameters: { operator: "after", year: 2020 },
							},
						},
					],
				},
			],
		},
	};
	const composite = await createRule(api, {
		name: "issue 618 recursive expression",
		ruleType: "composite",
		parameters: {},
		serviceFilter: ["RADARR"],
		instanceFilter: [ARR["radarr-hd"].instanceId, ARR["radarr-uhd"].instanceId],
		expression,
	});
	invariant(
		JSON.stringify(composite.expression) === JSON.stringify(expression),
		"Recursive expression changed during round-trip",
	);
	assertPreview(
		await preview(api),
		[ARR["radarr-hd"].label, ARR["radarr-uhd"].label],
		"delete",
		null,
	);
	const compositeRun = await execute(api);
	invariant(
		compositeRun.isDryRun === true && compositeRun.itemsRemoved === 0,
		"Composite dry-run mutated data",
	);
	process.stdout.write("PASS #618 nested (A AND B) OR (A AND NOT C) evaluates and round-trips\n");

	await resetRules(api);
	await configure(api, { dryRunMode: false });
	await createRule(api, {
		name: "issue 619 monitored action",
		ruleType: "monitored",
		parameters: {},
		serviceFilter: ["RADARR"],
		instanceFilter: [ARR["radarr-uhd"].instanceId],
		action: "unmonitor",
	});
	assertPreview(await preview(api), [ARR["radarr-uhd"].label], "unmonitor");
	const unmonitorRun = await execute(api);
	invariant(
		unmonitorRun.itemsUnmonitored === 1,
		"Monitored rule did not unmonitor exactly one item",
	);
	const radarr = makeArrRequest(ARR["radarr-uhd"]);
	const movie = (await radarr("/api/v3/movie")).find((item) => item.tmdbId === 603);
	invariant(movie?.monitored === false, "Radarr did not persist the unmonitor action");
	await radarr(`/api/v3/movie/${movie.id}`, { method: "PUT", body: { ...movie, monitored: true } });
	await waitForLibrarySync(api, ARR["radarr-uhd"].instanceId);
	const restored = await radarr(`/api/v3/movie/${movie.id}`);
	invariant(
		restored.monitored === true,
		"Radarr monitored state was not restored after the scenario",
	);
	process.stdout.write(
		"PASS #619 monitored condition performs and verifies a real unmonitor action\n",
	);
	await resetRules(api);
}

async function runSeriesDelete(ctx, targetKey) {
	const { api } = ctx;
	const target = ARR[targetKey];
	invariant(target, `Unknown deletion target ${targetKey}`);
	const peerKey =
		targetKey.endsWith("hd") && !targetKey.endsWith("uhd")
			? targetKey.replace(/-hd$/, "-uhd")
			: targetKey.replace(/-uhd$/, "-hd");
	const peer = ARR[peerKey];
	invariant(peer?.service === target.service, `No same-service peer for ${targetKey}`);
	await resetRules(api);
	await configure(api, { dryRunMode: false, respectQuiSeeding: false });
	await createRule(api, {
		name: `${targetKey} shared Plex deletion`,
		ruleType: "monitored",
		parameters: {},
		serviceFilter: [target.service],
		instanceFilter: [target.instanceId],
		action: "delete",
		scanMediaServerAfterDelete: true,
	});
	assertPreview(await preview(api), [target.label], "delete");
	const result = await execute(api);
	invariant(
		result.isDryRun === false && result.itemsRemoved === 1,
		`${target.label} was not removed exactly once: ${JSON.stringify(result)}`,
	);
	await assertArrRemoved(target);
	await assertArrPresent(peer, true);
	await assertQuiSourcesRemain(api);

	if (target.service === "RADARR") {
		await readPlexUntil("/library/sections/1/all", (payload) => {
			const items = payload?.MediaContainer?.Metadata ?? [];
			const matrix = items.find((item) => item.title === "The Matrix");
			const paths = (matrix?.Media ?? []).flatMap((media) =>
				(media.Part ?? []).map((part) => part.file),
			);
			return items.length === 1 && paths.length === 1 && paths[0] === peer.plexPath;
		});
	} else {
		await readPlexUntil("/library/metadata/15/allLeaves", (payload) => {
			const episodes = payload?.MediaContainer?.Metadata ?? [];
			const pilot = episodes.find(
				(item) => item.title === "Pilot" && item.parentIndex === 1 && item.index === 1,
			);
			const paths = (pilot?.Media ?? []).flatMap((media) =>
				(media.Part ?? []).map((part) => part.file),
			);
			return episodes.length === 1 && paths.length === 1 && paths[0] === peer.plexPath;
		});
	}
	process.stdout.write(
		`PASS ${target.service === "RADARR" ? "#616" : "#657"}/#667 deleted ${target.quality}, automatically triggered the Plex scan, and retained ${peer.quality}, the shared Plex identity, and all qUI source torrents\n`,
	);
	await resetRules(api);
}

async function waitForEpisodeEvidence(ctx) {
	const { api, plex } = ctx;
	for (let attempt = 0; attempt < 90; attempt += 1) {
		const status = await api(
			`/api/plex/episodes?instanceId=${encodeURIComponent(plex.id)}&showTmdbId=1396`,
		);
		if (
			status.episodes?.some(
				(episode) => episode.seasonNumber === 1 && episode.episodeNumber === 1 && episode.watched,
			)
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
	throw new Error("Plex episode scheduler did not publish watched S01E01 evidence in time");
}

async function runEpisodeDelete(ctx, targetKey) {
	const { api } = ctx;
	const target = ARR[targetKey];
	invariant(target?.service === "SONARR", "Episode deletion must target a Sonarr fixture");
	const peerKey = targetKey === "sonarr-hd" ? "sonarr-uhd" : "sonarr-hd";
	const peer = ARR[peerKey];
	await waitForEpisodeEvidence(ctx);
	await resetRules(api);
	await configure(api, { dryRunMode: false, respectQuiSeeding: false });
	await createRule(api, {
		name: `${targetKey} episode deletion`,
		ruleType: "plex_watch_count",
		parameters: { operator: "greater_than", count: 0 },
		serviceFilter: ["SONARR"],
		instanceFilter: [target.instanceId],
		targetScope: "episode",
		action: "delete_files",
	});
	const episodePreview = await preview(api);
	assertPreview(episodePreview, [target.label], "delete_files");
	invariant(
		episodePreview.items[0]?.targetScope === "episode" &&
			episodePreview.items[0]?.seasonNumber === 1 &&
			episodePreview.items[0]?.episodeNumber === 1,
		"Episode preview did not identify Breaking Bad S01E01",
	);
	const result = await execute(api);
	invariant(
		result.itemsFilesDeleted === 1 && result.itemsRemoved === 0,
		"Episode cleanup did not delete exactly one file while retaining the series",
	);
	await assertArrPresent(target, false);
	await assertArrPresent(peer, true);
	await assertQuiSourcesRemain(api);
	await refreshPlexAndRead("2", "/library/metadata/15/allLeaves", (payload) => {
		const episodes = payload?.MediaContainer?.Metadata ?? [];
		const pilot = episodes.find(
			(item) => item.title === "Pilot" && item.parentIndex === 1 && item.index === 1,
		);
		const paths = (pilot?.Media ?? []).flatMap((media) =>
			(media.Part ?? []).map((part) => part.file),
		);
		return episodes.length === 1 && paths.length === 1 && paths[0] === peer.plexPath;
	});
	process.stdout.write(
		`PASS #659 episode cleanup deleted only ${target.quality} S01E01 while retaining both Sonarr series records, the ${peer.quality} file, Plex identity, and qUI sources\n`,
	);
	await resetRules(api);
}

export async function main(mode = process.argv[2]) {
	invariant(mode, "Specify a scenario mode");
	const api = makeApi(await authenticate());
	const ctx = await getContext(api);
	if (mode === "policy") await runPolicyScenarios(ctx);
	else if (mode === "policy-gate")
		await runPolicyScenarios(ctx, { includeGate: true, includeCore: false });
	else if (mode === "policy-core") await runPolicyScenarios(ctx, { includeGate: false });
	else if (mode.startsWith("delete:")) await runSeriesDelete(ctx, mode.slice("delete:".length));
	else if (mode.startsWith("episode:")) await runEpisodeDelete(ctx, mode.slice("episode:".length));
	else throw new Error(`Unknown scenario mode ${mode}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		process.stderr.write(
			`Live cleanup scenario failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
