import assert from "node:assert/strict";
import test from "node:test";

import {
	catalogPayload,
	createProxyServer,
	historyPayload,
	isCatalogEndpoint,
	PLEX_FIXTURE_MODES,
	parseControlBody,
	rewriteIdentityPayload,
} from "./plex-loopback-proxy.mjs";

const RUN_TOKEN = "a".repeat(64);

test("proxy exposes only the bounded fixture modes", () => {
	assert.deepEqual(
		[...PLEX_FIXTURE_MODES],
		[
			"normal",
			"paginated-history",
			"paginated-catalog",
			"catalog-failure",
			"identity-override",
			"controlled",
		],
	);
});

test("paginated history conserves two unique source rows across two pages", () => {
	const first = historyPayload("paginated-history", 0).MediaContainer;
	const second = historyPayload("paginated-history", 1).MediaContainer;
	assert.equal(first.totalSize, 2);
	assert.equal(second.totalSize, 2);
	assert.equal(first.offset, 0);
	assert.equal(second.offset, 1);
	assert.equal(first.size, 1);
	assert.equal(second.size, 1);
	assert.notEqual(first.Metadata[0].historyKey, second.Metadata[0].historyKey);
	assert.equal(first.Metadata[0].ratingKey, second.Metadata[0].ratingKey);
});

test("catalog failure targets only section catalog endpoints", () => {
	assert.equal(isCatalogEndpoint("/library/sections/2/all"), true);
	assert.equal(isCatalogEndpoint("/library/sections/2/allLeaves"), false);
	assert.equal(isCatalogEndpoint("/library/sections"), false);
});

test("paginated catalog emits two production-shaped pages only for the exact catalog mode", () => {
	const first = catalogPayload("paginated-catalog", "2", 0).MediaContainer;
	const second = catalogPayload("paginated-catalog", "2", 1).MediaContainer;
	assert.equal(first.totalSize, 2);
	assert.equal(second.totalSize, 2);
	assert.equal(first.offset, 0);
	assert.equal(second.offset, 1);
	assert.equal(first.size, 1);
	assert.equal(second.size, 1);
	assert.notEqual(first.Metadata[0].ratingKey, second.Metadata[0].ratingKey);
	assert.equal(first.Metadata[0].type, "show");
	assert.equal(second.Metadata[0].type, "show");
	assert.deepEqual(first.Metadata[0].Guid, [{ id: "tmdb://81189" }, { id: "tvdb://81189" }]);
	assert.deepEqual(second.Metadata[0].Guid, [{ id: "tmdb://81190" }, { id: "tvdb://81190" }]);
	assert.deepEqual(catalogPayload("normal", "2", 0).MediaContainer.Metadata, []);
});

test("control requires the run token in the request body", () => {
	assert.equal(
		parseControlBody(JSON.stringify({ token: "wrong", mode: "normal" }), RUN_TOKEN),
		null,
	);
	assert.deepEqual(
		parseControlBody(JSON.stringify({ token: RUN_TOKEN, mode: "identity-override" }), RUN_TOKEN),
		{ mode: "identity-override" },
	);
	assert.deepEqual(
		parseControlBody(JSON.stringify({ token: RUN_TOKEN, mode: "paginated-catalog" }), RUN_TOKEN),
		{ mode: "paginated-catalog" },
	);
	assert.equal(
		parseControlBody(JSON.stringify({ token: RUN_TOKEN, mode: "unknown" }), RUN_TOKEN),
		null,
	);
});

test("identity override remains a valid Plex identity shape", () => {
	const identity = rewriteIdentityPayload({
		MediaContainer: { machineIdentifier: "original", version: "1.0" },
	});
	assert.equal(identity.MediaContainer.version, "1.0");
	assert.equal(identity.MediaContainer.machineIdentifier, "lc-e2e-identity-override");
});

test("controlled mode changes only after authenticated internal control", async () => {
	const server = createProxyServer({
		expectedToken: RUN_TOKEN,
		initialMode: "controlled",
		plexPort: 9,
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const url = `http://127.0.0.1:${address.port}/__fixture/control`;
	try {
		const rejected = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "wrong", mode: "catalog-failure" }),
		});
		assert.equal(rejected.status, 403);
		assert.equal(server.fixtureMode(), "controlled");

		const accepted = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: RUN_TOKEN, mode: "paginated-catalog" }),
		});
		assert.equal(accepted.status, 200);
		assert.equal(server.fixtureMode(), "paginated-catalog");
	} finally {
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
