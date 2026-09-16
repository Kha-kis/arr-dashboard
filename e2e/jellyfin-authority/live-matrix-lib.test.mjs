import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertCacheEvidence,
	assertExactJellyfinVersion,
	assertOwnedResources,
	firstCookie,
	validateFixtureIdentity,
} from "./live-matrix-lib.mjs";

describe("Jellyfin authority live-matrix assertions", () => {
	it("requires the exact real Jellyfin version", () => {
		assert.doesNotThrow(() => assertExactJellyfinVersion({ Version: "10.11.11" }));
		assert.throws(() => assertExactJellyfinVersion({ Version: "10.11.10" }));
	});

	it("correlates API health with durable current-generation rows", () => {
		assert.doesNotThrow(() =>
			assertCacheEvidence({
				db: {
					connectionGeneration: 2,
					identityGeneration: 1,
					itemCount: 4,
					lastAttemptResult: "success",
					lastResult: "success",
					rowConnectionGeneration: 2,
					rowIdentityGeneration: 1,
					rows: 4,
					statusConnectionGeneration: 2,
					statusIdentityGeneration: 1,
					statusRows: 1,
				},
				expected: { attempt: "success", health: "success", rows: 4 },
				health: {
					cacheType: "jellyfin",
					isStale: false,
					itemCount: 4,
					lastResult: "success",
				},
			}),
		);
	});

	it("uses the durable status generation for an authoritative empty publication", () => {
		assert.doesNotThrow(() =>
			assertCacheEvidence({
				db: {
					connectionGeneration: 3,
					identityGeneration: 1,
					itemCount: 0,
					lastAttemptResult: "success",
					lastResult: "success",
					rowConnectionGeneration: null,
					rowIdentityGeneration: null,
					rows: 0,
					statusConnectionGeneration: 3,
					statusIdentityGeneration: 1,
					statusRows: 1,
				},
				expected: { attempt: "success", health: "success", rows: 0 },
				health: {
					cacheType: "jellyfin",
					isStale: false,
					itemCount: 0,
					lastResult: "success",
				},
			}),
		);
	});

	it("accepts only strongly scoped teardown ownership", () => {
		const project = "jf-authority-model-test";
		const token = "a".repeat(64);
		validateFixtureIdentity(project, token);
		assert.doesNotThrow(() =>
			assertOwnedResources([{ kind: "volume", project, runToken: token }], project, token),
		);
		assert.throws(() =>
			assertOwnedResources([{ kind: "volume", project, runToken: "b".repeat(64) }], project, token),
		);
	});

	it("extracts only the cookie pair used by subsequent requests", () => {
		const headers = new Headers({ "set-cookie": "session=synthetic; Path=/; HttpOnly" });
		assert.equal(firstCookie(headers), "session=synthetic");
	});
});
