/**
 * Differential parity suite — legacy `evaluateRule` vs the engine-backed
 * `evaluateRuleViaEngine` (unified-rule-grammar §4 step 3).
 *
 * THE cutover gate: every fixture asserts the two paths return deep-equal
 * results (same RuleMatch incl. composed reason strings, or both null).
 * Fixtures are author-shaped rules (template/dialog-derived — §4.3 as
 * amended) plus the §1.3/§6.5 preserved-semantics edges: permissive
 * null, never-watched inference, case-insensitivity, retired-kind
 * no-match, the source:"tautulli" fail-safe, and the legacy domain
 * quirks (empty composite, unparseable JSON).
 */

import { describe, expect, it } from "vitest";
import { evaluateRule } from "../../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval, EvalContext, PlexWatchInfo } from "../../library-cleanup/types.js";
import type { LibraryCleanupRule } from "../../prisma.js";
import { evaluateRuleViaEngine } from "../cleanup-adapter.js";

// ---------------------------------------------------------------------------
// Factories (shapes mirror rule-evaluators.test.ts)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-01T12:00:00Z");

const DEFAULT_DATA = {
	genres: ["Action", "Sci-Fi"],
	ratings: { tmdb: { value: 7.5 }, imdb: { value: 7.2 } },
	remoteIds: { tmdbId: 12345 },
	movieFile: {
		mediaInfo: {
			videoCodec: "h265",
			audioCodec: "eac3",
			resolution: "1920x1080",
			videoDynamicRange: "HDR",
			audioChannels: 5.1,
		},
		quality: { quality: { name: "Bluray-1080p" } },
		customFormatScore: 85,
		releaseGroup: "SPARKS",
		runtime: 142,
		path: "/movies/Test Movie (2020)/Test.Movie.2020.1080p.BluRay.mkv",
	},
	tags: [1, 3],
};

function makeCacheItem(overrides: Partial<CacheItemForEval> = {}): CacheItemForEval {
	return {
		id: "cache-1",
		instanceId: "instance-1",
		arrItemId: 100,
		itemType: "movie",
		title: "Test Movie 2020",
		year: 2020,
		monitored: true,
		hasFile: true,
		status: "released",
		qualityProfileId: 1,
		qualityProfileName: "HD-1080p",
		sizeOnDisk: BigInt(5 * 1024 * 1024 * 1024),
		arrAddedAt: new Date("2025-12-01T00:00:00Z"),
		data: JSON.stringify(DEFAULT_DATA),
		...overrides,
	};
}

function makeRule(overrides: Partial<LibraryCleanupRule> = {}): LibraryCleanupRule {
	return {
		id: "rule-1",
		name: "Parity Rule",
		enabled: true,
		priority: 1,
		ruleType: "age",
		parameters: JSON.stringify({ operator: "older_than", days: 30 }),
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		action: "delete",
		operator: null,
		conditions: null,
		configId: "config-1",
		retentionMode: false,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	} as unknown as LibraryCleanupRule; // cast keeps the suite Prisma-generate-free, matching the legacy tests
}

function makePlexInfo(overrides: Partial<PlexWatchInfo> = {}): PlexWatchInfo {
	return {
		lastWatchedAt: new Date("2025-10-01T00:00:00Z"),
		watchCount: 3,
		watchedByUsers: ["alice", "bob"],
		onDeck: false,
		userRating: null,
		collections: [],
		labels: [],
		addedAt: new Date("2025-09-01T00:00:00Z"),
		sections: [],
		...overrides,
	} as PlexWatchInfo;
}

function baseCtx(overrides: Partial<EvalContext> = {}): EvalContext {
	return { now: NOW, ...overrides };
}

/** The parity assertion — both paths, deep-equal. */
function assertParity(
	rule: LibraryCleanupRule,
	item: CacheItemForEval = makeCacheItem(),
	ctx: EvalContext = baseCtx(),
	instanceService = "RADARR",
) {
	const legacy = evaluateRule(item, rule, instanceService, ctx);
	const engine = evaluateRuleViaEngine(item, rule, instanceService, ctx);
	expect(engine).toEqual(legacy);
	return { legacy, engine };
}

// ---------------------------------------------------------------------------
// Single rules
// ---------------------------------------------------------------------------

