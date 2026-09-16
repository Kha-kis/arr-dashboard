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

import type { AutoTagPreviewResponse, DataSourceDependency } from "@arr/shared";
import { ArrError } from "arr-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClient, ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { triggerLabelSyncForItem } from "../label-sync/trigger-for-item.js";
import { buildEvalContextWithHealth } from "../library-cleanup/cleanup-executor.js";
import {
	evaluateSingleConditionState,
	type RuleEvaluationState,
} from "../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval, EvalContext } from "../library-cleanup/types.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import {
	collectNativePresenceInstances,
	loadNativePresenceContext,
	type NativePresenceContext,
} from "../provider-observation/native-presence-evidence.js";
import { safeJsonParse } from "../utils/json.js";
import { loadCompleteListEvidence } from "./list-evidence-loader.js";
import { adaptLiveArrItemForAutoTag } from "./live-arr-evidence.js";
import { acquireAutoTagTargetLock } from "./target-lock.js";
import { AutoTagAuthorityChangedError, isCurrentAutoTagTarget } from "./target-authorization.js";

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
	preview?: AutoTagPreviewResponse;
	status: "success" | "partial" | "failed";
	message: string;
	totals: {
		instancesScanned: number;
		itemsScanned: number;
		itemsMatched: number;
		tagsApplied: number;
		failures: number;
		itemsSkipped?: number;
	};
}

interface ExecuteOpts {
	/** Read-only candidate evaluation; never creates tags, writes ARR, or records a run. */
	dryRun?: boolean;
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
		if (opts.dryRun)
			return {
				...failure("No enabled Sonarr/Radarr instances match the rule scope."),
				preview: { itemsScanned: 0, itemsMatched: 0, itemsUnknown: 0, items: [], truncated: false },
			};
		return failure("No enabled Sonarr/Radarr instances match the rule scope.");
	}

	// Build prefetch context once for the whole run.
	// `buildEvalContext` reads the rule shape (ruleType + conditions JSON
	// string) to decide which prefetches are needed. We synthesize the
	// shape it expects from our rule.
	const { ctx: evalCtx, failedSources } = await buildRuleEvalContext({
		rule,
		prisma,
		arrClientFactory,
		encryptor,
		log: childLog,
	});

	const compiledTitleRegexes = compileTitlePatterns(rule.excludeTitles, childLog);

	let totalScanned = 0;
	let totalMatched = 0;
	let totalApplied = 0;
	let totalFailures = 0;
	let totalSkipped = 0;
	const previewItems: AutoTagPreviewResponse["items"] = [];

	for (const instance of instances) {
		const result = await processInstance({
			dryRun: opts.dryRun,
			previewItems,
			rule,
			instance,
			prisma,
			arrClientFactory,
			encryptor,
			evalCtx,
			failedSources,
			compiledTitleRegexes,
			log: childLog.child({ instanceId: instance.id }),
		});
		totalScanned += result.scanned;
		totalMatched += result.matched;
		totalApplied += result.applied;
		totalFailures += result.failures;
		totalSkipped += result.skipped ?? 0;
	}

	const totals = {
		instancesScanned: instances.length,
		itemsScanned: totalScanned,
		itemsMatched: totalMatched,
		tagsApplied: totalApplied,
		failures: totalFailures,
		...(totalSkipped > 0 ? { itemsSkipped: totalSkipped } : {}),
	};
	if (opts.dryRun) {
		return {
			status: "success",
			message: "Read-only rule preview",
			totals,
			preview: {
				itemsScanned: totalScanned,
				itemsMatched: totalMatched,
				itemsUnknown: totalSkipped,
				items: previewItems,
				truncated: totalMatched + totalSkipped > previewItems.length,
			},
		};
	}
	if (totalSkipped > 0) {
		return {
			status: totalApplied > 0 ? "partial" : "failed",
			message: `Applied ${totalApplied} tags; skipped ${totalSkipped} items because their rule evidence could not be verified. ${totalFailures} tag applications failed. Check the selected provider's inventory and item connections.`,
			totals,
		};
	}

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
	dryRun?: boolean;
	previewItems: AutoTagPreviewResponse["items"];
	rule: AutoTagRuleInput;
	instance: ServiceInstance;
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	evalCtx: EvalContext;
	failedSources: Set<DataSourceDependency>;
	compiledTitleRegexes: RegExp[];
	log: FastifyBaseLogger;
}

interface ProcessInstanceResult {
	scanned: number;
	matched: number;
	applied: number;
	failures: number;
	skipped?: number;
}

