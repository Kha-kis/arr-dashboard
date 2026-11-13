import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import * as lib from "./live-matrix-lib.mjs";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const schema = require("@arr/shared").providerCoverageReceiptV2Schema;
const at = "2026-10-01T00:00:00.000Z";
const unit = (count = 4) => ({
	scopeKey: "fixture-scope",
	expectedRawCount: count,
	pagesAttempted: 1,
	pagesCompleted: 1,
	rawObserved: count,
	sourceBindings: count,
	canonicalEntities: count,
	acceptedSkips: [],
	fatalCount: 0,
});
function metadata(count = 4) {
	return {
		version: 1,
		provider: "jellyfin",
		cacheType: "jellyfin",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: count,
		connectionGeneration: 2,
		identityGeneration: 3,
		contentFingerprint: "a".repeat(64),
		coverageReceipt: {
			version: 2,
			provider: "jellyfin",
			attemptStartedAt: at,
			observedAt: at,
			evidence: "complete",
			units: [unit(count)],
			publishedCanonicalEntities: count,
			domains: [
				{
					domain: "library-inventory",
					evidence: "complete",
					valueSemantics: "exact",
					units: [unit(count)],
				},
				{
					domain: "mapping",
					evidence: "complete",
					valueSemantics: "exact",
					units: [unit(count)],
					publishedCanonicalEntities: count,
				},
				{
					domain: "watch-count",
					evidence: "unknown",
					valueSemantics: "unknown",
					units: [{ ...unit(0), expectedRawCount: null }],
				},
				{
					domain: "watch-attribution",
					evidence: "unknown",
					valueSemantics: "unknown",
					units: [{ ...unit(0), expectedRawCount: null }],
				},
				{ domain: "on-deck", evidence: "complete", valueSemantics: "exact", units: [unit(0)] },
			],
		},
	};
}
const project = (value) => {
	assert.equal(typeof lib.projectJellyfinLibraryEvidence, "function");
	return lib.projectJellyfinLibraryEvidence(value, schema);
};
const limitedProfile = "unsupported-object-positive-v2";
function limitedMetadata() {
	const m = metadata();
	m.publicationLevel = "positive-only";
	m.completeness = "partial";
	m.coverageReceipt.evidence = "positive-only";
	m.coverageReceipt.units[0] = {
		...unit(5),
		sourceBindings: 4,
		canonicalEntities: 4,
		acceptedSkips: [{ reason: "unsupported-provider-object", count: 1 }],
	};
	const d = m.coverageReceipt.domains[0];
	d.evidence = "unknown";
	d.valueSemantics = "unknown";
	d.units = [{ ...m.coverageReceipt.units[0], fatalCount: 1 }];
	return m;
}
const projectLimited = (m) =>
	lib.projectJellyfinLibraryEvidence(m, schema, undefined, limitedProfile);
