// AE150-DIAG PURE HELPER BEGIN
const diagnosticStages = new Set([
	"phase-start",
	"jellyfin-public-info",
	"jellyfin-startup",
	"jellyfin-auth",
	"jellyfin-library-setup",
	"jellyfin-scan",
	"jellyfin-boxset",
	"dashboard-auth",
	"service-lookup",
	"service-create",
	"service-update",
	"mode-selection",
	"refresh-durable-read",
	"refresh-submit",
	"refresh-health",
	"state-write",
	"phase-complete",
]);
const diagnosticPhases = new Set([
	"bootstrap",
	"boxset",
	"pagination",
	"recovery",
	"rotation",
	"shapes",
]);
let diagnosticStage = "phase-start";
let diagnosticLastDurable = null;
let diagnosticLastHealth = null;
let diagnosticRefresh = null;
let diagnosticRefreshStarted = null;
let diagnosticRejection = null;

function diagnosticBeginRefresh() {
	diagnosticRefreshStarted = performance.now();
	diagnosticRefresh = {
		reads: 0,
		submitted: false,
		accepted: false,
		timestampsSupported: null,
		markerValid: null,
	};
	diagnosticLastDurable = null;
	diagnosticLastHealth = null;
	diagnosticRejection = null;
}

function diagnosticSubmissionStarted() {
	if (diagnosticRefresh) diagnosticRefresh.submitted = true;
}

function diagnosticSubmissionAccepted(status, body) {
	if (diagnosticRefresh)
		diagnosticRefresh.accepted =
			status === 202 && body?.status === "accepted" && body?.cacheType === "jellyfin";
}

function diagnosticMarkStage(stage) {
	if (!diagnosticStages.has(stage)) throw new Error("Diagnostic stage rejected");
	diagnosticStage = stage;
}

function diagnosticObserveDurable(value) {
	const count = (input) =>
		Number.isInteger(input) && input >= 0 && input <= 1_000_000 ? input : null;
	const state = value?.lastAttemptResult;
	if (diagnosticRefresh) {
		diagnosticRefresh.reads++;
		const supported = (input) => {
			if (input == null) return true;
			const time =
				typeof input === "number"
					? input
					: typeof input === "string" && /^\d{4}-\d{2}-\d{2}T/.test(input)
						? Date.parse(input)
						: NaN;
			return Number.isFinite(time) && Number.isFinite(new Date(time).getTime());
		};
		diagnosticRefresh.timestampsSupported = [
			value?.lastAttemptAt,
			value?.lastRefreshedAt,
			value?.publicationAttemptStartedAt,
			value?.publicationObservedAt,
		].every(supported);
		diagnosticRefresh.markerValid =
			typeof state === "string" && state.startsWith("in_progress:")
				? /^in_progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
						state,
					)
				: null;
	}
	diagnosticLastDurable = {
		statusRows: count(value?.statusRows),
		rows: count(value?.rows),
		itemCount: count(value?.itemCount),
		attempt:
			state == null
				? "missing"
				: state === "success" || state === "error"
					? state
					: typeof state === "string" && state.startsWith("in_progress:")
						? "in-progress"
						: "other",
		hasAttemptAt: value?.lastAttemptAt != null,
		hasRefreshedAt: value?.lastRefreshedAt != null,
		hasReceiptStart: value?.publicationAttemptStartedAt != null,
		hasReceiptObserved: value?.publicationObservedAt != null,
		hasGeneration: typeof value?.generationId === "string" && value.generationId.length > 0,
		publicationCheck: [
			"valid",
			"metadata",
			"schema",
			"receipt",
			"domains",
			"units",
			"mapping",
			"watch",
			"other",
		].includes(value?.publicationCheck)
			? value.publicationCheck
			: "other",
	};
	return value;
}

function diagnosticObserveHealth(value) {
	diagnosticLastHealth = {
		lastResult: ["success", "partial", "error"].includes(value?.lastResult)
			? value.lastResult
			: "unknown",
		itemCount:
			Number.isInteger(value?.itemCount) && value.itemCount >= 0 && value.itemCount <= 1_000_000
				? value.itemCount
				: null,
		isStale: typeof value?.isStale === "boolean" ? value.isStale : null,
	};
	return value;
}

