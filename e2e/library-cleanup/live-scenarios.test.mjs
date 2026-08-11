#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { ARR_FIXTURES, fixtureLibraryPath } from "./bootstrap-arr.mjs";
import { ARR } from "./live-scenarios.mjs";

test("live deletion assertions use the exact bootstrap fixture paths", () => {
	const livePaths = new Map(
		Object.values(ARR).map((fixture) => [fixture.baseUrl, fixture.libraryPath]),
	);
	assert.equal(livePaths.size, ARR_FIXTURES.length);
	for (const fixture of ARR_FIXTURES) {
		assert.equal(livePaths.get(fixture.baseUrl), fixtureLibraryPath(fixture), fixture.service);
	}
});
