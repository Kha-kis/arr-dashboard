import assert from "node:assert/strict";
import { it } from "node:test";
import { waitForFreshJellyfinCache, projectJellyfinLibraryEvidence } from "./live-matrix-lib.mjs";
import { normalizeDiagnostic } from "./diagnostic-policy.mjs";
const prior = {
	statusRows: 1,
	rows: 1,
	itemCount: 1,
	lastResult: "success",
	lastAttemptResult: "success",
	lastAttemptAt: 1000,
	lastRefreshedAt: 1000,
	publicationAttemptStartedAt: 500,
	publicationObservedAt: 1000,
	generationId: "previous",
	connectionGeneration: 1,
	identityGeneration: 1,
	statusConnectionGeneration: 1,
	statusIdentityGeneration: 1,
	rowConnectionGeneration: 1,
	rowIdentityGeneration: 1,
};
const fresh = {
	...prior,
	lastAttemptAt: 3000,
	lastRefreshedAt: 3000,
	publicationAttemptStartedAt: 2000,
	publicationObservedAt: 3000,
	generationId: "next",
};
async function rejectAt({
	health = {
		cacheType: "jellyfin",
		lastResult: "success",
		itemCount: "private-actual-sentinel",
		isStale: false,
	},
	onRejected = () => {},
	readHealth,
} = {}) {
	let reads = 0;
	await assert.rejects(
		waitForFreshJellyfinCache({
			submit: async () => ({ status: 202, body: { status: "accepted", cacheType: "jellyfin" } }),
			readDurable: () => (reads++ === 0 ? prior : fresh),
			readHealth: readHealth ?? (async () => health),
			expected: { attempt: "success", health: "success", rows: 1 },
			onRejected,
		}),
		{ message: "Jellyfin refresh completion evidence rejected" },
	);
}
it("reports an assertion site without its values, message, path or stack", async () => {
	let result;
	await rejectAt({
		onRejected: (value) => {
			result = value;
		},
	});
	assert.equal(result?.kind, "assertion");
	assert.deepEqual(Object.keys(result).sort(), ["kind", "line"]);
	assert(Number.isSafeInteger(result.line) && result.line > 0 && result.line <= 10000);
	assert(!JSON.stringify(result).includes("private-actual-sentinel"));
	assert(!JSON.stringify(result).includes("/"));
});
it("distinguishes separate assertion sites without exposing actual inputs", async () => {
	const sites = [];
	await rejectAt({ onRejected: (v) => sites.push(v.line) });
	await rejectAt({
		health: { cacheType: "jellyfin", lastResult: "error", itemCount: 1, isStale: false },
		onRejected: (v) => sites.push(v.line),
	});
	assert.equal(sites.length, 2);
	assert.notEqual(sites[0], sites[1]);
});
it("does not let diagnostic observer failure change the rejection contract", async () => {
	let called = false;
	await rejectAt({
		onRejected: () => {
			called = true;
			throw new Error("private-observer-sentinel");
		},
	});
	assert(called);
});
it("never returns provider exception text or its invented stack location", async () => {
	let result;
	const error = new Error("private-provider-sentinel");
	error.stack = "private-provider-sentinel\n at provider (/private/provider:777:1)";
	await rejectAt({
		readHealth: async () => {
			throw error;
		},
		onRejected: (v) => {
			result = v;
		},
	});
	assert.deepEqual(result, { kind: "other", line: null });
});
it("does not call the rejection observer on successful evidence", async () => {
	let calls = 0,
		reads = 0;
	await waitForFreshJellyfinCache({
		submit: async () => ({ status: 202, body: { status: "accepted", cacheType: "jellyfin" } }),
		readDurable: () => (reads++ === 0 ? prior : fresh),
		readHealth: async () => ({
			cacheType: "jellyfin",
			lastResult: "success",
			itemCount: 1,
			isStale: false,
		}),
		expected: { attempt: "success", health: "success", rows: 1 },
		onRejected: () => calls++,
	});
	assert.equal(calls, 0);
});
it("categorizes malformed publication metadata without echoing it", () => {
	let reason;
	assert.equal(
		projectJellyfinLibraryEvidence("private-metadata-sentinel", {}, (r) => {
			reason = r;
		}),
		null,
	);
	assert.equal(reason, "metadata");
});
it("categorizes schema rejection independently of schema error details", () => {
	let reason;
	const value = {
		version: 1,
		provider: "jellyfin",
		cacheType: "jellyfin",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: 1,
		connectionGeneration: 1,
		identityGeneration: 1,
		contentFingerprint: "a".repeat(64),
	};
	assert.equal(
		projectJellyfinLibraryEvidence(
			value,
			{ safeParse: () => ({ success: false, error: "private-schema-sentinel" }) },
			(r) => {
				reason = r;
			},
		),
		null,
	);
	assert.equal(reason, "schema");
});
it("normalizes only bounded rejection sites and publication categories", () => {
	const base = {
		diagnostic: true,
		phase: "bootstrap",
		status: "FAIL",
		stage: "refresh-durable-read",
		category: "refresh-evidence-rejected",
		httpStatus: null,
		durable: {
			statusRows: 1,
			rows: 4,
			itemCount: 4,
			attempt: "success",
			hasAttemptAt: true,
			hasRefreshedAt: true,
			hasReceiptStart: true,
			hasReceiptObserved: true,
			hasGeneration: true,
			publicationCheck: "mapping",
		},
		health: null,
		refresh: null,
		rejection: { kind: "assertion", line: 200 },
	};
	assert.deepEqual(normalizeDiagnostic(base), base);
	for (const change of [
		(v) => {
			v.rejection.line = -1;
		},
		(v) => {
			v.rejection.line = 10001;
		},
		(v) => {
			v.rejection.kind = "private-kind";
		},
		(v) => {
			v.rejection.stack = "private-stack";
		},
		(v) => {
			v.durable.publicationCheck = "private-metadata";
		},
	]) {
		const v = structuredClone(base);
		change(v);
		assert.equal(normalizeDiagnostic(v), null);
	}
});