describe("parity — single rules", () => {
	it("age match (reason strings identical)", () => {
		const { legacy } = assertParity(makeRule());
		expect(legacy).not.toBeNull(); // both matched, not both-null
	});

	it("age no-match", () => {
		const { legacy } = assertParity(
			makeRule(),
			makeCacheItem({ arrAddedAt: new Date("2026-02-28T00:00:00Z") }),
		);
		expect(legacy).toBeNull();
	});

	it("permissive null — age with null arrAddedAt", () => {
		assertParity(makeRule(), makeCacheItem({ arrAddedAt: null }));
	});

	it("size greater_than", () => {
		const { legacy } = assertParity(
			makeRule({
				ruleType: "size",
				parameters: JSON.stringify({ operator: "greater_than", sizeGb: 2 }),
			}),
		);
		expect(legacy).not.toBeNull();
	});

	it("genre case-insensitivity (§1.3.5)", () => {
		const { legacy } = assertParity(
			makeRule({
				ruleType: "genre",
				parameters: JSON.stringify({ operator: "includes_any", genres: ["aCtIoN"] }),
			}),
		);
		expect(legacy).not.toBeNull();
	});

	it("plex_last_watched with watch data", () => {
		const ctx = baseCtx({ plexMap: new Map([["movie:12345", makePlexInfo()]]) });
		const { legacy } = assertParity(
			makeRule({
				ruleType: "plex_last_watched",
				parameters: JSON.stringify({ operator: "older_than", days: 30 }),
			}),
			makeCacheItem(),
			ctx,
		);
		expect(legacy).not.toBeNull();
	});

	it("permissive null — plex_last_watched with item absent from the watch map", () => {
		assertParity(
			makeRule({
				ruleType: "plex_last_watched",
				parameters: JSON.stringify({ operator: "older_than", days: 30 }),
			}),
			makeCacheItem(),
			baseCtx({ plexMap: new Map() }),
		);
	});

	it("never-watched inference — plex_watch_count less_than on map-absent item (§1.3.2)", () => {
		// Inference requires a NON-empty plexMap (proof Plex is configured)
		// with this item absent from it — an empty map means "no Plex data
		// at all" and stays permissive-null.
		const ctx = baseCtx({ plexMap: new Map([["movie:99999", makePlexInfo()]]) });
		const { legacy } = assertParity(
			makeRule({
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "less_than", count: 1 }),
			}),
			makeCacheItem(), // hasFile, added ~90d before NOW → inference applies
			ctx,
		);
		expect(legacy).not.toBeNull();
	});

	it("user_retention source plex / either / tautulli (fail-safe, §6.5)", () => {
		for (const source of ["plex", "either", "tautulli"]) {
			assertParity(
				makeRule({
					ruleType: "user_retention",
					parameters: JSON.stringify({ operator: "watched_by_none", source }),
				}),
				makeCacheItem(),
				baseCtx({ plexMap: new Map() }),
			);
		}
	});

	it("retired kind — disabled-then-re-enabled tautulli rule no-matches on both paths", () => {
		const { legacy } = assertParity(
			makeRule({
				ruleType: "tautulli_last_watched",
				parameters: JSON.stringify({ operator: "older_than", days: 90 }),
			}),
		);
		expect(legacy).toBeNull();
	});

	it("legacy quirk — unparseable parameters JSON no-matches", () => {
		assertParity(makeRule({ parameters: "not-json{{{" }));
	});
});

// ---------------------------------------------------------------------------
// Composites
// ---------------------------------------------------------------------------