function scenario({ count = 4, attempt = "success" } = {}) {
	return {
		db: {
			rows: count,
			statusRows: 1,
			itemCount: count,
			lastResult: "success",
			lastAttemptResult: attempt,
			connectionGeneration: 2,
			identityGeneration: 3,
			statusConnectionGeneration: 2,
			statusIdentityGeneration: 3,
			rowConnectionGeneration: count ? 2 : null,
			rowIdentityGeneration: count ? 3 : null,
			publicationEvidence: {
				valid: true,
				version: 2,
				itemCount: count,
				connectionGeneration: 2,
				identityGeneration: 3,
				inventoryExact: true,
				mappingExact: true,
				onDeckExact: true,
				watchCount: "unknown",
				watchAttribution: "unknown",
			},
		},
		expected: {
			attempt,
			health: attempt === "error" ? "error" : "partial",
			rows: count,
			publicationProfile: "domain-bounded-v2",
		},
		health: {
			instanceId: "fixture-instance",
			cacheType: "jellyfin",
			isStale: false,
			itemCount: null,
			observedItemCount: count,
			lastResult: attempt === "error" ? "error" : "partial",
			providerStatus: {
				availability: attempt === "error" ? "last-known" : "partial",
				sources: [
					{
						instanceId: "fixture-instance",
						service: "jellyfin",
						cacheType: "jellyfin",
						status: {
							availability: attempt === "error" ? "last-known" : "partial",
							evidence: "partial",
							latestAttempt: attempt === "error" ? "failed" : "successful",
							reasonCodes:
								attempt === "error"
									? ["coverage-incomplete", "refresh-failed"]
									: ["coverage-incomplete"],
						},
					},
				],
			},
		},
	};
}
describe("explicit unsupported-object positive fixture contract", () => {
	const limitedScenario = (attempt = "success") => {
		const s = scenario({ attempt });
		s.expected.publicationProfile = limitedProfile;
		s.db.publicationEvidence.inventoryExact = false;
		const status = s.health.providerStatus.sources[0].status;
		status.evidence = "positive-only";
		status.reasonCodes.push("positive-only", "accepted-skips");
		return s;
	};
	for (const attempt of ["success", "error"])
		it(`admits truthful limited publication ${attempt} without authority`, () =>
			assert.doesNotThrow(() => lib.assertCacheEvidence(limitedScenario(attempt))));
	it("projects known unsupported coverage without promoting inventory authority", () =>
		assert.deepEqual(projectLimited(limitedMetadata()), {
			valid: true,
			version: 2,
			itemCount: 4,
			connectionGeneration: 2,
			identityGeneration: 3,
			inventoryExact: false,
			mappingExact: true,
			onDeckExact: true,
			watchCount: "unknown",
			watchAttribution: "unknown",
		}));
	it("keeps the default authoritative projection closed to limited metadata", () =>
		assert.equal(project(limitedMetadata()), null));
	for (const [name, change] of [
		[
			"invented complete inventory",
			(s) => {
				s.db.publicationEvidence.inventoryExact = true;
			},
		],
		[
			"exact aggregate evidence",
			(s) => {
				s.health.providerStatus.sources[0].status.evidence = "complete";
			},
		],
		[
			"missing positive-only reason",
			(s) => {
				s.health.providerStatus.sources[0].status.reasonCodes =
					s.health.providerStatus.sources[0].status.reasonCodes.filter(
						(r) => r !== "positive-only",
					);
			},
		],
		[
			"wrong observed count",
			(s) => {
				s.health.observedItemCount = 3;
			},
		],
		[
			"foreign source",
			(s) => {
				s.health.providerStatus.sources[0].instanceId = "foreign";
			},
		],
		[
			"wrong metadata generation",
			(s) => {
				s.db.publicationEvidence.connectionGeneration = 3;
			},
		],
		[
			"wrong status generation",
			(s) => {
				s.db.statusConnectionGeneration = 3;
			},
		],
		[
			"wrong row generation",
			(s) => {
				s.db.rowIdentityGeneration = 99;
			},
		],
		[
			"stale result",
			(s) => {
				s.health.isStale = true;
			},
		],
		[
			"unexpected reason",
			(s) => {
				s.health.providerStatus.sources[0].status.reasonCodes.push("provider-limit");
			},
		],
		[
			"empty limited inventory",
			(s) => {
				s.expected.rows =
					s.db.rows =
					s.db.itemCount =
					s.db.publicationEvidence.itemCount =
					s.health.observedItemCount =
						0;
			},
		],
	])
		it(`rejects ${name}`, () => {
			const s = limitedScenario();
			change(s);
			assert.throws(() => lib.assertCacheEvidence(s));
		});
	for (const [name, change] of [
		[
			"authoritative discriminator",
			(m) => {
				m.publicationLevel = "authoritative";
				m.completeness = "complete";
			},
		],
		[
			"complete receipt",
			(m) => {
				m.coverageReceipt.evidence = "complete";
			},
		],
		[
			"no unsupported objects",
			(m) => {
				m.coverageReceipt.units = [unit(4)];
				m.coverageReceipt.domains[0].units = [unit(4)];
			},
		],
		[
			"unaccounted core count",
			(m) => {
				m.coverageReceipt.units[0].sourceBindings = 3;
			},
		],
		[
			"wrong fatal accounting",
			(m) => {
				m.coverageReceipt.domains[0].units[0].fatalCount = 0;
			},
		],
		[
			"invented exact inventory",
			(m) => {
				m.coverageReceipt.domains[0].evidence = "complete";
				m.coverageReceipt.domains[0].valueSemantics = "exact";
			},
		],
		[
			"unrelated unsupported skip",
			(m) => {
				m.coverageReceipt.units[0].acceptedSkips = [
					{ reason: "missing-supported-mapping", count: 1 },
				];
			},
		],
		[
			"inconsistent published count",
			(m) => {
				m.coverageReceipt.domains[4].publishedCanonicalEntities = 1;
			},
		],
		[
			"metadata row mismatch",
			(m) => {
				m.itemCount = 3;
			},
		],
	])
		it(`rejects limited projection ${name}`, () => {
			const m = limitedMetadata();
			change(m);
			assert.equal(projectLimited(m), null);
		});
});
describe("domain-bounded real-source matrix profile", () => {
	for (const [name, options] of [
		["current inventory", {}],
		["authoritative empty inventory", { count: 0 }],
		["failed refresh retaining last-good", { attempt: "error" }],
	])
		it(`accepts ${name} without false complete playback`, () =>
			assert.doesNotThrow(() => lib.assertCacheEvidence(scenario(options))));
	for (const [name, change] of [
		[
			"missing publication evidence",
			(s) => {
				delete s.db.publicationEvidence;
			},
		],
		[
			"nonexact inventory",
			(s) => {
				s.db.publicationEvidence.inventoryExact = false;
			},
		],
		[
			"nonexact mapping",
			(s) => {
				s.db.publicationEvidence.mappingExact = false;
			},
		],
		[
			"incomplete on-deck",
			(s) => {
				s.db.publicationEvidence.onDeckExact = false;
			},
		],
		[
			"receipt generation mismatch",
			(s) => {
				s.db.publicationEvidence.identityGeneration = 4;
			},
		],
		[
			"wrong receipt count",
			(s) => {
				s.db.publicationEvidence.itemCount = 3;
			},
		],
		[
			"invented exact watch count",
			(s) => {
				s.db.publicationEvidence.watchCount = "complete";
			},
		],
		[
			"invented exact count",
			(s) => {
				s.health.itemCount = 4;
			},
		],
		[
			"wrong observed count",
			(s) => {
				s.health.observedItemCount = 3;
			},
		],
		[
			"unavailable health",
			(s) => {
				s.health.providerStatus.availability = "unavailable";
			},
		],
		[
			"another source",
			(s) => {
				s.health.providerStatus.sources[0].instanceId = "other";
			},
		],
		[
			"unexpected stale reason",
			(s) => {
				s.health.providerStatus.sources[0].status.reasonCodes.push("publication-stale");
			},
		],
		[
			"invented zero playback",
			(s) => {
				s.health.providerStatus.sources[0].status.evidence = "complete";
			},
		],
		[
			"missing coverage reason",
			(s) => {
				s.health.providerStatus.sources[0].status.reasonCodes = [];
			},
		],
	])
		it(`rejects ${name}`, () => {
			const s = scenario();
			change(s);
			assert.throws(() => lib.assertCacheEvidence(s));
		});
	it("keeps a failed attempt an error rather than passing partial", () => {
		const s = scenario({ attempt: "error" });
		s.health.lastResult = "partial";
		assert.throws(() => lib.assertCacheEvidence(s));
	});
});
describe("schema-validated private receipt projection", () => {
	for (const [connection, identity] of [
		[0, 3],
		[2, 0],
		[0, 0],
	])
		it(`accepts valid initial generations ${connection}/${identity}`, () => {
			const m = metadata();
			m.connectionGeneration = connection;
			m.identityGeneration = identity;
			const p = project(m);
			assert.notEqual(p, null);
			assert.equal(p.connectionGeneration, connection);
			assert.equal(p.identityGeneration, identity);
			const s = scenario();
			s.db.publicationEvidence = p;
			s.db.connectionGeneration =
				s.db.statusConnectionGeneration =
				s.db.rowConnectionGeneration =
					connection;
			s.db.identityGeneration =
				s.db.statusIdentityGeneration =
				s.db.rowIdentityGeneration =
					identity;
			assert.doesNotThrow(() => lib.assertCacheEvidence(s));
		});
	for (const key of ["connectionGeneration", "identityGeneration"])
		for (const value of [-1, null, 0.5, "0", Number.MAX_SAFE_INTEGER + 1])
			it(`rejects invalid ${key} category ${typeof value}/${String(value)}`, () => {
				const m = metadata();
				m[key] = value;
				assert.equal(project(m), null);
			});
	it("projects exact inventory and unknown playback without raw fields", () => {
		const p = project(metadata());
		assert.deepEqual(p, {
			valid: true,
			version: 2,
			itemCount: 4,
			connectionGeneration: 2,
			identityGeneration: 3,
			inventoryExact: true,
			mappingExact: true,
			onDeckExact: true,
			watchCount: "unknown",
			watchAttribution: "unknown",
		});
		const text = JSON.stringify(p);
		assert(!text.includes("fixture-scope") && !text.includes(at) && !text.includes("aaaa"));
	});
	it("admits bounded positive evidence without calling it exact", () => {
		const m = metadata();
		for (const d of m.coverageReceipt.domains.filter((d) => d.domain.startsWith("watch-"))) {
			d.evidence = "positive-only";
			d.valueSemantics = "lower-bound";
			d.units = [{ ...unit(1), expectedRawCount: null }];
		}
		assert.equal(project(m).watchCount, "positive-only");
	});
	it("accepts a consistent explicit zero on-deck published count", () => {
		const m = metadata();
		m.coverageReceipt.domains[4].publishedCanonicalEntities = 0;
		assert.equal(project(m).onDeckExact, true);
	});
	for (const [name, change] of [
		["missing metadata", () => null],
		["wrong provider", (m) => ({ ...m, provider: "plex" })],
		["positive-only inventory publication", (m) => ({ ...m, publicationLevel: "positive-only" })],
		["mismatched count", (m) => ({ ...m, itemCount: 3 })],
		[
			"duplicate domain",
			(m) => {
				m.coverageReceipt.domains.push(m.coverageReceipt.domains[0]);
				return m;
			},
		],
		[
			"missing mapping",
			(m) => {
				m.coverageReceipt.domains = m.coverageReceipt.domains.filter((d) => d.domain !== "mapping");
				return m;
			},
		],
		[
			"fatal inventory",
			(m) => {
				m.coverageReceipt.domains[0].units[0].fatalCount = 1;
				return m;
			},
		],
		[
			"unfinished page",
			(m) => {
				m.coverageReceipt.domains[0].units[0].pagesCompleted = 0;
				return m;
			},
		],
		[
			"count mismatch",
			(m) => {
				m.coverageReceipt.domains[0].units[0].expectedRawCount = 5;
				return m;
			},
		],
		[
			"unmapped skip",
			(m) => {
				m.coverageReceipt.domains[1].units[0].acceptedSkips = [
					{ reason: "missing-supported-mapping", count: 1 },
				];
				return m;
			},
		],
		[
			"false watch completeness",
			(m) => {
				m.coverageReceipt.domains[2].evidence = "complete";
				m.coverageReceipt.domains[2].valueSemantics = "exact";
				return m;
			},
		],
		[
			"AF-DOM-REG-001 on-deck count above canonical total",
			(m) => {
				m.coverageReceipt.domains[4].publishedCanonicalEntities = 1;
				return m;
			},
		],
		[
			"AF-DOM-REG-001 on-deck count below largest unit",
			(m) => {
				m.coverageReceipt.domains[4].units = [unit(2)];
				m.coverageReceipt.domains[4].publishedCanonicalEntities = 1;
				return m;
			},
		],
		[
			"AF-DOM-REG-001 core count above canonical total",
			(m) => {
				m.coverageReceipt.units[0].canonicalEntities = 3;
				return m;
			},
		],
		[
			"AF-DOM-REG-001 contradictory bounded-watch count",
			(m) => {
				const d = m.coverageReceipt.domains[2];
				d.evidence = "positive-only";
				d.valueSemantics = "lower-bound";
				d.units = [{ ...unit(1), expectedRawCount: null }];
				d.publishedCanonicalEntities = 2;
				return m;
			},
		],
	])
		it(`rejects ${name}`, () => assert.equal(project(change(metadata())), null));
});