function diagnosticFailure(phase, error) {
	if (!diagnosticPhases.has(phase)) throw new Error("Diagnostic phase rejected");
	const text = (key) => {
		try {
			const value = error?.[key];
			return typeof value === "string" ? value : "";
		} catch {
			return "";
		}
	};
	const message = text("message");
	const name = text("name");
	const code = text("code");
	const http = message.match(
		/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/[^\r\n]* returned ([1-5][0-9]{2})$/,
	);
	const httpStatus = http?.[0] === message ? Number(http[1]) : null;
	const category =
		message === "Jellyfin refresh completion evidence rejected"
			? "refresh-evidence-rejected"
			: httpStatus !== null
				? "http-status"
				: /^SQLITE_[A-Z_]+$/.test(code) || name === "SqliteError"
					? "sqlite"
					: name === "TypeError"
						? "type"
						: name === "SyntaxError"
							? "syntax"
							: name === "AssertionError" || code === "ERR_ASSERTION"
								? "assertion"
								: "other";
	let refresh = null;
	if (diagnosticRefresh) {
		const elapsed = performance.now() - diagnosticRefreshStarted;
		refresh = {
			...diagnosticRefresh,
			reads: diagnosticRefresh.reads <= 1_000_000 ? diagnosticRefresh.reads : null,
			elapsedMs:
				Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 1_000_000
					? Math.floor(elapsed)
					: null,
		};
	}
	return {
		diagnostic: true,
		phase,
		status: "FAIL",
		stage: diagnosticStage,
		category,
		httpStatus,
		durable: diagnosticLastDurable === null ? null : { ...diagnosticLastDurable },
		health: diagnosticLastHealth === null ? null : { ...diagnosticLastHealth },
		refresh,
		rejection: diagnosticRejection,
	};
}
// AE150-DIAG PURE HELPER END

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
	assertExactJellyfinVersion,
	firstCookie,
	waitForFreshJellyfinCache,
	observeFailedJellyfinRefresh,
	projectJellyfinLibraryEvidence,
} from "./live-matrix-lib.mjs";

const phase = process.argv[2];
const dashboardBase = process.env.DASHBOARD_API_BASE ?? "http://dashboard:3001";
const dashboardDbPath = process.env.DASHBOARD_DB_PATH ?? "/dashboard-config/prod.db";
const jellyfinBase = process.env.JELLYFIN_BASE ?? "http://jellyfin:8096";
const proxyBase = process.env.JELLYFIN_PROXY_BASE ?? "http://jellyfin-proxy:18096";
const statePath = process.env.JF_AUTHORITY_STATE_PATH ?? "/fixture-state/state.json";
const runToken = process.env.JF_AUTHORITY_RUN_TOKEN ?? "";
let failedRefreshObservation;
assert.match(runToken, /^[a-f0-9]{64}$/);

const fixtureUsername = `fixture-${runToken.slice(0, 8)}`;
const fixturePassword = `Aa1!${runToken.slice(8, 36)}`;
const jellyfinHeaders = (token) => ({
	accept: "application/json",
	"content-type": "application/json",
	"x-emby-authorization": `MediaBrowser Token="${token}", Client="arr-dashboard-authority-fixture", Device="Runner", DeviceId="authority-${runToken.slice(0, 16)}", Version="1.0"`,
});

async function jsonRequest(url, options = {}, expected = [200]) {
	const response = await fetch(url, options);
	assert.ok(
		expected.includes(response.status),
		`${options.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}`,
	);
	if (response.status === 204) return { response, body: null };
	return { response, body: await response.json() };
}

async function waitFor(check, label, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const result = await check();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`${label} did not become ready${lastError ? `: ${lastError.message}` : ""}`);
}

