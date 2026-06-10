/**
 * Auto-Tagger — rule execution engine.
 *
 * Walks LibraryCache items per instance, evaluates them against the rule's
 * criteria DSL (reusing `evaluateSingleCondition` from library-cleanup),
 * and applies the destination tag to matches via the source *arr's tag
 * write API (get-or-create the tag, fetch existing tags from cache,
 * merge, PUT update).
 *
 * Companion to Label Sync: Auto-Tagger seeds tags on the source service;
 * Label Sync optionally propagates them. See `memory/auto-tagger-arc.md`.
 */

import { ArrError } from "arr-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClient, ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { triggerLabelSyncForItem } from "../label-sync/trigger-for-item.js";
import { buildEvalContext } from "../library-cleanup/cleanup-executor.js";
import { evaluateSingleCondition } from "../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval, EvalContext } from "../library-cleanup/types.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import { safeJsonParse } from "../utils/json.js";
import { autoTagRuleMatchesViaEngine } from "../rules/auto-tag-adapter.js";

export interface AutoTagRuleInput {
	id: string;
	userId: string;
	name: string;
	ruleType: string;
	parameters: Record<string, unknown>;
	operator: "AND" | "OR" | null;
	conditions: Array<{ ruleType: string; parameters: Record<string, unknown> }> | null;
	serviceFilter: string[] | null;
	instanceFilter: string[] | null;
	excludeTags: number[] | null;
	excludeTitles: string[] | null;
	plexLibraryFilter: string[] | null;
	tagName: string;
}

export interface AutoTagRunResult {
	status: "success" | "partial" | "failed";
	message: string;
	totals: {
		instancesScanned: number;
		itemsScanned: number;
		itemsMatched: number;
		tagsApplied: number;
		failures: number;
	};
}

