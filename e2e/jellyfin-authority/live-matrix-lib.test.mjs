import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertCacheEvidence,
	assertExactJellyfinVersion,
	assertOwnedResources,
	firstCookie,
	validateFixtureIdentity,
	waitForFreshJellyfinCache,
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

const runningMarker = "in_progress:00000000-0000-4000-8000-000000000001";
const expected = { attempt: "success", health: "success", rows: 4 };
const prior = {
	rows: 4,
	statusRows: 1,
	itemCount: 4,
	lastResult: "success",
	lastAttemptResult: "success",
	connectionGeneration: 2,
	identityGeneration: 1,
	statusConnectionGeneration: 2,
	statusIdentityGeneration: 1,
	rowConnectionGeneration: 2,
	rowIdentityGeneration: 1,
	lastAttemptAt: 1000,
	lastRefreshedAt: 1000,
	generationId: "prior-generation",
	publicationAttemptStartedAt: 500,
	publicationObservedAt: 1000,
};
const running = { ...prior, lastAttemptAt: 2000, lastAttemptResult: runningMarker };
const published = {
	...prior,
	lastAttemptAt: 3000,
	lastRefreshedAt: 3000,
	generationId: "new-generation",
	publicationAttemptStartedAt: 2000,
	publicationObservedAt: 3000,
};
const failed = { ...prior, lastAttemptAt: 2000, lastAttemptResult: "error" };
const healthy = { cacheType: "jellyfin", isStale: false, itemCount: 4, lastResult: "success" };
const absent = {
	...prior,
	rows: 0,
	statusRows: 0,
	itemCount: null,
	lastResult: null,
	lastAttemptAt: null,
	lastAttemptResult: null,
	lastRefreshedAt: null,
	generationId: null,
	publicationAttemptStartedAt: null,
	publicationObservedAt: null,
};

function scenario({
	baseline = prior,
	polls = [published],
	health = healthy,
	acceptance = { status: 202, body: { status: "accepted", cacheType: "jellyfin" } },
	want = expected,
	onPause,
	onHealth,
} = {}) {
	let clock = 0;
	let submittedSignal;
	const calls = { submits: 0, durable: 0, health: 0, pauses: 0 };
	const options = {
		expected: want,
		timeoutMs: 40,
		pollMs: 10,
		now: () => clock,
		readDurable: () => {
			const index = calls.durable++;
			return structuredClone(index === 0 ? baseline : polls[Math.min(index - 1, polls.length - 1)]);
		},
		submit: async ({ signal }) => {
			calls.submits++;
			submittedSignal = signal;
			return acceptance;
		},
		readHealth: async ({ signal }) => {
			calls.health++;
			assert.equal(signal, submittedSignal);
			onHealth?.();
			return structuredClone(health);
		},
		pause: async (ms, { signal }) => {
			assert.equal(signal, submittedSignal);
			calls.pauses++;
			onPause?.(calls);
			clock += ms;
		},
	};
	return { calls, options, run: () => waitForFreshJellyfinCache(options) };
}