async function processInstance(args: ProcessInstanceArgs): Promise<ProcessInstanceResult> {
	const {
		rule,
		instance,
		prisma,
		arrClientFactory,
		encryptor,
		evalCtx,
		failedSources,
		compiledTitleRegexes,
		log,
	} = args;

	// Retain only target coordinates; full ARR payloads are fetched again before writing.
	const matched: Array<{ item: Pick<CacheItemForEval, "arrItemId" | "itemType"> }> = [];
	const usesNativePresence = collectNativePresenceInstances([rule]).length > 0;
	let totalScanned = 0;
	let skipped = 0;
	let cursor: string | undefined;

	// Cursor-paginate to bound peak heap. The full library can be 100k+ items
	// with each row's `data` JSON blob 10–50 KB; loading all at once trips
	// the 768 MB container heap cap, especially under webhook concurrency.
	while (true) {
		const batch = await prisma.libraryCache.findMany({
			where: { instanceId: instance.id, instance: { userId: rule.userId, enabled: true } },
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
			// Parse the data blob once per item — needed for excludeTags + tag merge.
			const dataParsed = safeJsonParse(item.data);
			const existingTags = extractTagIds(dataParsed);
			if (isExcludedByRule(item.title, existingTags, rule.excludeTags, compiledTitleRegexes)) {
				continue;
			}

			const cacheItem = item as CacheItemForEval;
			const state = evaluateAgainstRule(cacheItem, rule, instance.service, evalCtx, failedSources);
			if (state === "true")
				matched.push({ item: { arrItemId: item.arrItemId, itemType: item.itemType } });
			if (state === "unknown" && (args.dryRun || usesNativePresence)) skipped++;
			if (args.dryRun && state !== "false" && args.previewItems.length < 200) {
				args.previewItems.push({
					instanceId: item.instanceId,
					arrItemId: item.arrItemId,
					itemType: item.itemType,
					title: item.title,
					state,
					reason:
						state === "true"
							? "Matches the rule using the latest available observations"
							: "Required evidence is missing, stale, or ambiguous",
				});
			}
		}

		cursor = batch[batch.length - 1]!.id;
		if (batch.length < AUTO_TAG_BATCH_SIZE) break;
	}

	if (args.dryRun || matched.length === 0) {
		return { scanned: totalScanned, matched: matched.length, applied: 0, failures: 0, skipped };
	}

	// Build one ARR client; create the destination tag lazily after target revalidation.
	let arrClient: ArrClient;
	try {
		arrClient = arrClientFactory.create({
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
		log.warn({ err }, "Failed to create *arr client; skipping instance writes");
		return {
			scanned: totalScanned,
			matched: matched.length,
			applied: 0,
			failures: matched.length,
			skipped,
		};
	}

	let tagId: number | undefined;

	let applied = 0;
	let failures = 0;
	for (const { item } of matched) {
		const releaseTarget = await acquireAutoTagTargetLock(instance, item.arrItemId);
		try {
			if (item.itemType !== "movie" && item.itemType !== "series") {
				throw new Error("Auto-tag target is not a Radarr movie or Sonarr series");
			}
			const accessor = item.itemType === "series" ? "series" : "movie";
			// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
			const resource = (arrClient as any)[accessor];
			// Radarr/Sonarr PUT endpoints require the full resource — validators
			// reject partial bodies with errors like "'Quality Profile Id' must
			// be greater than '0'". Fetch the current item so the update preserves
			// every field the *arr expects.
			const fullItem = (await resource.getById(item.arrItemId)) as Record<string, unknown>;
			const latestItem = adaptLiveArrItemForAutoTag(fullItem, {
				instanceId: instance.id,
				arrItemId: item.arrItemId,
				itemType: item.itemType,
			});
			const latestTags = extractTagIds(fullItem);
			if (isExcludedByRule(latestItem.title, latestTags, rule.excludeTags, compiledTitleRegexes)) {
				continue;
			}
			const latestEvidence = await buildRuleEvalContext({
				rule,
				prisma,
				arrClientFactory,
				encryptor,
				log,
				previousNativePresence: evalCtx.nativePresence,
			});
			if (
				evaluateAgainstRule(
					latestItem,
					rule,
					instance.service,
					latestEvidence.ctx,
					latestEvidence.failedSources,
				) !== "true"
			) {
				if (usesNativePresence) skipped++;
				continue;
			}
			if (usesNativePresence && !(await isCurrentAutoTagTarget(prisma, rule.userId, instance))) {
				skipped++;
				continue;
			}
			const assertNativeAuthority = async () => {
				const boundaryEvidence = await buildRuleEvalContext({
					rule,
					prisma,
					arrClientFactory,
					encryptor,
					log,
					previousNativePresence: latestEvidence.ctx.nativePresence,
				});
				if (
					evaluateAgainstRule(
						latestItem,
						rule,
						instance.service,
						boundaryEvidence.ctx,
						boundaryEvidence.failedSources,
					) !== "true" ||
					!(await isCurrentAutoTagTarget(prisma, rule.userId, instance))
				)
					throw new AutoTagAuthorityChangedError();
			};
			// The callback runs after the remote tag listing, immediately before creation.
			tagId ??= await ensureTag(
				arrClient,
				rule.tagName,
				usesNativePresence ? assertNativeAuthority : undefined,
			);
			if (usesNativePresence) await assertNativeAuthority();
			if (latestTags.includes(tagId)) {
				applied++;
				continue;
			}
			await resource.update(item.arrItemId, {
				...fullItem,
				id: item.arrItemId,
				tags: [...latestTags, tagId],
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
			if (err instanceof AutoTagAuthorityChangedError) {
				skipped++;
				continue;
			}
			const reason = err instanceof ArrError ? err.message : String(err);
			log.warn({ err: reason, arrItemId: item.arrItemId }, "Failed to apply tag to item");
			failures++;
		} finally {
			releaseTarget();
		}
	}

	return { scanned: totalScanned, matched: matched.length, applied, failures, skipped };
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
	failedSources: Set<DataSourceDependency>,
): RuleEvaluationState {
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

	// Single-condition rule
	const evaluation = evaluateSingleConditionState(
		item,
		rule.ruleType,
		rule.parameters,
		ctx,
		plexLibFilter,
		failedSources,
	);
	void instanceService; // reserved for future per-service rule-routing
	return evaluation.state;
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

function isExcludedByRule(
	title: string,
	tags: number[],
	excludeTags: number[] | null,
	excludeTitlePatterns: RegExp[],
): boolean {
	if (excludeTitlePatterns.some((pattern) => pattern.test(title))) return true;
	return excludeTags?.some((tagId) => tags.includes(tagId)) ?? false;
}

function extractTagIds(parsed: unknown): number[] {
	if (!parsed || typeof parsed !== "object") return [];
	const tags = (parsed as { tags?: unknown }).tags;
	if (!Array.isArray(tags)) return [];
	return tags.filter((t): t is number => typeof t === "number");
}

async function ensureTag(
	client: ArrClient,
	label: string,
	beforeCreate?: () => Promise<void>,
): Promise<number> {
	const tags = (await client.tag.getAll()) as Array<{ id: number; label: string }>;
	const existing = tags.find((t) => t.label === label);
	if (existing) return existing.id;
	await beforeCreate?.();
	// biome-ignore lint/suspicious/noExplicitAny: SDK Tag union typing requires the cast
	const created = (await (client.tag as any).create({ label })) as { id: number; label: string };
	return created.id;
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

async function buildRuleEvalContext(args: {
	rule: AutoTagRuleInput;
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
	previousNativePresence?: NativePresenceContext;
}): Promise<{ ctx: EvalContext; failedSources: Set<DataSourceDependency> }> {
	const { rule, prisma, arrClientFactory, encryptor, log } = args;
	let ctx: EvalContext;
	let failedSources = new Set<DataSourceDependency>();
	try {
		const evidence = await buildEvalContextWithHealth(
			{ prisma, arrClientFactory, encryptor, log },
			rule.userId,
			[
				{
					enabled: true,
					ruleType: rule.ruleType,
					parameters: JSON.stringify(rule.parameters),
					operator: rule.operator,
					conditions: rule.conditions ? JSON.stringify(rule.conditions) : null,
					plexLibraryFilter: rule.plexLibraryFilter ? JSON.stringify(rule.plexLibraryFilter) : null,
				},
			],
		);
		ctx = evidence.ctx;
		failedSources = evidence.failedSources;
	} catch (err) {
		log.warn({ err }, "Failed to build evaluation context — provider rules remain unknown");
		ctx = { now: new Date() };
		failedSources = new Set(["seerr", "tautulli", "plex", "jellyfin", "tmdb", "trakt"]);
	}

	const tmdbListIds = collectListIdentifiersFromRule(rule, "tmdb_list_member", "listId");
	if (tmdbListIds.length > 0) {
		const evidence = await loadCompleteListEvidence(prisma, rule.userId, "tmdb", tmdbListIds);
		if (evidence) {
			ctx.tmdbListMemberships = evidence.memberships;
			failedSources.delete("tmdb");
		} else {
			ctx.tmdbListMemberships = undefined;
			failedSources.add("tmdb");
		}
	}
	const traktListSlugs = collectListIdentifiersFromRule(rule, "trakt_list_member", "listSlug");
	if (traktListSlugs.length > 0) {
		const evidence = await loadCompleteListEvidence(prisma, rule.userId, "trakt", traktListSlugs);
		if (evidence) {
			ctx.traktListMemberships = evidence.memberships;
			failedSources.delete("trakt");
		} else {
			ctx.traktListMemberships = undefined;
			failedSources.add("trakt");
		}
	}
	const nativeInstances = collectNativePresenceInstances([rule]);
	if (nativeInstances.length > 0) {
		ctx.nativePresence = await loadNativePresenceContext(
			prisma,
			rule.userId,
			nativeInstances,
			args.previousNativePresence,
		);
	}
	return { ctx, failedSources };
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