interface ExecuteOpts {
	rule: AutoTagRuleInput;
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

const SERVICE_TYPE_MAP: Record<string, "SONARR" | "RADARR"> = {
	sonarr: "SONARR",
	radarr: "RADARR",
};

// Cursor-pagination batch size for libraryCache reads. Mirrors
// CACHE_QUERY_BATCH_SIZE in library-cleanup/cleanup-executor.ts.
const AUTO_TAG_BATCH_SIZE = 500;

/**
 * Execute an auto-tagger rule. Pure-execution function — does NOT persist
 * the result. Callers should write `lastRunAt` / `lastRunStatus` /
 * `lastRunMessage` themselves so the rule's persistence model stays
 * decoupled from the engine.
 */
export async function executeAutoTagRule(opts: ExecuteOpts): Promise<AutoTagRunResult> {
	const { rule, prisma, arrClientFactory, encryptor, log } = opts;
	const childLog = log.child({ ruleId: rule.id, ruleName: rule.name });

	// Resolve scoped instances. Rule scope = (serviceFilter ∩ instanceFilter)
	// across the user's enabled *arr instances. Lidarr/Readarr deferred —
	// only Sonarr/Radarr have the LibraryCache shape we evaluate against.
	const instances = await prisma.serviceInstance.findMany({
		where: {
			userId: rule.userId,
			enabled: true,
			service: { in: ["SONARR", "RADARR"] },
			...(rule.serviceFilter && rule.serviceFilter.length > 0
				? {
						service: {
							in: rule.serviceFilter
								.map((s) => SERVICE_TYPE_MAP[s.toLowerCase()])
								.filter((v): v is "SONARR" | "RADARR" => v !== undefined),
						},
					}
				: {}),
			...(rule.instanceFilter && rule.instanceFilter.length > 0
				? { id: { in: rule.instanceFilter } }
				: {}),
		},
	});

	if (instances.length === 0) {
		return failure("No enabled Sonarr/Radarr instances match the rule scope.");
	}

	// Build prefetch context once for the whole run.
	// `buildEvalContext` reads the rule shape (ruleType + conditions JSON
	// string) to decide which prefetches are needed. We synthesize the
	// shape it expects from our rule.
	let evalCtx: EvalContext;
	try {
		evalCtx = await buildEvalContext({ prisma, arrClientFactory, log: childLog }, rule.userId, [
			{
				enabled: true,
				ruleType: rule.ruleType,
				conditions: rule.conditions ? JSON.stringify(rule.conditions) : null,
			},
		]);
	} catch (err) {
		childLog.warn({ err }, "Failed to build evaluation context — proceeding with empty maps");
		evalCtx = { now: new Date() };
	}

	// Layer in TMDb/Trakt list-membership prefetch — these aren't part of
	// `buildEvalContext` (which is owned by library-cleanup) so we add
	// them here for any rule that uses tmdb_list_member / trakt_list_member.
	evalCtx.tmdbListMemberships = await prefetchListMemberships(
		prisma,
		rule,
		"tmdb_list_member",
		"listId",
		"tmdb",
	);
	evalCtx.traktListMemberships = await prefetchListMemberships(
		prisma,
		rule,
		"trakt_list_member",
		"listSlug",
		"trakt",
	);

	const compiledTitleRegexes = compileTitlePatterns(rule.excludeTitles, childLog);

	let totalScanned = 0;
	let totalMatched = 0;
	let totalApplied = 0;
	let totalFailures = 0;

	for (const instance of instances) {
		const result = await processInstance({
			rule,
			instance,
			prisma,
			arrClientFactory,
			encryptor,
			evalCtx,
			compiledTitleRegexes,
			log: childLog.child({ instanceId: instance.id }),
		});
		totalScanned += result.scanned;
		totalMatched += result.matched;
		totalApplied += result.applied;
		totalFailures += result.failures;
	}

	const totals = {
		instancesScanned: instances.length,
		itemsScanned: totalScanned,
		itemsMatched: totalMatched,
		tagsApplied: totalApplied,
		failures: totalFailures,
	};

	if (totalMatched === 0 && totalFailures === 0) {
		return {
			status: "success",
			message: `No items matched (${totalScanned} scanned across ${instances.length} instance${instances.length === 1 ? "" : "s"}).`,
			totals,
		};
	}

	if (totalFailures > 0 && totalApplied === 0) {
		return {
			status: "failed",
			message: `All ${totalFailures} tag applications failed.`,
			totals,
		};
	}

	if (totalFailures > 0) {
		return {
			status: "partial",
			message: `Applied tag "${rule.tagName}" to ${totalApplied} item${totalApplied === 1 ? "" : "s"}, ${totalFailures} failure${totalFailures === 1 ? "" : "s"}.`,
			totals,
		};
	}

	return {
		status: "success",
		message: `Applied tag "${rule.tagName}" to ${totalApplied} item${totalApplied === 1 ? "" : "s"} across ${instances.length} instance${instances.length === 1 ? "" : "s"}.`,
		totals,
	};
}

interface ProcessInstanceArgs {
	rule: AutoTagRuleInput;
	instance: ServiceInstance;
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	evalCtx: EvalContext;
	compiledTitleRegexes: RegExp[];
	log: FastifyBaseLogger;
}

interface ProcessInstanceResult {
	scanned: number;
	matched: number;
	applied: number;
	failures: number;
}

async function processInstance(args: ProcessInstanceArgs): Promise<ProcessInstanceResult> {
	const {
		rule,
		instance,
		prisma,
		arrClientFactory,
		encryptor,
		evalCtx,
		compiledTitleRegexes,
		log,
	} = args;

	const matched: Array<{ item: CacheItemForEval; existingTags: number[] }> = [];
	let totalScanned = 0;
	let cursor: string | undefined;

	// Cursor-paginate to bound peak heap. The full library can be 100k+ items
	// with each row's `data` JSON blob 10–50 KB; loading all at once trips
	// the 768 MB container heap cap, especially under webhook concurrency.
	while (true) {
		const batch = await prisma.libraryCache.findMany({
			where: { instanceId: instance.id },
			select: {
				id: true,
				instanceId: true,
				arrItemId: true,
				itemType: true,
				title: true,
				year: true,
				monitored: true,
				hasFile: true,
				status: true,
				qualityProfileId: true,
				qualityProfileName: true,
				sizeOnDisk: true,
				arrAddedAt: true,
				data: true,
			},
			take: AUTO_TAG_BATCH_SIZE,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
			orderBy: { id: "asc" },
		});

		if (batch.length === 0) break;
		totalScanned += batch.length;

		for (const item of batch) {
			if (compiledTitleRegexes.some((re) => re.test(item.title))) continue;

			// Parse the data blob once per item — needed for excludeTags + tag merge.
			const dataParsed = safeJsonParse(item.data);
			const existingTags = extractTagIds(dataParsed);

			if (rule.excludeTags && rule.excludeTags.length > 0) {
				if (existingTags.some((t) => rule.excludeTags?.includes(t))) continue;
			}

			const cacheItem = item as CacheItemForEval;
			const matches = autoTagRuleMatchesViaEngine(cacheItem, rule, instance.service, evalCtx);
			if (matches) matched.push({ item: cacheItem, existingTags });
		}

		cursor = batch[batch.length - 1]!.id;
		if (batch.length < AUTO_TAG_BATCH_SIZE) break;
	}

	if (matched.length === 0) {
		return { scanned: totalScanned, matched: 0, applied: 0, failures: 0 };
	}

	// Group write phase: build one ArrClient + ensureTag once for the whole instance.
	let arrClient: ArrClient;
	try {
		arrClient = arrClientFactory.create({
			id: instance.id,
			baseUrl: instance.baseUrl,
			encryptedApiKey: instance.encryptedApiKey,
			encryptionIv: instance.encryptionIv,
			service: instance.service,
			label: instance.label,
		});
	} catch (err) {
		log.warn({ err }, "Failed to create *arr client; skipping instance writes");
		return {
			scanned: totalScanned,
			matched: matched.length,
			applied: 0,
			failures: matched.length,
		};
	}

	let tagId: number;
	try {
		tagId = await ensureTag(arrClient, rule.tagName);
	} catch (err) {
		const reason = err instanceof ArrError ? err.message : String(err);
		log.warn({ err: reason, tag: rule.tagName }, "Failed to get-or-create tag");
		return {
			scanned: totalScanned,
			matched: matched.length,
			applied: 0,
			failures: matched.length,
		};
	}

	let applied = 0;
	let failures = 0;
	for (const { item, existingTags } of matched) {
		if (existingTags.includes(tagId)) {
			applied++; // idempotent — already tagged
			continue;
		}
		const merged = [...existingTags, tagId];
		try {
			const accessor = item.itemType === "series" ? "series" : "movie";
			// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
			const resource = (arrClient as any)[accessor];
			// Radarr/Sonarr PUT endpoints require the full resource — validators
			// reject partial bodies with errors like "'Quality Profile Id' must
			// be greater than '0'". Fetch the current item so the update preserves
			// every field the *arr expects.
			const fullItem = await resource.getById(item.arrItemId);
			await resource.update(item.arrItemId, {
				...fullItem,
				id: item.arrItemId,
				tags: merged,
			});
			applied++;

			// Chain into Label Sync (Phase B): if any rules source from this
			// (instance, tagName), fire them inline so the destination service
			// (Plex/Jellyfin/Emby/etc.) gets the matching label without
			// waiting for the next scheduled Label Sync run.
			//
			// Failures here are non-fatal — auto-tagger's job (apply the tag)
			// already succeeded. Label Sync chain failures get logged but
			// don't change auto-tagger's per-item outcome.
			try {
				await triggerLabelSyncForItem({
					userId: rule.userId,
					sourceService: instance.service,
					sourceInstanceId: instance.id,
					arrItemId: item.arrItemId,
					itemType: item.itemType,
					tagName: rule.tagName,
					prisma,
					arrClientFactory,
					encryptor,
					log,
				});
			} catch (chainErr) {
				log.warn(
					{ err: chainErr, arrItemId: item.arrItemId, tagName: rule.tagName },
					"Label Sync chain trigger threw after auto-tag write (non-fatal)",
				);
			}
		} catch (err) {
			const reason = err instanceof ArrError ? err.message : String(err);
			log.warn({ err: reason, arrItemId: item.arrItemId }, "Failed to apply tag to item");
			failures++;
		}
	}

	return { scanned: totalScanned, matched: matched.length, applied, failures };
}

/**
 * Evaluate one rule against one cache item — handles both single-condition
 * rules and composite (AND/OR) rules. Mirrors `evaluateRule`'s composite
 * logic from library-cleanup but skips the cleanup-specific pre-filter
 * pass (we do excludeTags/excludeTitles ourselves above).
 */
export function evaluateAgainstRule(
	item: CacheItemForEval,
	rule: AutoTagRuleInput,
	instanceService: string,
	ctx: EvalContext,
): boolean {
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

	// Single-condition rule
	const reason = evaluateSingleCondition(item, rule.ruleType, rule.parameters, ctx, plexLibFilter);
	void instanceService; // reserved for future per-service rule-routing
	return reason !== null;
}

function compileTitlePatterns(patterns: string[] | null, log: FastifyBaseLogger): RegExp[] {
	if (!patterns || patterns.length === 0) return [];
	const compiled: RegExp[] = [];
	for (const pattern of patterns) {
		try {
			compiled.push(new RegExp(pattern, "i"));
		} catch (err) {
			log.warn({ err, pattern }, "Invalid title regex — skipping pattern");
		}
	}
	return compiled;
}

function extractTagIds(parsed: unknown): number[] {
	if (!parsed || typeof parsed !== "object") return [];
	const tags = (parsed as { tags?: unknown }).tags;
	if (!Array.isArray(tags)) return [];
	return tags.filter((t): t is number => typeof t === "number");
}

async function ensureTag(client: ArrClient, label: string): Promise<number> {
	const tags = (await client.tag.getAll()) as Array<{ id: number; label: string }>;
	const existing = tags.find((t) => t.label === label);
	if (existing) return existing.id;
	// biome-ignore lint/suspicious/noExplicitAny: SDK Tag union typing requires the cast
	const created = (await (client.tag as any).create({ label })) as { id: number; label: string };
	return created.id;
}

/**
 * Read the cached membership of every TMDb / Trakt list this rule
 * references and return a Map<listIdentifier, Set<tmdbId>> for the
 * evaluator to consult. Returns an empty map (not null) so the
 * evaluator can distinguish "no rule wants this" from "the prefetch
 * failed and we're in degraded mode."
 *
 * The cache itself is refreshed by the dedicated tmdb-list-cache /
 * trakt-list-cache schedulers every 4 hours; this read is just the
 * lookup half of that flow.
 */
async function prefetchListMemberships(
	prisma: PrismaClient,
	rule: AutoTagRuleInput,
	targetRuleType: "tmdb_list_member" | "trakt_list_member",
	identifierKey: "listId" | "listSlug",
	cacheKind: "tmdb" | "trakt",
): Promise<Map<string, Set<number>>> {
	const identifiers = collectListIdentifiersFromRule(rule, targetRuleType, identifierKey);
	if (identifiers.length === 0) return new Map();

	const out = new Map<string, Set<number>>();
	if (cacheKind === "tmdb") {
		const rows = await prisma.tmdbListCache.findMany({
			where: { userId: rule.userId, listId: { in: identifiers } },
			select: { listId: true, tmdbId: true },
		});
		for (const row of rows) {
			let bucket = out.get(row.listId);
			if (!bucket) {
				bucket = new Set();
				out.set(row.listId, bucket);
			}
			bucket.add(row.tmdbId);
		}
	} else {
		const rows = await prisma.traktListCache.findMany({
			where: { userId: rule.userId, listSlug: { in: identifiers } },
			select: { listSlug: true, tmdbId: true },
		});
		for (const row of rows) {
			let bucket = out.get(row.listSlug);
			if (!bucket) {
				bucket = new Set();
				out.set(row.listSlug, bucket);
			}
			bucket.add(row.tmdbId);
		}
	}
	return out;
}

function collectListIdentifiersFromRule(
	rule: AutoTagRuleInput,
	targetRuleType: "tmdb_list_member" | "trakt_list_member",
	identifierKey: "listId" | "listSlug",
): string[] {
	const identifiers: string[] = [];
	if (rule.ruleType === targetRuleType) {
		const id = rule.parameters[identifierKey];
		if (typeof id === "string" && id.length > 0) identifiers.push(id);
	}
	if (rule.ruleType === "composite" && rule.conditions) {
		for (const cond of rule.conditions) {
			if (cond.ruleType === targetRuleType) {
				const id = cond.parameters[identifierKey];
				if (typeof id === "string" && id.length > 0) identifiers.push(id);
			}
		}
	}
	return identifiers;
}

function failure(message: string): AutoTagRunResult {
	return {
		status: "failed",
		message,
		totals: {
			instancesScanned: 0,
			itemsScanned: 0,
			itemsMatched: 0,
			tagsApplied: 0,
			failures: 0,
		},
	};
}