describe("parity — composites", () => {
	const ageCond = { ruleType: "age", parameters: { operator: "older_than", days: 30 } };
	const sizeCond = { ruleType: "size", parameters: { operator: "greater_than", sizeGb: 2 } };
	const noMatchCond = { ruleType: "size", parameters: { operator: "greater_than", sizeGb: 500 } };
	const retiredCond = { ruleType: "tautulli_watched_by", parameters: { userNames: ["x"] } };

	it("AND — multi-reason ' AND ' join is byte-identical", () => {
		const { legacy, engine } = assertParity(
			makeRule({
				ruleType: "composite",
				operator: "AND",
				conditions: JSON.stringify([ageCond, sizeCond]),
			}),
		);
		expect(legacy?.reason).toContain(" AND ");
		expect(engine?.reason).toBe(legacy?.reason);
	});

	it("AND — one failing condition fails the rule", () => {
		const { legacy } = assertParity(
			makeRule({
				ruleType: "composite",
				operator: "AND",
				conditions: JSON.stringify([ageCond, noMatchCond]),
			}),
		);
		expect(legacy).toBeNull();
	});

	it("OR — first matching reason only, in declaration order", () => {
		const { legacy } = assertParity(
			makeRule({
				ruleType: "composite",
				operator: "OR",
				conditions: JSON.stringify([noMatchCond, ageCond, sizeCond]),
			}),
		);
		expect(legacy?.reason).not.toContain(" AND ");
	});

	it("OR — retired-kind sibling no-matches but does not poison the rule", () => {
		const { legacy } = assertParity(
			makeRule({
				ruleType: "composite",
				operator: "OR",
				conditions: JSON.stringify([retiredCond, ageCond]),
			}),
		);
		expect(legacy).not.toBeNull(); // age sibling still matches on both paths
	});

	it("REVIEW SHAPE — leaf ruleType + operator+conditions: conditions decide, not leaf params", () => {
		// The empirical probe from the cutover review: ruleType "age"
		// (which WOULD match) carrying a non-matching size condition.
		// Legacy evaluates the conditions → null. The engine path must
		// agree — keying composite on ruleType instead of operator+
		// conditions made it evaluate the leaf and DELETE.
		const { legacy } = assertParity(
			makeRule({
				ruleType: "age",
				parameters: JSON.stringify({ operator: "older_than", days: 30 }), // matches
				operator: "AND",
				conditions: JSON.stringify([noMatchCond]), // does not match
			}),
		);
		expect(legacy).toBeNull(); // conditions decide — item is KEPT
	});

	it("REVIEW SHAPE — leaf ruleType + matching conditions: both paths match via conditions", () => {
		const { legacy } = assertParity(
			makeRule({
				ruleType: "age",
				parameters: JSON.stringify({ operator: "older_than", days: 99999 }), // would NOT match
				operator: "OR",
				conditions: JSON.stringify([sizeCond]), // matches
			}),
		);
		expect(legacy).not.toBeNull(); // conditions decide — matched via size
	});

	it("legacy quirk — empty composite conditions no-match (NOT vacuous true)", () => {
		assertParity(makeRule({ ruleType: "composite", operator: "AND", conditions: "[]" }));
	});

	it("legacy quirk — unparseable composite conditions no-match", () => {
		assertParity(makeRule({ ruleType: "composite", operator: "AND", conditions: "not-json{{{" }));
	});
});

// ---------------------------------------------------------------------------
// Pre-filters + rule state
// ---------------------------------------------------------------------------

describe("parity — pre-filters and rule state", () => {
	it("disabled rule", () => {
		assertParity(makeRule({ enabled: false }));
	});

	it("service filter mismatch", () => {
		assertParity(makeRule({ serviceFilter: JSON.stringify(["SONARR"]) }));
	});

	it("title exclusion", () => {
		assertParity(makeRule({ excludeTitles: JSON.stringify(["Test Movie 2020"]) }));
	});

	it("instance filter mismatch", () => {
		assertParity(makeRule({ instanceFilter: JSON.stringify(["other-instance"]) }));
	});

	it("action passthrough — unmonitor", () => {
		const { legacy } = assertParity(makeRule({ action: "unmonitor" }));
		expect(legacy?.action).toBe("unmonitor");
	});
});

// ---------------------------------------------------------------------------
// Loop wrappers — evaluateItemAgainstRules / explainItemAgainstRules
// ---------------------------------------------------------------------------

import {
	evaluateItemAgainstRules,
	explainItemAgainstRules,
} from "../../library-cleanup/rule-evaluators.js";
import {
	evaluateItemAgainstRulesViaEngine,
	explainItemAgainstRulesViaEngine,
} from "../cleanup-adapter.js";

describe("parity — evaluateItemAgainstRules (two-phase loop)", () => {
	const matchingRule = (overrides: Partial<LibraryCleanupRule> = {}) =>
		makeRule({ id: "m1", name: "Matcher", ...overrides });
	const retentionRule = makeRule({
		id: "ret1",
		name: "Protector",
		retentionMode: true,
		ruleType: "size",
		parameters: JSON.stringify({ operator: "greater_than", sizeGb: 2 }),
	});

	function assertLoopParity(
		rules: LibraryCleanupRule[],
		item: CacheItemForEval = makeCacheItem(),
		failedSources?: Set<"seerr" | "plex" | "jellyfin" | null>,
	) {
		const ctx = baseCtx();
		const legacy = evaluateItemAgainstRules(item, rules, "RADARR", ctx, failedSources);
		const engine = evaluateItemAgainstRulesViaEngine(item, rules, "RADARR", ctx, failedSources);
		expect(engine).toEqual(legacy);
		return legacy;
	}

	it("retention rule protects the item (both null) even when a cleanup rule matches", () => {
		const result = assertLoopParity([retentionRule, matchingRule()]);
		expect(result).toBeNull();
	});

	it("priority order — first cleanup match wins in caller-provided order", () => {
		const result = assertLoopParity([
			matchingRule({ id: "m1", name: "First" }),
			matchingRule({ id: "m2", name: "Second" }),
		]);
		expect(result?.ruleId).toBe("m1");
	});

	it("failed-source skip — plex-dependent rule skipped when plex prefetch failed", () => {
		const plexRule = makeRule({
			id: "p1",
			ruleType: "plex_last_watched",
			parameters: JSON.stringify({ operator: "older_than", days: 30 }),
		});
		const result = assertLoopParity([plexRule], makeCacheItem(), new Set(["plex"]));
		expect(result).toBeNull();
	});
});

