/**
 * Cleanup/auto-tag → engine adapter
 * (docs/design/unified-rule-grammar.md §4 step 4, strangler shape).
 *
 * Reproduces `evaluateRule`'s exact decision surface on top of the
 * unified engine: same pre-filters (imported, never duplicated), same
 * composite reason semantics (engine pins them), same domain quirks —
 * all reproduced deliberately and parity-tested:
 *
 *   - empty/unparseable composite conditions → no-match (legacy guard
 *     `if (!conditions?.length) return null`)
 *   - unparseable single-rule parameters → no-match (legacy
 *     `parseParams` returning null)
 *   - retired/unknown kinds → no-match via the injected dispatch's
 *     `default: return null` (tier-3 permissive null, §2.2)
 *
 * One documented, intentional delta: structurally unrepresentable rows
 * (a composite condition without `ruleType`, parameters that aren't an
 * object) map to no-match here, where the legacy path could THROW from
 * inside an evaluator mid-run. Such rows cannot be produced by any
 * write path; no-match is strictly safer than an aborted cleanup run.
 *
 * Cutover = swapping `evaluateRule` call sites to
 * `evaluateRuleViaEngine` once the differential parity suite is green.
 */

import type { DataSourceDependency, RuleDocument } from "@arr/shared";
import {
	evaluateSingleCondition,
	getFilterReason,
	parseAudioChannels,
	passesCleanupRuleFilters,
	passesInstanceFilter,
	passesServiceFilter,
	passesTagExclusion,
	passesTitleExclusion,
	ruleUsesUnavailableData,
} from "../library-cleanup/rule-evaluators.js";
import type {
	CacheItemForEval,
	EvalContext,
	RuleAction,
	RuleMatch,
} from "../library-cleanup/types.js";
import type { LibraryCleanupRule } from "../prisma.js";
import { safeJsonParse } from "../utils/json.js";
import { evaluateDocument, type PredicateEvaluator } from "./engine.js";
import { mapCriteriaV0ToDocument } from "./v0-mappers.js";

/**
 * Engine-backed equivalent of `evaluateRule` (rule-evaluators.ts).
 * Identical inputs, identical outputs — proven by the parity suite.
 */
export function evaluateRuleViaEngine(
	item: CacheItemForEval,
	rule: LibraryCleanupRule,
	instanceService: string,
	ctx: EvalContext,
): RuleMatch | null {
	if (!rule.enabled) return null;

	// Pre-filters — the legacy functions, not copies.
	if (!passesServiceFilter(instanceService, rule.serviceFilter)) return null;
	if (!passesInstanceFilter(item.instanceId, rule.instanceFilter)) return null;
	if (!passesTagExclusion(item, rule.excludeTags)) return null;
	if (!passesTitleExclusion(item.title, rule.excludeTitles)) return null;

	const plexLibFilter = safeJsonParse(rule.plexLibraryFilter) as string[] | null;
	const action = (rule.action ?? "delete") as RuleAction;

	// Domain quirk guards (rule-level policy, deliberately NOT in the
	// engine — see engine.ts header on empty-group semantics).
	if (rule.operator && rule.conditions) {
		const conditions = safeJsonParse(rule.conditions) as unknown[] | null;
		if (!conditions?.length) return null;
	} else {
		const params = safeJsonParse(rule.parameters) as Record<string, unknown> | null;
		if (!params) return null;
	}

	let doc: RuleDocument;
	try {
		doc = mapCriteriaV0ToDocument(rule);
	} catch {
		// Unrepresentable row (see header) — no-match, never a thrown run.
		return null;
	}

	const evalPredicate: PredicateEvaluator = (predicate) =>
		evaluateSingleCondition(item, predicate.kind, predicate.params, ctx, plexLibFilter);

	const result = evaluateDocument(doc, evalPredicate);
	return result.matched
		? { ruleId: rule.id, ruleName: rule.name, reason: result.reason, action }
		: null;
}

/**
 * Engine-backed equivalent of `evaluateItemAgainstRules` — the same
 * two-phase loop (retention rules protect first, then cleanup rules
 * first-match-wins by caller-provided order) and the same
 * failed-source skip (the C1 safety fix), delegating per-rule
 * evaluation to the engine.
 */
