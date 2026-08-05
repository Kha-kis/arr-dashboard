/**
 * Auto-Tagger — inbound webhook handler.
 *
 * Sonarr/Radarr Connect notifications fire on import (and other events).
 * This handler:
 *   1. Authenticates via Bearer token against the user's `webhookSecret`.
 *   2. Verifies the instance belongs to that user.
 *   3. Parses the Connect payload to extract the *arr item id + media type.
 *   4. Live-fetches the item from the *arr API and synthesizes a
 *      `CacheItemForEval` (the LibraryCache row may not exist yet — the
 *      sync scheduler runs every 6h, but Connect fires within seconds).
 *   5. Evaluates every enabled `AutoTagRule` against the single item and
 *      applies the matching tag(s).
 *
 * v1 supports Sonarr (series imports) and Radarr (movie imports). Lidarr
 * is deferred. "Test" events from Connect are acknowledged with no-op so
 * the user can verify the wiring without firing a real run.
 */

import { createHash } from "node:crypto";
import type { DataSourceDependency } from "@arr/shared";
import { ArrError } from "arr-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClient, ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { buildEvalContextWithHealth } from "../library-cleanup/cleanup-executor.js";
import {
	evaluateSingleConditionState,
	type RuleEvaluationState,
} from "../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval } from "../library-cleanup/types.js";
import type { AutoTagRule, PrismaClient, ServiceInstance, User } from "../prisma.js";
import { safeJsonParse } from "../utils/json.js";
import { loadCompleteListEvidence } from "./list-evidence-loader.js";
import { adaptLiveArrItemForAutoTag } from "./live-arr-evidence.js";

