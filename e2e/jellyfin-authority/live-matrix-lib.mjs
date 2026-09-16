import assert from "node:assert/strict";

export const EXPECTED_JELLYFIN_VERSION = "10.11.11";

export function validateFixtureIdentity(project, runToken) {
	assert.match(project ?? "", /^jf-authority-[a-z0-9-]+$/);
	assert.match(runToken ?? "", /^[a-f0-9]{64}$/);
}

export function firstCookie(headers) {
	const value = headers.get("set-cookie");
	assert.ok(value, "dashboard authentication did not return a session cookie");
	return value.split(";", 1)[0];
}

export function assertExactJellyfinVersion(info) {
	assert.equal(info?.Version, EXPECTED_JELLYFIN_VERSION);
}

export function assertCacheEvidence({ db, health, expected }) {
	assert.equal(db.rows, expected.rows, "unexpected durable Jellyfin cache row count");
	assert.equal(db.statusRows, 1, "expected one durable Jellyfin cache status row");
	assert.equal(db.itemCount, expected.rows, "durable status count diverged from cache rows");
	assert.equal(db.lastResult, "success", "last published generation must remain successful");
	assert.equal(db.lastAttemptResult, expected.attempt, "unexpected durable attempt state");
	assert.equal(health.cacheType, "jellyfin");
	assert.equal(health.lastResult, expected.health);
	assert.equal(health.itemCount, expected.health === "error" ? null : expected.rows);
	assert.equal(health.isStale, false);
	assert.equal(db.connectionGeneration, db.statusConnectionGeneration);
	assert.equal(db.identityGeneration, db.statusIdentityGeneration);
	if (expected.rows > 0) {
		assert.equal(db.connectionGeneration, db.rowConnectionGeneration);
		assert.equal(db.identityGeneration, db.rowIdentityGeneration);
	}
}

export function assertOwnedResources(resources, project, runToken) {
	validateFixtureIdentity(project, runToken);
	for (const resource of resources) {
		assert.equal(resource.project, project, `refusing unowned ${resource.kind}`);
		assert.equal(resource.runToken, runToken, `refusing mismatched ${resource.kind}`);
	}
}
