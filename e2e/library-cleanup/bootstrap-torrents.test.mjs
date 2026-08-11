import assert from "node:assert/strict";
import test from "node:test";

import {
	assertHarnessQbitUrl,
	bencode,
	buildTorrent,
	createQbitSession,
	qbitRequest,
	resolveQbitCredentials,
	TORRENT_FIXTURES,
} from "./bootstrap-torrents.mjs";

function response(body, { headers, status = 200 } = {}) {
	return new Response(body, { headers, status });
}

function fetchSequence(responses) {
	const calls = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url, init });
			const next = responses.shift();
			if (!next) throw new Error(`unexpected request to ${url}`);
			return next;
		},
	};
}

test("qBittorrent URLs stay on exact isolated service endpoints", () => {
	assert.equal(
		assertHarnessQbitUrl("http://qbittorrent-a:8080", "qbittorrent-a"),
		"http://qbittorrent-a:8080",
	);
	for (const rejected of [
		"http://localhost:8080",
		"http://192.168.1.10:8080",
		"https://qbittorrent-a:8080",
		"http://user:password@qbittorrent-a:8080",
	]) {
		assert.throws(() => assertHarnessQbitUrl(rejected, "qbittorrent-a"));
	}
});

test("bencode sorts dictionary keys and preserves raw bytes", () => {
	assert.equal(
		bencode({ z: 2, a: Buffer.from([0, 255]) }).toString("hex"),
		"64313a61323a00ff313a7a69326565",
	);
});

test("torrent metainfo and infohash are deterministic", () => {
	const first = buildTorrent("fixture.mkv", Buffer.from("known fixture content"));
	const second = buildTorrent("fixture.mkv", Buffer.from("known fixture content"));
	assert.equal(first.infoHash, second.infoHash);
	assert.deepEqual(first.metainfo, second.metainfo);
	assert.match(first.infoHash, /^[a-f0-9]{40}$/);
	assert.match(first.metainfo.toString("utf8"), /tracker\.invalid/);
});

test("fixture set maps two exact payloads to each isolated qBittorrent", () => {
	assert.equal(TORRENT_FIXTURES.length, 4);
	assert.equal(TORRENT_FIXTURES.filter((item) => item.service === "qbittorrent-a").length, 2);
	assert.equal(TORRENT_FIXTURES.filter((item) => item.service === "qbittorrent-b").length, 2);
	for (const fixture of TORRENT_FIXTURES) {
		assert.match(fixture.sourcePath, /^\/data\/torrents\/(?:radarr|sonarr)-[ab]\//);
	}
});

test("qBittorrent session logs in with disposable credentials and retains the SID", async () => {
	const mock = fetchSequence([
		response("Ok.", { headers: { "set-cookie": "SID=disposable-a; HttpOnly; Path=/" } }),
	]);

	const session = await createQbitSession({
		baseUrl: "http://qbittorrent-a:8080",
		credentials: { username: "bootstrap-a", password: "not-in-error-output" },
		fetchImpl: mock.fetch,
		service: "qbittorrent-a",
	});

	assert.equal(session.sidCookie, "SID=disposable-a");
	assert.equal(mock.calls[0].url, "http://qbittorrent-a:8080/api/v2/auth/login");
	assert.equal(mock.calls[0].init.method, "POST");
	assert.equal(
		mock.calls[0].init.body.toString(),
		"username=bootstrap-a&password=not-in-error-output",
	);
});

test("qBittorrent session rejects a successful login response without a SID cookie", async () => {
	const mock = fetchSequence([response("Ok.")]);

	await assert.rejects(
		createQbitSession({
			baseUrl: "http://qbittorrent-a:8080",
			credentials: { username: "bootstrap-a", password: "secret-password" },
			fetchImpl: mock.fetch,
			service: "qbittorrent-a",
		}),
		(error) =>
			error instanceof Error &&
			error.message ===
				"qbittorrent-a POST /api/v2/auth/login failed with HTTP 200: SID cookie missing" &&
			!error.message.includes("secret-password"),
	);
});

test("qBittorrent session reports refused login status without exposing credentials", async () => {
	for (const status of [401, 403]) {
		const mock = fetchSequence([response("Fails.", { status })]);
		await assert.rejects(
			createQbitSession({
				baseUrl: "http://qbittorrent-a:8080",
				credentials: { username: "bootstrap-a", password: "secret-password" },
				fetchImpl: mock.fetch,
				service: "qbittorrent-a",
			}),
			(error) =>
				error instanceof Error &&
				error.message === `qbittorrent-a POST /api/v2/auth/login failed with HTTP ${status}` &&
				!error.message.includes("secret-password"),
		);
	}
});

test("qBittorrent session sends its SID cookie to info, add, and verification requests", async () => {
	const mock = fetchSequence([
		response("Ok.", { headers: { "set-cookie": "SID=disposable-a; HttpOnly; Path=/" } }),
		response("[]"),
		response("Ok."),
		response("[]"),
	]);
	const session = await createQbitSession({
		baseUrl: "http://qbittorrent-a:8080",
		credentials: { username: "bootstrap-a", password: "secret-password" },
		fetchImpl: mock.fetch,
		service: "qbittorrent-a",
	});

	await qbitRequest(session, "/api/v2/torrents/info?hashes=before-add");
	await qbitRequest(session, "/api/v2/torrents/add", { method: "POST", body: new FormData() });
	await qbitRequest(session, "/api/v2/torrents/info?hashes=after-add");

	for (const call of mock.calls.slice(1)) {
		assert.equal(call.init.headers.Cookie, "SID=disposable-a");
	}
});

test("qBittorrent credentials are isolated by service", () => {
	assert.deepEqual(
		resolveQbitCredentials("qbittorrent-b", {
			QBITTORRENT_B_USERNAME: "bootstrap-b",
			QBITTORRENT_B_PASSWORD: "secret-password",
		}),
		{ username: "bootstrap-b", password: "secret-password" },
	);
	assert.throws(() => resolveQbitCredentials("qbittorrent-a", {}), /QBITTORRENT_A_USERNAME/);
});