export interface WebhookHandlerDeps {
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

export interface WebhookResult {
	status: "ok" | "test" | "ignored" | "error";
	message: string;
	tagsApplied?: number;
	rulesEvaluated?: number;
}

/**
 * Resolve a webhook bearer token to a user. Returns null if the token
 * is missing, malformed, or unknown. The token is hashed before the DB
 * lookup so a DB compromise yields no usable creds.
 */
export async function resolveUserFromBearer(
	prisma: PrismaClient,
	authHeader: string | undefined,
): Promise<User | null> {
	if (!authHeader?.startsWith("Bearer ")) return null;
	const token = authHeader.slice("Bearer ".length).trim();
	if (token.length < 16) return null;
	const hashed = createHash("sha256").update(token).digest("hex");
	return prisma.user.findUnique({ where: { hashedWebhookSecret: hashed } });
}

/**
 * Process one Connect webhook payload. The route layer is responsible for
 * authentication + instance ownership; this function trusts that the caller
 * has already verified those.
 */
export async function processWebhook(opts: {
	deps: WebhookHandlerDeps;
	user: User;
	instance: ServiceInstance;
	payload: unknown;
}): Promise<WebhookResult> {
	const { deps, user, instance, payload } = opts;
	const log = deps.log.child({ userId: user.id, instanceId: instance.id });

	const event = parseConnectEvent(payload);
	if (event.kind === "unsupported") {
		return { status: "ignored", message: `Unsupported event: ${event.reason}` };
	}
	if (event.kind === "test") {
		return { status: "test", message: "Test webhook received." };
	}

	// Verify the instance type matches the event payload (Sonarr → series,
	// Radarr → movie). Mismatch = misconfigured Connect URL.
	const expectedService =
		event.mediaType === "series" ? "SONARR" : event.mediaType === "movie" ? "RADARR" : null;
	if (expectedService && instance.service !== expectedService) {
		log.warn(
			{ event: event.mediaType, instanceService: instance.service },
			"Webhook payload media type doesn't match instance service type",
		);
		return {
			status: "error",
			message: `Instance is ${instance.service} but webhook payload is for ${event.mediaType}.`,
		};
	}

	// Live-fetch the item from the *arr instance.
	let arrClient: ArrClient;
	try {
		arrClient = deps.arrClientFactory.create({
			id: instance.id,
			baseUrl: instance.baseUrl,
			encryptedApiKey: instance.encryptedApiKey,
			encryptionIv: instance.encryptionIv,
			encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
			httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
			service: instance.service,
			label: instance.label,
		});
	} catch (err) {
		log.warn({ err }, "Failed to create *arr client for webhook");
		return { status: "error", message: "Failed to initialize *arr client." };
	}

	let cacheItem: CacheItemForEval;
	try {
		cacheItem = await fetchAndAdaptItem(arrClient, event, instance.id);
	} catch (err) {
		const reason = err instanceof ArrError ? err.message : String(err);
		log.warn({ err: reason, arrItemId: event.arrItemId }, "Failed to fetch item from *arr");
		return { status: "error", message: `Failed to fetch item: ${reason}` };
	}

	// Load all enabled auto-tag rules for this user that scope to this instance.
	const allRules = await deps.prisma.autoTagRule.findMany({
		where: { userId: user.id, enabled: true },
	});

	const applicable = allRules.filter((rule) =>
		ruleAppliesToInstance(rule, instance.id, instance.service),
	);

	if (applicable.length === 0) {
		return { status: "ok", message: "No enabled rules apply to this instance.", rulesEvaluated: 0 };
	}

	// Build prefetch context once, in case any rule needs Plex/Jellyfin/Seerr
	// prefetched data. The rules pass their criteria types in via the same
	// shape `buildEvalContext` expects.
	const { ctx, failedSources } = await safeBuildContext(deps, user.id, applicable, log);

	let tagsApplied = 0;
	const candidateRules: AutoTagRule[] = [];
	for (const rule of applicable) {
		const ruleInput = adaptRuleForEval(rule);
		if (matchesRule(cacheItem, ruleInput, ctx, failedSources) === "true") {
			candidateRules.push(rule);
		}
	}

	if (candidateRules.length === 0) {
		return {
			status: "ok",
			message: "No rules matched the imported item.",
			rulesEvaluated: applicable.length,
		};
	}

	// Apply each unique tag. Use ensureTag + series/movie.update with merge
	// semantics — same pattern as the scheduled executor.
	const uniqueTags = [...new Set(candidateRules.map((rule) => rule.tagName))];
	const tagIds = new Map<string, number>();
	for (const tagName of uniqueTags) {
		try {
			const tagId = await ensureTag(arrClient, tagName);
			tagIds.set(tagName, tagId);
		} catch (err) {
			log.warn({ err, tag: tagName }, "Failed to ensure tag");
		}
	}

	try {
		const accessor = event.mediaType === "series" ? "series" : "movie";
		// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
		const resource = (arrClient as any)[accessor];
		const fullItem = (await resource.getById(event.arrItemId)) as Record<string, unknown>;
		const latestItem = adaptLiveArrItemForAutoTag(fullItem, {
			instanceId: instance.id,
			arrItemId: event.arrItemId,
			itemType: event.mediaType,
		});
		const latestEvidence = await safeBuildContext(deps, user.id, candidateRules, log);
		const matchingTagIds: number[] = [];
		for (const rule of candidateRules) {
			const ruleInput = adaptRuleForEval(rule);
			if (
				matchesRule(latestItem, ruleInput, latestEvidence.ctx, latestEvidence.failedSources) !==
				"true"
			) {
				continue;
			}
			const tagId = tagIds.get(rule.tagName);
			if (tagId === undefined) continue;
			tagsApplied++;
			if (!matchingTagIds.includes(tagId)) matchingTagIds.push(tagId);
		}

		const existingTags = extractItemTags(latestItem.data);
		const newTagIds = matchingTagIds.filter((tagId) => !existingTags.includes(tagId));
		if (newTagIds.length > 0) {
			await resource.update(event.arrItemId, {
				...fullItem,
				id: event.arrItemId,
				tags: [...existingTags, ...newTagIds],
			});
		}
	} catch (err) {
		const reason = err instanceof ArrError ? err.message : String(err);
		log.warn({ err: reason }, "Failed to revalidate or update item tags");
		return { status: "error", message: `Tag update failed: ${reason}` };
	}

	return {
		status: "ok",
		message: `Applied ${tagsApplied} tag${tagsApplied === 1 ? "" : "s"} from ${applicable.length} rule${applicable.length === 1 ? "" : "s"}.`,
		tagsApplied,
		rulesEvaluated: applicable.length,
	};
}

// ============================================================================
// Connect payload parsing
// ============================================================================

type ConnectEvent =
	| { kind: "import"; mediaType: "series" | "movie"; arrItemId: number }
	| { kind: "test" }
	| { kind: "unsupported"; reason: string };

function parseConnectEvent(payload: unknown): ConnectEvent {
	if (!payload || typeof payload !== "object") {
		return { kind: "unsupported", reason: "payload not an object" };
	}
	const p = payload as Record<string, unknown>;
	const eventType = typeof p.eventType === "string" ? p.eventType.toLowerCase() : "";

	if (eventType === "test") return { kind: "test" };

	// Allowlist: only item-level events that legitimately carry a single
	// imported/changed series or movie. Health, ApplicationUpdate, and other
	// system-level events that *might* still serialize a series/movie object
	// shouldn't trigger tagging.
	const ITEM_EVENT_TYPES = new Set([
		"download",
		"grab",
		"rename",
		"upgrade",
		"moviefile.import",
		"moviefile.download",
		"manualinteraction",
		"manualinteractionrequired",
	]);
	if (!ITEM_EVENT_TYPES.has(eventType)) {
		return { kind: "unsupported", reason: `eventType=${eventType || "unknown"} not item-level` };
	}

	const series = p.series as Record<string, unknown> | undefined;
	if (series && typeof series === "object" && typeof series.id === "number") {
		return { kind: "import", mediaType: "series", arrItemId: series.id as number };
	}
	const movie = p.movie as Record<string, unknown> | undefined;
	if (movie && typeof movie === "object" && typeof movie.id === "number") {
		return { kind: "import", mediaType: "movie", arrItemId: movie.id as number };
	}
	return {
		kind: "unsupported",
		reason: `eventType=${eventType || "unknown"}, no series/movie id`,
	};
}

// ============================================================================
// *arr item → CacheItemForEval adapter
// ============================================================================

async function fetchAndAdaptItem(
	arrClient: ArrClient,
	event: Extract<ConnectEvent, { kind: "import" }>,
	instanceId: string,
): Promise<CacheItemForEval> {
	const accessor = event.mediaType === "series" ? "series" : "movie";
	// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
	const resource = (arrClient as any)[accessor];
	const raw = await resource.getById(event.arrItemId);

	// CacheItemForEval mirrors LibraryCache. We synthesize what the evaluator
	// needs from the live API response.
	return adaptLiveArrItemForAutoTag(raw as Record<string, unknown>, {
		instanceId,
		arrItemId: event.arrItemId,
		itemType: event.mediaType,
	});
}

// ============================================================================
// Rule scope + evaluation (mirrors the executor's logic)
// ============================================================================

function ruleAppliesToInstance(
	rule: AutoTagRule,
	instanceId: string,
	instanceService: string,
): boolean {
	// instanceFilter (JSON array of ids): if set + non-empty, must include this
	const instanceFilter = parseStringArray(rule.instanceFilter);
	if (instanceFilter && instanceFilter.length > 0 && !instanceFilter.includes(instanceId)) {
		return false;
	}
	// serviceFilter (JSON array of service slugs): if set + non-empty, must include this
	const serviceFilter = parseStringArray(rule.serviceFilter);
	if (serviceFilter && serviceFilter.length > 0) {
		const slug = instanceService.toLowerCase();
		if (!serviceFilter.map((s) => s.toLowerCase()).includes(slug)) return false;
	}
	return true;
}

interface AdaptedRule {
	ruleType: string;
	parameters: Record<string, unknown>;
	operator: "AND" | "OR" | null;
	conditions: Array<{ ruleType: string; parameters: Record<string, unknown> }> | null;
	plexLibraryFilter: string[] | null;
	excludeTags: number[] | null;
	excludeTitles: string[] | null;
}

function adaptRuleForEval(rule: AutoTagRule): AdaptedRule {
	return {
		ruleType: rule.ruleType,
		parameters: parseObject(rule.parameters),
		operator: rule.operator as "AND" | "OR" | null,
		conditions: parseArray<{ ruleType: string; parameters: Record<string, unknown> }>(
			rule.conditions,
		),
		plexLibraryFilter: parseStringArray(rule.plexLibraryFilter),
		excludeTags: parseNumberArray(rule.excludeTags),
		excludeTitles: parseStringArray(rule.excludeTitles),
	};
}

function matchesRule(
	item: CacheItemForEval,
	rule: AdaptedRule,
	ctx: Awaited<ReturnType<typeof buildEvalContextWithHealth>>["ctx"],
	failedSources: Set<DataSourceDependency>,
): RuleEvaluationState {
	// Apply excludeTags pre-filter (item carries any excluded tag → skip)
	if (rule.excludeTags && rule.excludeTags.length > 0) {
		const itemTags = extractItemTags(item.data);
		if (itemTags.some((t) => rule.excludeTags?.includes(t))) return "false";
	}
	// Apply excludeTitles pre-filter
	if (rule.excludeTitles && rule.excludeTitles.length > 0) {
		for (const pattern of rule.excludeTitles) {
			try {
				if (new RegExp(pattern, "i").test(item.title)) return "false";
			} catch {
				// invalid regex; skip pattern
			}
		}
	}

	const plexLibFilter = rule.plexLibraryFilter ?? null;

	if (rule.operator && rule.conditions && rule.conditions.length > 0) {
		if (rule.operator === "AND") {
			let unknown = false;
			for (const cond of rule.conditions) {
				const evaluation = evaluateSingleConditionState(
					item,
					cond.ruleType,
					cond.parameters,
					ctx,
					plexLibFilter,
					failedSources,
				);
				if (evaluation.state === "false") return "false";
				if (evaluation.state === "unknown") unknown = true;
			}
			return unknown ? "unknown" : "true";
		}
		// OR
		let unknown = false;
		for (const cond of rule.conditions) {
			const evaluation = evaluateSingleConditionState(
				item,
				cond.ruleType,
				cond.parameters,
				ctx,
				plexLibFilter,
				failedSources,
			);
			if (evaluation.state === "true") return "true";
			if (evaluation.state === "unknown") unknown = true;
		}
		return unknown ? "unknown" : "false";
	}

	return evaluateSingleConditionState(
		item,
		rule.ruleType,
		rule.parameters,
		ctx,
		plexLibFilter,
		failedSources,
	).state;
}

async function safeBuildContext(
	deps: WebhookHandlerDeps,
	userId: string,
	rules: AutoTagRule[],
	log: FastifyBaseLogger,
): Promise<Awaited<ReturnType<typeof buildEvalContextWithHealth>>> {
	try {
		const evidence = await buildEvalContextWithHealth(
			{
				prisma: deps.prisma,
				arrClientFactory: deps.arrClientFactory,
				encryptor: deps.encryptor,
				log,
			},
			userId,
			rules.map((r) => ({
				enabled: true,
				ruleType: r.ruleType,
				parameters: r.parameters,
				operator: r.operator,
				conditions: r.conditions,
				plexLibraryFilter: r.plexLibraryFilter,
			})),
		);
		const tmdbKeys = collectRawListIdentifiers(rules, "tmdb_list_member", "listId");
		if (tmdbKeys.length > 0) {
			const lists = await loadCompleteListEvidence(deps.prisma, userId, "tmdb", tmdbKeys);
			if (lists) {
				evidence.ctx.tmdbListMemberships = lists.memberships;
				evidence.failedSources.delete("tmdb");
			} else {
				evidence.ctx.tmdbListMemberships = undefined;
				evidence.failedSources.add("tmdb");
			}
		}
		const traktKeys = collectRawListIdentifiers(rules, "trakt_list_member", "listSlug");
		if (traktKeys.length > 0) {
			const lists = await loadCompleteListEvidence(deps.prisma, userId, "trakt", traktKeys);
			if (lists) {
				evidence.ctx.traktListMemberships = lists.memberships;
				evidence.failedSources.delete("trakt");
			} else {
				evidence.ctx.traktListMemberships = undefined;
				evidence.failedSources.add("trakt");
			}
		}
		return evidence;
	} catch (err) {
		log.warn({ err }, "Failed to build evaluation context — provider rules remain unknown");
		return {
			ctx: { now: new Date() },
			failedSources: new Set(["seerr", "tautulli", "plex", "jellyfin", "tmdb", "trakt"]),
		};
	}
}

function collectRawListIdentifiers(
	rules: AutoTagRule[],
	ruleType: "tmdb_list_member" | "trakt_list_member",
	parameterName: "listId" | "listSlug",
): string[] {
	const values = new Set<string>();
	for (const rule of rules) {
		const adapted = adaptRuleForEval(rule);
		if (adapted.ruleType === ruleType) {
			const value = adapted.parameters[parameterName];
			if (typeof value === "string" && value.length > 0) values.add(value);
		}
		for (const condition of adapted.conditions ?? []) {
			if (condition.ruleType !== ruleType) continue;
			const value = condition.parameters[parameterName];
			if (typeof value === "string" && value.length > 0) values.add(value);
		}
	}
	return [...values].sort();
}

// ============================================================================
// Helpers
// ============================================================================

async function ensureTag(client: ArrClient, label: string): Promise<number> {
	const tags = (await client.tag.getAll()) as Array<{ id: number; label: string }>;
	const existing = tags.find((t) => t.label === label);
	if (existing) return existing.id;
	// biome-ignore lint/suspicious/noExplicitAny: SDK Tag union typing requires the cast
	const created = (await (client.tag as any).create({ label })) as { id: number; label: string };
	return created.id;
}

function parseObject(value: string | null): Record<string, unknown> {
	if (!value) return {};
	const parsed = safeJsonParse(value);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}
	return {};
}

function parseStringArray(value: string | null): string[] | null {
	if (!value) return null;
	const parsed = safeJsonParse(value);
	if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
	return null;
}

function parseNumberArray(value: string | null): number[] | null {
	if (!value) return null;
	const parsed = safeJsonParse(value);
	if (Array.isArray(parsed)) return parsed.filter((v): v is number => typeof v === "number");
	return null;
}

function parseArray<T>(value: string | null): T[] | null {
	if (!value) return null;
	const parsed = safeJsonParse(value);
	if (Array.isArray(parsed)) return parsed as T[];
	return null;
}

function extractItemTags(data: string): number[] {
	const parsed = safeJsonParse(data);
	if (!parsed || typeof parsed !== "object") return [];
	const tags = (parsed as { tags?: unknown }).tags;
	if (!Array.isArray(tags)) return [];
	return tags.filter((t): t is number => typeof t === "number");
}
