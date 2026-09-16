import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const policyCli = fileURLToPath(new URL("./proxy-policy-cli.mjs", import.meta.url));

function runPolicy(input) {
	const result = spawnSync(process.execPath, [policyCli], {
		encoding: "utf8",
		input: `${JSON.stringify(input)}\n`,
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

describe("Jellyfin authority proxy policy", () => {
	it("forces item inventory requests through more than one real Jellyfin page", () => {
		const result = runPolicy({
			kind: "request",
			mode: "paginate",
			url: "/Users/user-1/Items?ParentId=library-1&StartIndex=0&Limit=1000",
		});

		assert.equal(result.url, "/Users/user-1/Items?ParentId=library-1&StartIndex=0&Limit=1");
	});

	it("rewrites a library inventory to a real BoxSet-only Jellyfin query", () => {
		const result = runPolicy({
			kind: "request",
			mode: "boxset-only",
			url: "/Users/user-1/Items?ParentId=library-1&Fields=ProviderIds&Recursive=true&CollapseBoxSetItems=false&IncludeItemTypes=Movie%2CSeries&StartIndex=0&Limit=1000",
		});

		assert.equal(
			result.url,
			"/Users/user-1/Items?Fields=ProviderIds&Recursive=true&CollapseBoxSetItems=false&IncludeItemTypes=BoxSet&StartIndex=0&Limit=1000",
		);
	});

	it("injects one unknown item type while preserving the real response envelope", () => {
		const result = runPolicy({
			body: {
				Items: [{ Id: "movie-1", Name: "Synthetic Movie", Type: "Movie" }],
				StartIndex: 0,
				TotalRecordCount: 1,
			},
			kind: "response",
			mode: "unknown-type",
			url: "/Users/user-1/Items?ParentId=library-1&StartIndex=0&Limit=1000",
		});

		assert.deepEqual(result.body, {
			Items: [
				{ Id: "movie-1", Name: "Synthetic Movie", Type: "Movie" },
				{ Id: "authority-fixture-unknown", Name: "Synthetic Unknown", Type: "MusicVideo" },
			],
			StartIndex: 0,
			TotalRecordCount: 2,
		});
	});

	it("injects a schema-invalid item without replacing the real response envelope", () => {
		const result = runPolicy({
			body: {
				Items: [{ Id: "movie-1", Name: "Synthetic Movie", Type: "Movie" }],
				StartIndex: 0,
				TotalRecordCount: 1,
			},
			kind: "response",
			mode: "malformed",
			url: "/Users/user-1/Items?ParentId=library-1&StartIndex=0&Limit=1000",
		});

		assert.deepEqual(result.body, {
			Items: [{ Name: "Synthetic Malformed", Type: "Movie" }],
			StartIndex: 0,
			TotalRecordCount: 1,
		});
	});

	it("returns a bounded unavailable response without contacting Jellyfin", () => {
		const result = runPolicy({
			kind: "request",
			mode: "unavailable",
			url: "/Users/user-1/Items?ParentId=library-1&StartIndex=0&Limit=1000",
		});

		assert.deepEqual(result, {
			body: { error: "fixture_unavailable" },
			shortCircuit: true,
			status: 503,
		});
	});
});