describe("fresh asynchronous Jellyfin refresh completion", () => {
	it("waits through acceptance, old success and the same running attempt", async () => {
		const s = scenario({
			polls: [prior, running, running, published],
			onPause: (calls) => assert.equal(calls.health, 0),
		});
		assert.equal(await s.run(), undefined);
		assert.equal(s.calls.submits, 1);
		assert.equal(s.calls.pauses, 3);
		assert.equal(s.calls.health, 1);
	});
	it("permits start-to-completion timestamp change only with matching receipt", async () => {
		const s = scenario({ polls: [running, published] });
		await s.run();
		assert.equal(s.calls.pauses, 1);
		assert.equal(s.calls.submits, 1);
	});
	it("accepts a fresh receipt-backed terminal success before the first poll", async () => {
		const s = scenario();
		await s.run();
		assert.equal(s.calls.health, 1);
		assert.equal(s.calls.pauses, 0);
	});
	it("accepts an authoritative empty fresh publication", async () => {
		const s = scenario({
			polls: [
				{
					...published,
					rows: 0,
					itemCount: 0,
					rowConnectionGeneration: null,
					rowIdentityGeneration: null,
				},
			],
			health: { ...healthy, itemCount: 0 },
			want: { ...expected, rows: 0 },
		});
		await s.run();
		assert.equal(s.calls.health, 1);
	});
	it("accepts retained four-row publication with fresh error and actual partial health", async () => {
		const s = scenario({
			polls: [running, failed],
			health: { ...healthy, lastResult: "partial" },
			want: { attempt: "error", health: "partial", rows: 4 },
		});
		await s.run();
		assert.equal(s.calls.health, 1);
	});
	it("accepts ISO timestamps correlated with numeric SQLite baseline timestamps", async () => {
		const iso = (value) => new Date(value).toISOString();
		const s = scenario({
			polls: [
				{ ...running, lastAttemptAt: iso(2000) },
				{
					...published,
					lastAttemptAt: iso(3000),
					lastRefreshedAt: iso(3000),
					publicationAttemptStartedAt: iso(2000),
					publicationObservedAt: iso(3000),
				},
			],
		});
		await s.run();
		assert.equal(s.calls.health, 1);
	});
	it("allows no prior attempt but still requires fresh publication proof", async () => {
		const s = scenario({ baseline: absent });
		await s.run();
		assert.equal(s.calls.health, 1);
	});
	for (const [name, acceptance] of [
		["old synchronous HTTP200", { status: 200, body: { success: true, errors: 0, upserted: 4 } }],
		["rate limited HTTP429", { status: 429, body: {} }],
		["malformed acceptance", { status: 202, body: null }],
		["wrong provider", { status: 202, body: { status: "accepted", cacheType: "plex" } }],
		["rejected admission", { status: 202, body: { status: "rejected", cacheType: "jellyfin" } }],
	])
		it(`refuses ${name} without another submission`, async () => {
			const s = scenario({ acceptance });
			await assert.rejects(s.run());
			assert.equal(s.calls.submits, 1);
			assert.equal(s.calls.health, 0);
		});
	for (const [name, polls] of [
		["unchanged success and row count", [prior]],
		["accepted but still running", [running]],
		["no first attempt", [absent]],
		["missing attempt status", [{ ...prior, lastAttemptResult: null }]],
	])
		it(`times out on ${name} instead of claiming completion`, async () => {
			const s = scenario({ polls });
			await assert.rejects(s.run());
			assert.equal(s.calls.submits, 1);
			assert.equal(s.calls.health, 0);
			assert.ok(s.calls.pauses > 0);
		});
	it("refuses a baseline already in progress before submitting", async () => {
		const s = scenario({ baseline: running });
		await assert.rejects(s.run());
		assert.equal(s.calls.submits, 0);
	});
	it("does not reuse an unchanged old error for a newly accepted fault scenario", async () => {
		const s = scenario({
			baseline: failed,
			polls: [failed],
			want: { attempt: "error", health: "partial", rows: 4 },
			health: { ...healthy, lastResult: "partial" },
		});
		await assert.rejects(s.run());
		assert.equal(s.calls.submits, 1);
		assert.equal(s.calls.health, 0);
		assert.ok(s.calls.pauses > 0);
	});
	it("rejects a terminal status missing its attempt timestamp immediately", async () => {
		const s = scenario({ polls: [{ ...published, lastAttemptAt: null }, published] });
		await assert.rejects(s.run());
		assert.equal(s.calls.pauses, 0);
		assert.equal(s.calls.health, 0);
	});
	for (const [name, patch] of [
		["multiple status rows", { statusRows: 2 }],
		["invalid timestamp", { lastAttemptAt: "not-a-date" }],
		["nonfinite timestamp", { lastAttemptAt: Infinity }],
		["unsupported state", { lastAttemptResult: "done" }],
	])
		it(`refuses ${name}`, async () => {
			const s = scenario({ polls: [{ ...published, ...patch }] });
			await assert.rejects(s.run());
			assert.equal(s.calls.submits, 1);
		});
	for (const [name, replacement] of [
		["running start", { ...running, lastAttemptAt: 2001 }],
		[
			"running marker",
			{ ...running, lastAttemptResult: "in_progress:00000000-0000-4000-8000-000000000002" },
		],
		["terminal receipt start", { ...published, publicationAttemptStartedAt: 2001 }],
	])
		it(`refuses replaced ${name} after pinning`, async () => {
			const s = scenario({ polls: [running, replacement, published] });
			await assert.rejects(s.run());
			assert.equal(s.calls.health, 0);
			assert.equal(s.calls.submits, 1);
		});
	for (const [name, patch] of [
		["stale receipt start", { publicationAttemptStartedAt: 1000 }],
		["missing receipt start", { publicationAttemptStartedAt: null }],
		["wrong receipt observation", { publicationObservedAt: 2999 }],
		["wrong refreshed timestamp", { lastRefreshedAt: 2999 }],
		["completion before start", { publicationAttemptStartedAt: 3001 }],
		["unchanged generation", { generationId: "prior-generation" }],
		["missing generation", { generationId: null }],
	])
		it(`refuses terminal success with ${name}`, async () => {
			const s = scenario({ polls: [{ ...published, ...patch }, published] });
			await assert.rejects(s.run());
			assert.equal(s.calls.health, 0);
		});
	it("fails unexpected terminal error immediately rather than accepting later recovery", async () => {
		const s = scenario({ polls: [failed, published] });
		await assert.rejects(s.run());
		assert.equal(s.calls.submits, 1);
		assert.equal(s.calls.pauses, 0);
	});
	for (const [name, patch] of [
		["changed generation", { generationId: "new-generation" }],
		["new success receipt", { publicationAttemptStartedAt: 2000, publicationObservedAt: 3000 }],
	])
		it(`refuses failed retention with ${name}`, async () => {
			const s = scenario({
				polls: [{ ...failed, ...patch }],
				want: { attempt: "error", health: "partial", rows: 4 },
				health: { ...healthy, lastResult: "partial" },
			});
			await assert.rejects(s.run());
			assert.equal(s.calls.health, 0);
		});
	for (const [name, dbPatch, healthPatch] of [
		["wrong row count", { rows: 3 }, {}],
		["wrong durable count", { itemCount: 3 }, {}],
		["wrong row generation", { rowConnectionGeneration: 1 }, {}],
		["wrong status generation", { statusIdentityGeneration: 2 }, {}],
		["unhealthy API", {}, { lastResult: "error" }],
		["stale API", {}, { isStale: true }],
		["wrong API count", {}, { itemCount: 3 }],
	])
		it(`fails terminal ${name} without polling for unrelated success`, async () => {
			const s = scenario({
				polls: [{ ...published, ...dbPatch }],
				health: { ...healthy, ...healthPatch },
			});
			await assert.rejects(s.run());
			assert.equal(s.calls.submits, 1);
			assert.equal(s.calls.pauses, 0);
		});
	it("refuses an attempt replaced while actual health is being read", async () => {
		const s = scenario({ polls: [published, { ...running, lastAttemptAt: 4000 }] });
		await assert.rejects(s.run());
		assert.equal(s.calls.health, 1);
	});
	for (const stage of ["submit", "readHealth"])
		it(`cancels hanging ${stage} at the shared deadline`, async () => {
			const s = scenario();
			let observedAbort = false;
			s.options.timeoutMs = 15;
			s.options[stage] = ({ signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							observedAbort = true;
							reject(new Error("synthetic private failure"));
						},
						{ once: true },
					);
				});
			await assert.rejects(
				s.run(),
				(error) => error.message === "Jellyfin refresh completion evidence rejected",
			);
			assert.equal(observedAbort, true);
		});
	it("redacts callback failures instead of retaining private details", async () => {
		const s = scenario();
		s.options.submit = async () => {
			throw new Error("synthetic private failure");
		};
		await assert.rejects(
			s.run(),
			(error) => error.message === "Jellyfin refresh completion evidence rejected",
		);
	});
});
