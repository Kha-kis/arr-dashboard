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
import { buildEvalContext } from "../library-cleanup/cleanup-executor.js";
import { evaluateSingleCondition } from "../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval, EvalContext } from "../library-cleanup/types.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import { safeJsonParse } from "../utils/json.js";

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

/**
 * Execute an auto-tagger rule. Pure-execution function — does NOT persist
 * the result. Callers should write `lastRunAt` / `lastRunStatus` /
 * `lastRunMessage` themselves so the rule's persistence model stays
 * decoupled from the engine.
 */
export async function executeAutoTagRule(opts: ExecuteOpts): Promise<AutoTagRunResult> {
	const { rule, prisma, arrClientFactory, log } = opts;
	// `encryptor` is accepted for executor-signature symmetry with Label Sync but
	// not used directly here — `arrClientFactory.create` handles api-key
	// decryption internally for the tag-write phase, and the read phase comes
	// from `LibraryCache` which is already populated.
	void opts.encryptor;
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
	const { rule, instance, prisma, arrClientFactory, evalCtx, compiledTitleRegexes, log } = args;

	const items = await prisma.libraryCache.findMany({
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
	});

	const matched: Array<{ item: CacheItemForEval; existingTags: number[] }> = [];

	for (const item of items) {
		if (compiledTitleRegexes.some((re) => re.test(item.title))) continue;

		// Parse the data blob once per item — needed for excludeTags + tag merge.
		const dataParsed = safeJsonParse(item.data);
		const existingTags = extractTagIds(dataParsed);

		if (rule.excludeTags && rule.excludeTags.length > 0) {
			if (existingTags.some((t) => rule.excludeTags?.includes(t))) continue;
		}

		const cacheItem = item as CacheItemForEval;
		const matches = evaluateAgainstRule(cacheItem, rule, instance.service, evalCtx);
		if (matches) matched.push({ item: cacheItem, existingTags });
	}

	if (matched.length === 0) {
		return { scanned: items.length, matched: 0, applied: 0, failures: 0 };
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
		return { scanned: items.length, matched: matched.length, applied: 0, failures: matched.length };
	}

	let tagId: number;
	try {
		tagId = await ensureTag(arrClient, rule.tagName);
	} catch (err) {
		const reason = err instanceof ArrError ? err.message : String(err);
		log.warn({ err: reason, tag: rule.tagName }, "Failed to get-or-create tag");
		return { scanned: items.length, matched: matched.length, applied: 0, failures: matched.length };
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
			await resource.update(item.arrItemId, { id: item.arrItemId, tags: merged });
			applied++;
		} catch (err) {
			const reason = err instanceof ArrError ? err.message : String(err);
			log.warn({ err: reason, arrItemId: item.arrItemId }, "Failed to apply tag to item");
			failures++;
		}
	}

	return { scanned: items.length, matched: matched.length, applied, failures };
}

/**
 * Evaluate one rule against one cache item — handles both single-condition
 * rules and composite (AND/OR) rules. Mirrors `evaluateRule`'s composite
 * logic from library-cleanup but skips the cleanup-specific pre-filter
 * pass (we do excludeTags/excludeTitles ourselves above).
 */
function evaluateAgainstRule(
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
