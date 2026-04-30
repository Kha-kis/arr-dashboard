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
import { ArrError } from "arr-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClient, ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { buildEvalContext } from "../library-cleanup/cleanup-executor.js";
import { evaluateSingleCondition } from "../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval } from "../library-cleanup/types.js";
import type { AutoTagRule, PrismaClient, ServiceInstance, User } from "../prisma.js";
import { safeJsonParse } from "../utils/json.js";

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
	const ctx = await safeBuildContext(deps, user.id, applicable, log);

	let tagsApplied = 0;
	const tagsToApply: string[] = [];
	for (const rule of applicable) {
		const ruleInput = adaptRuleForEval(rule);
		if (matchesRule(cacheItem, ruleInput, ctx)) {
			tagsToApply.push(rule.tagName);
		}
	}

	if (tagsToApply.length === 0) {
		return {
			status: "ok",
			message: "No rules matched the imported item.",
			rulesEvaluated: applicable.length,
		};
	}

	// Apply each unique tag. Use ensureTag + series/movie.update with merge
	// semantics — same pattern as the scheduled executor.
	const uniqueTags = [...new Set(tagsToApply)];

	// `cacheItem.data` is the JSON-stringified full *arr item we already
	// fetched in `fetchAndAdaptItem` above — reuse it instead of doing a
	// second `getById` (which on transient failure used to silent-fall-back
	// to `existingTags = []` and erase the user's existing tags on write).
	const existingTags = extractItemTags(cacheItem.data);

	const newTagIds: number[] = [];
	for (const tagName of uniqueTags) {
		try {
			const tagId = await ensureTag(arrClient, tagName);
			if (!existingTags.includes(tagId) && !newTagIds.includes(tagId)) {
				newTagIds.push(tagId);
			}
			tagsApplied++;
		} catch (err) {
			log.warn({ err, tag: tagName }, "Failed to ensure tag");
		}
	}

	if (newTagIds.length > 0) {
		const merged = [...existingTags, ...newTagIds];
		try {
			const accessor = event.mediaType === "series" ? "series" : "movie";
			// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
			const resource = (arrClient as any)[accessor];
			await resource.update(event.arrItemId, { id: event.arrItemId, tags: merged });
		} catch (err) {
			const reason = err instanceof ArrError ? err.message : String(err);
			log.warn({ err: reason }, "Failed to update item tags");
			return { status: "error", message: `Tag update failed: ${reason}` };
		}
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

interface ConnectEvent {
	kind: "import" | "test" | "unsupported";
	mediaType?: "series" | "movie";
	arrItemId?: number;
	reason?: string;
}

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
	event: ConnectEvent,
	instanceId: string,
): Promise<CacheItemForEval> {
	if (!event.mediaType || event.arrItemId === undefined) {
		throw new Error("Cannot fetch item without mediaType + arrItemId");
	}
	const accessor = event.mediaType === "series" ? "series" : "movie";
	// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
	const resource = (arrClient as any)[accessor];
	const raw = await resource.getById(event.arrItemId);

	// CacheItemForEval mirrors LibraryCache. We synthesize what the evaluator
	// needs from the live API response.
	const r = raw as Record<string, unknown>;
	const sizeOnDisk = typeof r.sizeOnDisk === "number" ? BigInt(r.sizeOnDisk) : BigInt(0);
	const arrAddedAt = typeof r.added === "string" ? new Date(r.added) : null;
	const qualityProfileId = typeof r.qualityProfileId === "number" ? r.qualityProfileId : null;
	const monitored = typeof r.monitored === "boolean" ? r.monitored : true;
	const hasFile = inferHasFile(r, event.mediaType);
	const status = typeof r.status === "string" ? r.status : null;
	const title = typeof r.title === "string" ? r.title : "(untitled)";
	const year = typeof r.year === "number" ? r.year : null;

	return {
		id: `webhook-${instanceId}-${event.arrItemId}`,
		instanceId,
		arrItemId: event.arrItemId,
		itemType: event.mediaType,
		title,
		year,
		monitored,
		hasFile,
		status,
		qualityProfileId,
		qualityProfileName: null,
		sizeOnDisk,
		arrAddedAt,
		data: JSON.stringify(raw),
	};
}

function inferHasFile(item: Record<string, unknown>, mediaType: "series" | "movie"): boolean {
	if (mediaType === "movie") {
		// Radarr's hasFile is a top-level boolean
		return typeof item.hasFile === "boolean" ? item.hasFile : false;
	}
	// Sonarr's series.hasFile isn't always present; fall back to statistics
	const stats = item.statistics as Record<string, unknown> | undefined;
	if (stats && typeof stats.episodeFileCount === "number") {
		return stats.episodeFileCount > 0;
	}
	return false;
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
	ctx: Awaited<ReturnType<typeof buildEvalContext>>,
): boolean {
	// Apply excludeTags pre-filter (item carries any excluded tag → skip)
	if (rule.excludeTags && rule.excludeTags.length > 0) {
		const itemTags = extractItemTags(item.data);
		if (itemTags.some((t) => rule.excludeTags?.includes(t))) return false;
	}
	// Apply excludeTitles pre-filter
	if (rule.excludeTitles && rule.excludeTitles.length > 0) {
		for (const pattern of rule.excludeTitles) {
			try {
				if (new RegExp(pattern, "i").test(item.title)) return false;
			} catch {
				// invalid regex; skip pattern
			}
		}
	}

	const plexLibFilter = rule.plexLibraryFilter ?? null;

	if (rule.operator && rule.conditions && rule.conditions.length > 0) {
		if (rule.operator === "AND") {
			for (const cond of rule.conditions) {
				const reason = evaluateSingleCondition(
					item,
					cond.ruleType,
					cond.parameters,
					ctx,
					plexLibFilter,
				);
				if (reason === null) return false;
			}
			return true;
		}
		// OR
		for (const cond of rule.conditions) {
			const reason = evaluateSingleCondition(
				item,
				cond.ruleType,
				cond.parameters,
				ctx,
				plexLibFilter,
			);
			if (reason !== null) return true;
		}
		return false;
	}

	const reason = evaluateSingleCondition(item, rule.ruleType, rule.parameters, ctx, plexLibFilter);
	return reason !== null;
}

async function safeBuildContext(
	deps: WebhookHandlerDeps,
	userId: string,
	rules: AutoTagRule[],
	log: FastifyBaseLogger,
): Promise<Awaited<ReturnType<typeof buildEvalContext>>> {
	try {
		return await buildEvalContext(
			{ prisma: deps.prisma, arrClientFactory: deps.arrClientFactory, log },
			userId,
			rules.map((r) => ({
				enabled: true,
				ruleType: r.ruleType,
				conditions: r.conditions,
			})),
		);
	} catch (err) {
		log.warn({ err }, "Failed to build evaluation context — continuing with empty maps");
		return { now: new Date() };
	}
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