describe("parity — explainItemAgainstRules", () => {
	it("identical per-rule breakdown: disabled / filtered / matched rows", () => {
		const rules = [
			makeRule({ id: "r1", name: "Disabled", enabled: false }),
			makeRule({ id: "r2", name: "Filtered", serviceFilter: JSON.stringify(["SONARR"]) }),
			makeRule({ id: "r3", name: "Match" }),
			makeRule({
				id: "r4",
				name: "NoMatch",
				parameters: JSON.stringify({ operator: "older_than", days: 9999 }),
			}),
		];
		const item = makeCacheItem();
		const ctx = baseCtx();
		const legacy = explainItemAgainstRules(item, rules, "RADARR", ctx);
		const engine = explainItemAgainstRulesViaEngine(item, rules, "RADARR", ctx);
		expect(engine).toEqual(legacy);
		expect(legacy.map((r) => r.filteredBy)).toEqual(["disabled", "service_filter", null, null]);
		expect(legacy.map((r) => r.matched)).toEqual([false, false, true, false]);
	});
});

// ---------------------------------------------------------------------------
// Auto-tag adapter parity
// ---------------------------------------------------------------------------

import { type AutoTagRuleInput, evaluateAgainstRule } from "../../auto-tag/execute-rule.js";
import { autoTagRuleMatchesViaEngine } from "../auto-tag-adapter.js";

function makeAutoTagRule(overrides: Partial<AutoTagRuleInput> = {}): AutoTagRuleInput {
	return {
		id: "at-1",
		userId: "user-1",
		name: "Auto-tag parity",
		ruleType: "age",
		parameters: { operator: "older_than", days: 30 },
		operator: null,
		conditions: null,
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		tagName: "stale",
		...overrides,
	};
}

describe("parity — auto-tag adapter (boolean semantics)", () => {
	function assertAutoTagParity(
		rule: AutoTagRuleInput,
		item: CacheItemForEval = makeCacheItem(),
		ctx: EvalContext = baseCtx(),
	) {
		const legacy = evaluateAgainstRule(item, rule, "RADARR", ctx);
		const engine = autoTagRuleMatchesViaEngine(item, rule, "RADARR", ctx);
		expect(engine).toBe(legacy);
		return legacy;
	}

	it("single rule match", () => {
		expect(assertAutoTagParity(makeAutoTagRule())).toBe(true);
	});

	it("single rule no-match", () => {
		expect(
			assertAutoTagParity(
				makeAutoTagRule({ parameters: { operator: "older_than", days: 9999 } }),
			),
		).toBe(false);
	});

	it("AND composite — all must match", () => {
		expect(
			assertAutoTagParity(
				makeAutoTagRule({
					ruleType: "composite",
					operator: "AND",
					conditions: [
						{ ruleType: "age", parameters: { operator: "older_than", days: 30 } },
						{ ruleType: "size", parameters: { operator: "greater_than", sizeGb: 2 } },
					],
				}),
			),
		).toBe(true);
	});

	it("OR composite — one suffices", () => {
		expect(
			assertAutoTagParity(
				makeAutoTagRule({
					ruleType: "composite",
					operator: "OR",
					conditions: [
						{ ruleType: "size", parameters: { operator: "greater_than", sizeGb: 500 } },
						{ ruleType: "age", parameters: { operator: "older_than", days: 30 } },
					],
				}),
			),
		).toBe(true);
	});

	it("legacy quirk — composite with EMPTY conditions falls through to single path (no-match)", () => {
		expect(
			assertAutoTagParity(
				makeAutoTagRule({ ruleType: "composite", operator: "AND", conditions: [] }),
			),
		).toBe(false);
	});

	it("retired kind no-matches on both paths", () => {
		expect(
			assertAutoTagParity(
				makeAutoTagRule({
					ruleType: "tautulli_watched_by",
					parameters: { operator: "includes_any", userNames: ["x"] },
				}),
			),
		).toBe(false);
	});
});