export function evaluateItemAgainstRulesViaEngine(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	instanceService: string,
	ctx: EvalContext,
	failedSources?: Set<DataSourceDependency>,
): RuleMatch | null {
	// Phase 1: retention rules — any match protects the item
	for (const rule of rules) {
		if (!rule.retentionMode) continue;
		if (!passesCleanupRuleFilters(item, rule, instanceService)) continue;
		if (ruleUsesUnavailableData(rule, failedSources)) return null;
		const match = evaluateRuleViaEngine(item, rule, instanceService, ctx);
		if (match) return null;
	}

	// Phase 2: cleanup rules — first match wins
	for (const rule of rules) {
		if (rule.retentionMode) continue;
		if (ruleUsesUnavailableData(rule, failedSources)) continue;
		const match = evaluateRuleViaEngine(item, rule, instanceService, ctx);
		if (match) return match;
	}
	return null;
}

export type MutationPolicyState =
	| { kind: "cleanup"; match: RuleMatch }
	| { kind: "retained"; ruleId: string; evidence: "true" | "unknown" }
	| { kind: "unknown"; ruleId: string }
	| { kind: "no_match" };

function storedStringArrayIsValid(value: string | null): boolean {
	if (value === null) return true;
	const parsed = safeJsonParse(value) as unknown;
	return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string");
}

function mutationFiltersAreValid(rule: LibraryCleanupRule): boolean {
	const tags = rule.excludeTags === null ? [] : (safeJsonParse(rule.excludeTags) as unknown);
	return (
		storedStringArrayIsValid(rule.serviceFilter) &&
		storedStringArrayIsValid(rule.instanceFilter) &&
		storedStringArrayIsValid(rule.excludeTitles) &&
		storedStringArrayIsValid(rule.plexLibraryFilter) &&
		Array.isArray(tags) &&
		tags.every((tag) => typeof tag === "number" && Number.isSafeInteger(tag) && tag >= 0)
	);
}

function itemData(item: CacheItemForEval): Record<string, unknown> | null {
	const parsed = safeJsonParse(item.data) as unknown;
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
}

function evidenceFlag(data: Record<string, unknown>, flag: string): boolean {
	const evidence = data._arrDashboardEvidence;
	return (
		typeof evidence === "object" &&
		evidence !== null &&
		!Array.isArray(evidence) &&
		(evidence as Record<string, unknown>)[flag] === true
	);
}

function hasLanguageEvidence(data: Record<string, unknown>): boolean {
	if (typeof data.originalLanguage === "string" && data.originalLanguage.trim().length > 0) {
		return true;
	}
	if (typeof data.originalLanguage === "object" && data.originalLanguage !== null) {
		const name = (data.originalLanguage as Record<string, unknown>).name;
		if (typeof name === "string" && name.trim().length > 0) return true;
	}
	return (
		Array.isArray(data.languages) &&
		data.languages.length > 0 &&
		data.languages.every(
			(language) =>
				(typeof language === "string" && language.trim().length > 0) ||
				(typeof language === "object" &&
					language !== null &&
					typeof (language as Record<string, unknown>).name === "string" &&
					((language as Record<string, unknown>).name as string).trim().length > 0),
		)
	);
}

function hasFileMetadataEvidence(data: Record<string, unknown>, ruleType: string): boolean {
	if (evidenceFlag(data, "hasFile") && data.hasFile === false) return true;
	const file =
		typeof data.movieFile === "object" && data.movieFile !== null
			? (data.movieFile as Record<string, unknown>)
			: typeof data.episodeFile === "object" && data.episodeFile !== null
				? (data.episodeFile as Record<string, unknown>)
				: null;
	if (!file) return false;
	if (ruleType === "video_codec") {
		return typeof file.videoCodec === "string" && file.videoCodec.trim().length > 0;
	}
	if (ruleType === "audio_codec") {
		return typeof file.audioCodec === "string" && file.audioCodec.trim().length > 0;
	}
	if (ruleType === "audio_channels") {
		return typeof file.audioCodec === "string" && parseAudioChannels(file.audioCodec) !== null;
	}
	if (ruleType === "resolution") {
		return typeof file.resolution === "string" && file.resolution.trim().length > 0;
	}
	if (ruleType === "custom_format_score") {
		return typeof file.customFormatScore === "number" && Number.isFinite(file.customFormatScore);
	}
	if (ruleType === "release_group") {
		return typeof file.releaseGroup === "string" && file.releaseGroup.trim().length > 0;
	}
	return false;
}

