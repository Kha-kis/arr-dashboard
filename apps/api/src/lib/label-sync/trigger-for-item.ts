/**
 * Event-driven trigger for Label Sync rules.
 *
 * Used by:
 *   - Auto-tagger chained trigger (B): after a tag is applied to an *arr item,
 *     fire any Label Sync rules that source from that (instance, tag).
 *   - Library-sync delta detection (C): when the cached tag list for an item
 *     differs from the *arr-side fresh list, fire rules for added/removed tags.
 *   - Per-item "Sync labels now" button (D): explicit user trigger via
 *     POST /api/label-sync/run-for-item.
 *
 * The helper:
 *   1. Looks up enabled rules matching the source instance + (optional) tag name
 *   2. Resolves the item's tmdbId (from cache, then from the *arr instance as
 *      fallback) so the executor can scope to that specific item
 *   3. Runs the executor in targeted mode for each matching rule
 *   4. Returns a summary; the caller decides whether to log/persist failures
 *
 * Failures are isolated per rule — one rule failing doesn't block the others.
 */

import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import type { LibraryItemType, PrismaClient, ServiceType } from "../prisma.js";
import { executeLabelSyncRule, type LabelSyncRunResult } from "./execute-rule.js";

export interface TriggerLabelSyncForItemArgs {
	userId: string;
	/** *arr ServiceInstance row this item lives in (uppercase service enum). */
	sourceInstanceId: string;
	sourceService: ServiceType;
	arrItemId: number;
	itemType: LibraryItemType;
	/**
	 * If set, only rules sourcing this exact tag name are fired. Used by B
	 * (auto-tagger applied a specific tag) and C (specific tag-id delta).
	 * Omit for D (per-item button) which fires every matching rule.
	 */
	tagName?: string;
	/**
	 * tmdbId for the item. If omitted the helper resolves it from
	 * LibraryCache.data; pass it explicitly when the caller already has it
	 * to skip the lookup.
	 */
	tmdbId?: number;
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

export interface TriggerLabelSyncForItemResult {
	/** Number of LabelSyncRule rows that matched and were attempted. */
	rulesFired: number;
	/** Per-rule outcomes — caller can log or surface in UI. */
	results: Array<{
		ruleId: string;
		ruleName: string;
		outcome: LabelSyncRunResult;
	}>;
	/** Aggregate counts across all fired rules. */
	totals: {
		labelsApplied: number;
		failures: number;
	};
}

const ZERO_RESULT: TriggerLabelSyncForItemResult = {
	rulesFired: 0,
	results: [],
	totals: { labelsApplied: 0, failures: 0 },
};

/**
 * Resolve the tmdbId for an item by reading the LibraryCache row's `data`
 * blob. Returns null if the item isn't cached or the blob doesn't carry a
 * usable tmdbId — in which case the trigger is a no-op (we can't write to
 * a destination without knowing what to match on).
 */
async function resolveTmdbId(
	prisma: PrismaClient,
	instanceId: string,
	arrItemId: number,
	itemType: LibraryItemType,
	log: FastifyBaseLogger,
): Promise<number | null> {
	const cache = await prisma.libraryCache.findFirst({
		where: { instanceId, arrItemId, itemType },
		select: { data: true },
	});
	if (!cache?.data) return null;
	try {
		const parsed = JSON.parse(cache.data) as { tmdbId?: unknown };
		const tmdbId = typeof parsed.tmdbId === "number" ? parsed.tmdbId : null;
		return tmdbId && tmdbId > 0 ? tmdbId : null;
	} catch (err) {
		log.warn({ err, arrItemId }, "Failed to parse LibraryCache.data while resolving tmdbId");
		return null;
	}
}

export async function triggerLabelSyncForItem(
	args: TriggerLabelSyncForItemArgs,
): Promise<TriggerLabelSyncForItemResult> {
	const childLog = args.log.child({
		trigger: "label-sync-for-item",
		sourceInstanceId: args.sourceInstanceId,
		arrItemId: args.arrItemId,
		tagName: args.tagName ?? "(any)",
	});

	// 1. Find matching rules. The schema stores `sourceService` lowercase,
	//    `ServiceInstance.service` uppercase — translate at the boundary.
	const rules = await args.prisma.labelSyncRule.findMany({
		where: {
			userId: args.userId,
			enabled: true,
			sourceService: args.sourceService.toLowerCase(),
			OR: [{ sourceInstanceId: args.sourceInstanceId }, { sourceInstanceId: null }],
			...(args.tagName ? { sourceTagName: args.tagName } : {}),
		},
	});

	if (rules.length === 0) {
		return ZERO_RESULT;
	}

	// 2. Resolve tmdbId — use the explicit value when supplied (cheap), else
	//    look up from cache. If unresolvable we can't proceed safely.
	const tmdbId =
		args.tmdbId ??
		(await resolveTmdbId(
			args.prisma,
			args.sourceInstanceId,
			args.arrItemId,
			args.itemType,
			childLog,
		));

	if (tmdbId === null) {
		childLog.debug(
			"Skipping Label Sync trigger: tmdbId unresolvable (item not in cache or missing tmdbId)",
		);
		return { rulesFired: 0, results: [], totals: { labelsApplied: 0, failures: 0 } };
	}

	// 3. Fire each matching rule with targetTmdbId set. Failures isolated.
	const results: TriggerLabelSyncForItemResult["results"] = [];
	let labelsApplied = 0;
	let failures = 0;

	for (const rule of rules) {
		try {
			const outcome = await executeLabelSyncRule({
				rule: {
					id: rule.id,
					userId: rule.userId,
					sourceService: rule.sourceService,
					sourceInstanceId: rule.sourceInstanceId,
					sourceTagName: rule.sourceTagName,
					destService: rule.destService,
					destInstanceId: rule.destInstanceId,
					destTagName: rule.destTagName,
				},
				prisma: args.prisma,
				arrClientFactory: args.arrClientFactory,
				encryptor: args.encryptor,
				log: childLog,
				targetTmdbId: tmdbId,
			});
			labelsApplied += outcome.totals.labelsApplied;
			failures += outcome.totals.failures;
			results.push({ ruleId: rule.id, ruleName: rule.name, outcome });
		} catch (err) {
			childLog.warn(
				{ err, ruleId: rule.id, ruleName: rule.name },
				"Label Sync rule trigger threw — counted as failure",
			);
			failures++;
			results.push({
				ruleId: rule.id,
				ruleName: rule.name,
				outcome: {
					status: "failed",
					message: err instanceof Error ? err.message : String(err),
					totals: {
						sourceInstancesScanned: 0,
						taggedItemsFound: 0,
						destMatchesFound: 0,
						labelsApplied: 0,
						failures: 1,
					},
				},
			});
		}
	}

	return {
		rulesFired: rules.length,
		results,
		totals: { labelsApplied, failures },
	};
}
