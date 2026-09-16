import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
	assertCacheEvidence,
	assertExactJellyfinVersion,
	firstCookie,
} from "./live-matrix-lib.mjs";

const phase = process.argv[2];
const dashboardBase = process.env.DASHBOARD_API_BASE ?? "http://dashboard:3001";
const dashboardDbPath = process.env.DASHBOARD_DB_PATH ?? "/dashboard-config/prod.db";
const jellyfinBase = process.env.JELLYFIN_BASE ?? "http://jellyfin:8096";
const proxyBase = process.env.JELLYFIN_PROXY_BASE ?? "http://jellyfin-proxy:18096";
const statePath = process.env.JF_AUTHORITY_STATE_PATH ?? "/fixture-state/state.json";
const runToken = process.env.JF_AUTHORITY_RUN_TOKEN ?? "";
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
	const publicInfo = (await jsonRequest(`${jellyfinBase}/System/Info/Public`)).body;
	assertExactJellyfinVersion(publicInfo);
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
	await mkdir(new URL(".", `file://${statePath}`).pathname, { recursive: true });
	await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	await chmod(statePath, 0o600);
}

function readDurableState(instanceId) {
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
				'SELECT COUNT(*) AS statusRows, MIN("itemCount") AS itemCount, MIN("lastResult") AS lastResult, MIN("lastAttemptResult") AS lastAttemptResult, MIN("connectionGeneration") AS statusConnectionGeneration, MIN("identityGeneration") AS statusIdentityGeneration FROM cache_refresh_status WHERE "instanceId" = ? AND "cacheType" = ?',
			)
			.get(instanceId, "jellyfin");
		return { ...instance, ...cache, ...status };
	} finally {
		database.close();
	}
}

async function setMode(mode) {
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

async function healthFor(cookie, instanceId) {
	const { body } = await dashboardRequest(cookie, "/api/jellyfin/cache/health");
	const item = body.items.find(
		(entry) => entry.instanceId === instanceId && entry.cacheType === "jellyfin",
	);
	assert.ok(item, "missing Jellyfin cache health item");
	return item;
}

async function refresh(cookie, instanceId) {
	return (
		await dashboardRequest(cookie, `/api/jellyfin/cache/${instanceId}/refresh`, { method: "POST" })
	).body;
}

async function assertState(cookie, instanceId, expected) {
	await waitFor(
		async () => {
			try {
				assertCacheEvidence({
					db: readDurableState(instanceId),
					expected,
					health: await healthFor(cookie, instanceId),
				});
				return true;
			} catch {
				return false;
			}
		},
		`dashboard ${expected.health} cache state`,
		20_000,
	);
}

async function bootstrap() {
	const jellyfin = await setupJellyfin();
	const cookie = await dashboardCookie();
	const services = (await dashboardRequest(cookie, "/api/services")).body.services;
	let instance = services.find((entry) => entry.service === "jellyfin");
	if (!instance) {
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
		instance = (
			await dashboardRequest(cookie, `/api/services/${instance.id}`, {
				body: JSON.stringify({ apiKey: jellyfin.token }),
				method: "PUT",
			})
		).body.service;
	}
	await setMode("normal");
	assert.deepEqual(await refresh(cookie, instance.id), { errors: 0, success: true, upserted: 4 });
	await assertState(cookie, instance.id, { attempt: "success", health: "success", rows: 4 });
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
	assert.deepEqual(await refresh(cookie, state.instanceId), {
		errors: 0,
		success: true,
		upserted: 0,
	});
	await assertState(cookie, state.instanceId, { attempt: "success", health: "success", rows: 0 });
	return { authenticBoxSets: true, items: 0 };
}

async function pagination() {
	const state = await readState();
	const cookie = await dashboardCookie();
	await setMode("paginate");
	assert.deepEqual(await refresh(cookie, state.instanceId), {
		errors: 0,
		success: true,
		upserted: 4,
	});
	await assertState(cookie, state.instanceId, { attempt: "success", health: "success", rows: 4 });
	const stats = (await jsonRequest(`${proxyBase}/__fixture/status`)).body;
	assert.ok(stats.itemInventoryRequests >= 4);
	return { itemInventoryRequests: stats.itemInventoryRequests, items: 4 };
}

async function shapes() {
	const state = await readState();
	const cookie = await dashboardCookie();
	await setMode("unknown-type");
	const unknown = await refresh(cookie, state.instanceId);
	assert.equal(unknown.success, false);
	await assertState(cookie, state.instanceId, { attempt: "error", health: "partial", rows: 4 });
	await setMode("malformed");
	const malformed = await refresh(cookie, state.instanceId);
	assert.equal(malformed.success, false);
	assert.ok(malformed.errors > 0);
	await assertState(cookie, state.instanceId, { attempt: "error", health: "partial", rows: 4 });
	return { lastGoodItems: 4, malformedRejected: true, unknownRejected: true };
}

async function recovery() {
	const state = await readState();
	const cookie = await dashboardCookie();
	await setMode("unavailable");
	assert.equal((await refresh(cookie, state.instanceId)).success, false);
	await assertState(cookie, state.instanceId, { attempt: "error", health: "partial", rows: 4 });
	await setMode("normal");
	assert.deepEqual(await refresh(cookie, state.instanceId), {
		errors: 0,
		success: true,
		upserted: 4,
	});
	await assertState(cookie, state.instanceId, { attempt: "success", health: "success", rows: 4 });
	return { recovered: true, retainedItems: 4 };
}

async function rotation() {
	const state = await readState();
	const cookie = await dashboardCookie();
	await dashboardRequest(cookie, `/api/services/${state.instanceId}`, {
		body: JSON.stringify({ baseUrl: "http://jellyfin-proxy-rotated:18096" }),
		method: "PUT",
	});
	assert.equal(readDurableState(state.instanceId).rows, 0);
	assert.deepEqual(await refresh(cookie, state.instanceId), {
		errors: 0,
		success: true,
		upserted: 4,
	});
	await assertState(cookie, state.instanceId, { attempt: "success", health: "success", rows: 4 });
	return { clearedBeforeRepublish: true, items: 4, sameIdentity: true };
}

const phases = { bootstrap, boxset, pagination, recovery, rotation, shapes };
assert.ok(phases[phase], `unknown matrix phase: ${phase ?? "missing"}`);
const result = await phases[phase]();
process.stdout.write(`${JSON.stringify({ phase, status: "pass", ...result })}\n`);