function externalIdentity(item: CacheItemForEval): { tmdbId: number | null; key: string | null } {
	const data = itemData(item);
	const remoteIds =
		typeof data?.remoteIds === "object" && data.remoteIds !== null
			? (data.remoteIds as Record<string, unknown>)
			: null;
	const candidate = remoteIds?.tmdbId ?? data?.tmdbId;
	const tmdbId =
		typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0
			? candidate
			: null;
	return { tmdbId, key: tmdbId === null ? null : `${item.itemType}:${tmdbId}` };
}

function ruleTypeHasMutationEvidence(
	item: CacheItemForEval,
	ruleType: string,
	parameters: Record<string, unknown>,
	instanceService: string,
	ctx: EvalContext,
): boolean {
	const data = itemData(item);
	if (!data) return false;
	const { tmdbId, key } = externalIdentity(item);

	switch (ruleType) {
		case "age":
			return item.arrAddedAt instanceof Date && !Number.isNaN(item.arrAddedAt.getTime());
		case "size":
			return evidenceFlag(data, "sizeOnDisk");
		case "rating":
			return evidenceFlag(data, "rating");
		case "imdb_rating":
			return instanceService === "RADARR" && evidenceFlag(data, "imdbRating");
		case "status":
			return typeof item.status === "string" && item.status.trim().length > 0;
		case "unmonitored":
			return evidenceFlag(data, "monitored");
		case "genre":
			return Array.isArray(data.genres) && data.genres.every((genre) => typeof genre === "string");
		case "year_range":
			return typeof item.year === "number" && Number.isFinite(item.year);
		case "no_file":
			return evidenceFlag(data, "hasFile");
		case "quality_profile":
			return typeof item.qualityProfileName === "string" && item.qualityProfileName.length > 0;
		case "language":
			return hasLanguageEvidence(data);
		case "runtime":
			return typeof data.runtime === "number" && Number.isFinite(data.runtime);
		case "file_path":
			return (
				(typeof data.path === "string" && data.path.length > 0) ||
				(typeof data.rootFolderPath === "string" && data.rootFolderPath.length > 0)
			);
		case "tag_match":
			return evidenceFlag(data, "tags");
		case "video_codec":
		case "audio_codec":
		case "audio_channels":
		case "resolution":
		case "custom_format_score":
		case "release_group":
			return hasFileMetadataEvidence(data, ruleType);
		case "hdr_type":
			return evidenceFlag(data, "hdrType");
		case "plex_episode_completion":
			return tmdbId !== null && ctx.plexEpisodeMap?.has(tmdbId) === true;
		case "jellyfin_episode_completion":
			return tmdbId !== null && ctx.jellyfinEpisodeMap?.has(tmdbId) === true;
		case "plex_last_watched":
		case "plex_watch_count":
		case "plex_on_deck":
		case "plex_user_rating":
		case "plex_watched_by":
		case "plex_collection":
		case "plex_label":
		case "plex_added_at":
		case "user_retention":
		case "staleness_score":
			return key !== null && ctx.plexMap?.has(key) === true;
		case "recently_active":
			return (
				item.arrAddedAt instanceof Date &&
				!Number.isNaN(item.arrAddedAt.getTime()) &&
				(parameters.requireActivity !== true || (key !== null && ctx.plexMap?.has(key) === true))
			);
		case "jellyfin_last_watched":
		case "jellyfin_watch_count":
		case "jellyfin_on_deck":
		case "jellyfin_user_rating":
		case "jellyfin_watched_by":
		case "jellyfin_added_at":
			return key !== null && ctx.jellyfinMap?.has(key) === true;
		case "seerr_requested_by":
		case "seerr_request_age":
		case "seerr_request_status":
		case "seerr_is_4k":
		case "seerr_request_modified_age":
		case "seerr_modified_by":
		case "seerr_is_requested":
		case "seerr_request_count":
			return key !== null && ctx.seerrMap instanceof Map;
		case "seerr_requester_watched":
		case "seerr_requester_not_watched":
			return key !== null && ctx.seerrMap instanceof Map && ctx.plexMap?.has(key) === true;
		case "tmdb_list_member":
		case "trakt_list_member":
			// Membership rows do not currently carry a per-list generation or
			// an empty-list marker. Presence of a Map therefore cannot prove
			// that an absent item is authoritatively `not_in` the live list.
			return false;
		default:
			return false;
	}
}