async function authenticateJellyfin() {
	diagnosticMarkStage("jellyfin-auth");
	const { body } = await jsonRequest(`${jellyfinBase}/Users/AuthenticateByName`, {
		body: JSON.stringify({ Pw: fixturePassword, Username: fixtureUsername }),
		headers: {
			"content-type": "application/json",
			"x-emby-authorization": `MediaBrowser Client="arr-dashboard-authority-fixture", Device="Runner", DeviceId="authority-${runToken.slice(0, 16)}", Version="1.0"`,
		},
		method: "POST",
	});
	assert.ok(body.AccessToken);
	assert.ok(body.User?.Id);
	return { token: body.AccessToken, userId: body.User.Id };
}

async function setupJellyfin() {
	diagnosticMarkStage("jellyfin-public-info");
	const publicInfo = (await jsonRequest(`${jellyfinBase}/System/Info/Public`)).body;
	assertExactJellyfinVersion(publicInfo);
	diagnosticMarkStage("jellyfin-startup");
	const startup = await fetch(`${jellyfinBase}/Startup/User`);
	if (startup.status === 200) {
		await jsonRequest(
			`${jellyfinBase}/Startup/Configuration`,
			{
				body: JSON.stringify({
					MetadataCountryCode: "US",
					PreferredMetadataLanguage: "en",
					UICulture: "en-US",
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			},
			[204],
		);
		await jsonRequest(
			`${jellyfinBase}/Startup/User`,
			{
				body: JSON.stringify({ Name: fixtureUsername, Password: fixturePassword }),
				headers: { "content-type": "application/json" },
				method: "POST",
			},
			[204],
		);
		await jsonRequest(
			`${jellyfinBase}/Startup/RemoteAccess`,
			{
				body: JSON.stringify({ EnableAutomaticPortMapping: false, EnableRemoteAccess: true }),
				headers: { "content-type": "application/json" },
				method: "POST",
			},
			[204],
		);
		await jsonRequest(`${jellyfinBase}/Startup/Complete`, { method: "POST" }, [204]);
	} else {
		assert.ok([401, 403].includes(startup.status), "unexpected Jellyfin setup state");
	}

	const auth = await authenticateJellyfin();
	const headers = jellyfinHeaders(auth.token);
	diagnosticMarkStage("jellyfin-library-setup");
	const existing = (await jsonRequest(`${jellyfinBase}/Library/VirtualFolders`, { headers })).body;
	const libraries = [
		{ collectionType: "movies", name: "Authority Movies A", path: "/media/movies-a" },
		{ collectionType: "movies", name: "Authority Movies B", path: "/media/movies-b" },
		{ collectionType: "tvshows", name: "Authority Shows", path: "/media/shows" },
	];
	for (const library of libraries) {
		if (existing.some((entry) => entry.Name === library.name)) continue;
		const query = new URLSearchParams({
			collectionType: library.collectionType,
			name: library.name,
			refreshLibrary: "false",
		});
		await jsonRequest(
			`${jellyfinBase}/Library/VirtualFolders?${query}`,
			{
				body: JSON.stringify({
					LibraryOptions: { EnableRealtimeMonitor: false, PathInfos: [{ Path: library.path }] },
				}),
				headers,
				method: "POST",
			},
			[204],
		);
	}
	diagnosticMarkStage("jellyfin-scan");
	await jsonRequest(`${jellyfinBase}/Library/Refresh`, { headers, method: "POST" }, [204]);
	const inventory = await waitFor(async () => {
		const query = new URLSearchParams({
			Fields: "ProviderIds",
			IncludeItemTypes: "Movie,Series",
			Limit: "100",
			Recursive: "true",
		});
		const body = (
			await jsonRequest(`${jellyfinBase}/Users/${auth.userId}/Items?${query}`, { headers })
		).body;
		return body.Items?.length === 4 && body.Items.every((item) => item.ProviderIds?.Tmdb)
			? body.Items
			: null;
	}, "synthetic Jellyfin media scan");
	const movieIds = inventory.filter((item) => item.Type === "Movie").map((item) => item.Id);
	assert.equal(movieIds.length, 3);
	diagnosticMarkStage("jellyfin-boxset");
	let boxSets = (
		await jsonRequest(
			`${jellyfinBase}/Users/${auth.userId}/Items?IncludeItemTypes=BoxSet&Recursive=true&Limit=100`,
			{ headers },
		)
	).body.Items;
	if (boxSets.length === 0) {
		const query = new URLSearchParams({
			ids: movieIds.slice(0, 2).join(","),
			name: "Authority Collection",
		});
		await jsonRequest(
			`${jellyfinBase}/Collections?${query}`,
			{ headers, method: "POST" },
			[200, 204],
		);
		boxSets = await waitFor(async () => {
			const body = (
				await jsonRequest(
					`${jellyfinBase}/Users/${auth.userId}/Items?IncludeItemTypes=BoxSet&Recursive=true&Limit=100`,
					{ headers },
				)
			).body;
			return body.Items?.length > 0 ? body.Items : null;
		}, "real Jellyfin BoxSet");
	}
	assert.ok(boxSets.every((item) => item.Type === "BoxSet"));
	return auth;
}

async function dashboardCookie() {
	diagnosticMarkStage("dashboard-auth");
	const setup = (await jsonRequest(`${dashboardBase}/auth/setup-required`)).body;
	const path = setup.required ? "register" : "login";
	const { response } = await jsonRequest(
		`${dashboardBase}/auth/${path}`,
		{
			body: JSON.stringify({
				password: fixturePassword,
				rememberMe: false,
				username: fixtureUsername,
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		},
		[setup.required ? 201 : 200],
	);
	return firstCookie(response.headers);
}

async function dashboardRequest(cookie, path, options = {}, expected = [200]) {
	const contentHeaders = options.body === undefined ? {} : { "content-type": "application/json" };
	return await jsonRequest(
		`${dashboardBase}${path}`,
		{
			...options,
			headers: { ...contentHeaders, cookie, ...options.headers },
		},
		expected,
	);
}

async function readState() {
	return JSON.parse(await readFile(statePath, "utf8"));
}

async function writeState(state) {
	diagnosticMarkStage("state-write");
	await mkdir(new URL(".", `file://${statePath}`).pathname, { recursive: true });
	await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	await chmod(statePath, 0o600);
}

function readDurableState(instanceId, publicationProfile = "domain-bounded-v2") {
	const require = createRequire("/app/api/package.json");
	const Database = require("better-sqlite3");
	const database = new Database(dashboardDbPath, { fileMustExist: true, readonly: true });
	try {
		const instance = database
			.prepare(
				'SELECT "connectionGeneration", "identityGeneration" FROM "ServiceInstance" WHERE id = ?',
			)
			.get(instanceId);
		const cache = database
			.prepare(
				'SELECT COUNT(*) AS rows, MIN("connectionGeneration") AS rowConnectionGeneration, MIN("identityGeneration") AS rowIdentityGeneration FROM jellyfin_cache WHERE "instanceId" = ?',
			)
			.get(instanceId);
		const status = database
			.prepare(
				'SELECT COUNT(*) AS statusRows, MIN("itemCount") AS itemCount, MIN("lastResult") AS lastResult, MIN("lastAttemptResult") AS lastAttemptResult, MIN("lastAttemptAt") AS lastAttemptAt, MIN("lastRefreshedAt") AS lastRefreshedAt, MIN("generationId") AS generationId, MIN("generationMetadata") AS publicationMetadata, MIN(CASE WHEN json_valid("generationMetadata") THEN json_extract("generationMetadata", \'$.coverageReceipt.attemptStartedAt\') END) AS publicationAttemptStartedAt, MIN(CASE WHEN json_valid("generationMetadata") THEN json_extract("generationMetadata", \'$.coverageReceipt.observedAt\') END) AS publicationObservedAt, MIN("connectionGeneration") AS statusConnectionGeneration, MIN("identityGeneration") AS statusIdentityGeneration FROM cache_refresh_status WHERE "instanceId" = ? AND "cacheType" = ?',
			)
			.get(instanceId, "jellyfin");
		const { publicationMetadata, ...safeStatus } = status;
		const schema = require("@arr/shared").providerCoverageReceiptV2Schema;
		let publicationCheck = "valid";
		const publicationEvidence = projectJellyfinLibraryEvidence(
			publicationMetadata,
			schema,
			(category) => {
				publicationCheck = category;
			},
			publicationProfile,
		);
		return { ...instance, ...cache, ...safeStatus, publicationEvidence, publicationCheck };
	} finally {
		database.close();
	}
}

async function setMode(mode) {
	diagnosticMarkStage("mode-selection");
	await jsonRequest(
		`${proxyBase}/__fixture/mode`,
		{
			body: JSON.stringify({ mode }),
			headers: { "content-type": "application/json" },
			method: "PUT",
		},
		[204],
	);
}

async function healthFor(cookie, instanceId, signal) {
	diagnosticMarkStage("refresh-health");
	const { body } = await dashboardRequest(cookie, "/api/jellyfin/cache/health", { signal });
	const item = body.items.find(
		(entry) => entry.instanceId === instanceId && entry.cacheType === "jellyfin",
	);
	assert.ok(item, "missing Jellyfin cache health item");
	return item;
}

async function refresh(cookie, instanceId, expected) {
	diagnosticBeginRefresh();
	const publicationProfile = expected.publicationProfile ?? "domain-bounded-v2";
	let lastDurable;
	failedRefreshObservation = () =>
		observeFailedJellyfinRefresh({
			attempt: lastDurable,
			readDurable: () => readDurableState(instanceId, publicationProfile),
			readProxy: async ({ signal }) =>
				(await jsonRequest(`${proxyBase}/__fixture/status`, { signal })).body,
		});
	await waitForFreshJellyfinCache({
		onRejected: (value) => {
			diagnosticRejection = value;
		},
		expected: { ...expected, publicationProfile },
		readDurable: () => {
			diagnosticMarkStage("refresh-durable-read");
			lastDurable = readDurableState(instanceId, publicationProfile);
			return diagnosticObserveDurable(lastDurable);
		},
		readHealth: async ({ signal }) =>
			diagnosticObserveHealth(await healthFor(cookie, instanceId, signal)),
		submit: async ({ signal }) => {
			diagnosticMarkStage("refresh-submit");
			diagnosticSubmissionStarted();
			const { response, body } = await dashboardRequest(
				cookie,
				`/api/jellyfin/cache/${instanceId}/refresh`,
				{ method: "POST", signal },
				[202],
			);
			diagnosticSubmissionAccepted(response.status, body);
			return { status: response.status, body };
		},
	});
}

async function bootstrap() {
	const jellyfin = await setupJellyfin();
	const cookie = await dashboardCookie();
	diagnosticMarkStage("service-lookup");
	const services = (await dashboardRequest(cookie, "/api/services")).body.services;
	let instance = services.find((entry) => entry.service === "jellyfin");
	if (!instance) {
		diagnosticMarkStage("service-create");
		instance = (
			await dashboardRequest(
				cookie,
				"/api/services",
				{
					body: JSON.stringify({
						apiKey: jellyfin.token,
						baseUrl: proxyBase,
						enabled: true,
						isDefault: true,
						label: "Authority Jellyfin",
						service: "jellyfin",
						tags: [],
					}),
					method: "POST",
				},
				[201],
			)
		).body.service;
	} else {
		diagnosticMarkStage("service-update");
		instance = (
			await dashboardRequest(cookie, `/api/services/${instance.id}`, {
				body: JSON.stringify({ apiKey: jellyfin.token }),
				method: "PUT",
			})
		).body.service;
	}
	await setMode("normal");
	await refresh(cookie, instance.id, { attempt: "success", health: "partial", rows: 4 });
	await writeState({
		instanceId: instance.id,
		jellyfinToken: jellyfin.token,
		jellyfinUserId: jellyfin.userId,
	});
	return { items: 4, version: "10.11.11" };
}

async function boxset() {
	const state = await readState();
	const cookie = await dashboardCookie();
	await setMode("boxset-only");
	diagnosticMarkStage("jellyfin-boxset");
	// This fault injector intentionally removes ParentId so every application
	// library query receives the same authentic server-wide BoxSet inventory.
	const query =
		"Fields=ProviderIds&Recursive=true&CollapseBoxSetItems=false&IncludeItemTypes=BoxSet&StartIndex=0&Limit=1000";
	const raw = (
		await jsonRequest(`${proxyBase}/Users/${state.jellyfinUserId}/Items?${query}`, {
			headers: jellyfinHeaders(state.jellyfinToken),
		})
	).body;
	assert.ok(raw.Items.length > 0);
	assert.ok(raw.Items.every((item) => item.Type === "BoxSet"));
	await refresh(cookie, state.instanceId, { attempt: "success", health: "partial", rows: 0 });
	return { authenticBoxSets: true, items: 0 };
}

async function pagination() {
	const state = await readState();
	const cookie = await dashboardCookie();
	await setMode("paginate");
	await refresh(cookie, state.instanceId, { attempt: "success", health: "partial", rows: 4 });
	const stats = (await jsonRequest(`${proxyBase}/__fixture/status`)).body;
	assert.ok(stats.itemInventoryRequests >= 4);
	return { itemInventoryRequests: stats.itemInventoryRequests, items: 4 };
}

async function shapes() {
	const state = await readState();
	const cookie = await dashboardCookie();
	await setMode("unknown-type");
	await refresh(cookie, state.instanceId, {
		attempt: "success",
		health: "partial",
		rows: 4,
		publicationProfile: "unsupported-object-positive-v2",
	});
	await setMode("malformed");
	await refresh(cookie, state.instanceId, {
		attempt: "error",
		health: "error",
		rows: 4,
		publicationProfile: "unsupported-object-positive-v2",
	});
	return { lastGoodItems: 4, malformedRejected: true, unknownInventoryNonAuthoritative: true };
}

async function recovery() {
	const state = await readState();
	const cookie = await dashboardCookie();
	await setMode("unavailable");
	await refresh(cookie, state.instanceId, {
		attempt: "error",
		health: "error",
		rows: 4,
		publicationProfile: "unsupported-object-positive-v2",
	});
	await setMode("normal");
	await refresh(cookie, state.instanceId, { attempt: "success", health: "partial", rows: 4 });
	return { recovered: true, retainedItems: 4 };
}

async function rotation() {
	const state = await readState();
	const cookie = await dashboardCookie();
	diagnosticMarkStage("service-update");
	await dashboardRequest(cookie, `/api/services/${state.instanceId}`, {
		body: JSON.stringify({ baseUrl: "http://jellyfin-proxy-rotated:18096" }),
		method: "PUT",
	});
	assert.equal(readDurableState(state.instanceId).rows, 0);
	await refresh(cookie, state.instanceId, { attempt: "success", health: "partial", rows: 4 });
	return { clearedBeforeRepublish: true, items: 4, sameIdentity: true };
}

const phases = { bootstrap, boxset, pagination, recovery, rotation, shapes };
assert.ok(phases[phase], `unknown matrix phase: ${phase ?? "missing"}`);
try {
	const result = await phases[phase]();
	diagnosticMarkStage("phase-complete");
	process.stdout.write(`${JSON.stringify({ phase, status: "pass", ...result })}\n`);
} catch (error) {
	const diagnostic = diagnosticFailure(phase, error);
	process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
	process.exitCode = 1;
	if (
		phase === "bootstrap" &&
		diagnostic.category === "refresh-evidence-rejected" &&
		diagnostic.refresh?.accepted === true &&
		diagnostic.refresh.elapsedMs >= 20_000 &&
		diagnostic.durable?.attempt === "in-progress" &&
		failedRefreshObservation
	) {
		const observation = await failedRefreshObservation();
		process.stdout.write(`${JSON.stringify(observation)}\n`);
	}
	failedRefreshObservation = undefined;
}