function ruleHasMutationEvidence(
	item: CacheItemForEval,
	rule: LibraryCleanupRule,
	instanceService: string,
	ctx: EvalContext,
): boolean {
	if (!mutationFiltersAreValid(rule)) return false;
	const data = itemData(item);
	if (!data) return false;
	const excludedTags =
		rule.excludeTags === null ? [] : (safeJsonParse(rule.excludeTags) as unknown[]);
	if (excludedTags.length > 0 && !evidenceFlag(data, "tags")) return false;

	if (rule.operator || rule.conditions) {
		if (!rule.operator || !rule.conditions) return false;
		const conditions = safeJsonParse(rule.conditions) as unknown;
		if (!Array.isArray(conditions) || conditions.length === 0) return false;
		return conditions.every((condition) => {
			if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
				return false;
			}
			const entry = condition as Record<string, unknown>;
			return (
				typeof entry.ruleType === "string" &&
				typeof entry.parameters === "object" &&
				entry.parameters !== null &&
				!Array.isArray(entry.parameters) &&
				ruleTypeHasMutationEvidence(
					item,
					entry.ruleType,
					entry.parameters as Record<string, unknown>,
					instanceService,
					ctx,
				)
			);
		});
	}

	const parameters = safeJsonParse(rule.parameters) as unknown;
	return (
		typeof parameters === "object" &&
		parameters !== null &&
		!Array.isArray(parameters) &&
		ruleTypeHasMutationEvidence(
			item,
			rule.ruleType,
			parameters as Record<string, unknown>,
			instanceService,
			ctx,
		)
	);
}

/**
 * Re-evaluate policy for an irreversible write without allowing normalized
 * cache defaults or missing provider rows to stand in for current evidence.
 */
export function evaluateItemMutationPolicyStateViaEngine(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	instanceService: string,
	ctx: EvalContext,
	failedSources?: Set<DataSourceDependency>,
): MutationPolicyState {
	const orderedRules = [...rules].sort(
		(left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
	);
	for (const rule of orderedRules) {
		if (!rule.retentionMode || !rule.enabled) continue;
		if (!passesCleanupRuleFilters(item, rule, instanceService)) continue;
		if (
			ruleUsesUnavailableData(rule, failedSources) ||
			!ruleHasMutationEvidence(item, rule, instanceService, ctx)
		) {
			return { kind: "retained", ruleId: rule.id, evidence: "unknown" };
		}
		if (evaluateRuleViaEngine(item, rule, instanceService, ctx)) {
			return { kind: "retained", ruleId: rule.id, evidence: "true" };
		}
	}

	for (const rule of orderedRules) {
		if (rule.retentionMode || !rule.enabled) continue;
		if (!passesCleanupRuleFilters(item, rule, instanceService)) continue;
		if (
			ruleUsesUnavailableData(rule, failedSources) ||
			!ruleHasMutationEvidence(item, rule, instanceService, ctx)
		) {
			return { kind: "unknown", ruleId: rule.id };
		}
		const match = evaluateRuleViaEngine(item, rule, instanceService, ctx);
		if (match) return { kind: "cleanup", match };
	}
	return { kind: "no_match" };
}

/** Per-rule breakdown row for the explain endpoint. */
export interface ExplainRuleResult {
	ruleId: string;
	ruleName: string;
	matched: boolean;
	reason: string | null;
	filteredBy:
		| "service_filter"
		| "instance_filter"
		| "tag_exclusion"
		| "title_exclusion"
		| "disabled"
		| null;
	retentionMode: boolean;
}

/**
 * Engine-backed equivalent of `explainItemAgainstRules` — identical
 * per-rule breakdown (disabled / which pre-filter blocked / match with
 * reason), delegating evaluation to the engine.
 */
export function explainItemAgainstRulesViaEngine(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	instanceService: string,
	ctx: EvalContext,
): ExplainRuleResult[] {
	const results: ExplainRuleResult[] = [];

	for (const rule of rules) {
		if (!rule.enabled) {
			results.push({
				ruleId: rule.id,
				ruleName: rule.name,
				matched: false,
				reason: null,
				filteredBy: "disabled",
				retentionMode: rule.retentionMode,
			});
			continue;
		}

		const filteredBy = getFilterReason(item, rule, instanceService);
		if (filteredBy) {
			results.push({
				ruleId: rule.id,
				ruleName: rule.name,
				matched: false,
				reason: null,
				filteredBy,
				retentionMode: rule.retentionMode,
			});
			continue;
		}

		const match = evaluateRuleViaEngine(item, rule, instanceService, ctx);
		results.push({
			ruleId: rule.id,
			ruleName: rule.name,
			matched: match !== null,
			reason: match?.reason ?? null,
			filteredBy: null,
			retentionMode: rule.retentionMode,
		});
	}

	return results;
}
