import type {
	CrossDomainAction,
	CrossDomainRule,
	CrossDomainRuleDraft,
	CrossDomainRuleScope,
	RuleDocument,
} from "@arr/shared";
import {
	isKindLegalForContext,
	ruleParamSchemaMap,
	serializeCriteriaDocumentToV0,
	validateV1Depth,
	walkPredicates,
} from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { buildEvalContext } from "../library-cleanup/cleanup-executor.js";
import { evaluateSingleCondition } from "../library-cleanup/rule-evaluators.js";
import type { CacheItemForEval, CleanupExecutorDeps } from "../library-cleanup/types.js";
import type { PrismaClient } from "../prisma.js";
import { evaluateDocument } from "../rules/engine.js";

const SCAN_BATCH_SIZE = 500;
export const DRY_RUN_MATCH_LIMIT = 100;

interface StoredCrossDomainRule {
	id: string;
	name: string;
	document: string;
	scope: string;
	actions: string;
	deployedName: string | null;
	deployedDocument: string | null;
	deployedScope: string | null;
	deployedActions: string | null;
	deploymentVersion: number;
	deployedAt: Date | null;
	lastRunAt: Date | null;
	lastRunStatus: string | null;
	lastRunMessage: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface CrossDomainMatch {
	cacheId: string;
	instanceId: string;
	instanceName: string;
	arrItemId: number;
	itemType: "movie" | "series";
	title: string;
	year: number | null;
	reason: string;
}

export function validateCrossDomainDocument(document: RuleDocument): string | null {
	const depthError = validateV1Depth(document);
	if (depthError) return depthError;
	try {
		serializeCriteriaDocumentToV0(document);
	} catch (error) {
		return error instanceof Error ? error.message : "Invalid rule document";
	}
	for (const predicate of walkPredicates(document.root)) {
		if (!isKindLegalForContext("cross-domain", predicate.kind)) {
			return `Unknown cross-domain condition kind: "${predicate.kind}"`;
		}
		const schema = ruleParamSchemaMap[predicate.kind];
		const result = schema?.safeParse(predicate.params);
		if (!result?.success) {
			const message = result?.error.issues.map((issue) => issue.message).join(", ");
			return `Invalid parameters for "${predicate.kind}": ${message || "unknown condition"}`;
		}
	}
	return null;
}

export function toCrossDomainRuleDto(row: StoredCrossDomainRule): CrossDomainRule {
	return {
		id: row.id,
		name: row.name,
		document: JSON.parse(row.document) as RuleDocument,
		scope: JSON.parse(row.scope) as CrossDomainRuleScope,
		actions: JSON.parse(row.actions) as CrossDomainAction[],
		active: row.deployedAt !== null,
		deploymentVersion: row.deploymentVersion,
		deployedAt: row.deployedAt?.toISOString() ?? null,
		hasDraftChanges:
			row.deployedAt !== null &&
			(row.name !== row.deployedName ||
				row.document !== row.deployedDocument ||
				row.scope !== row.deployedScope ||
				row.actions !== row.deployedActions),
		lastRunAt: row.lastRunAt?.toISOString() ?? null,
		lastRunStatus: row.lastRunStatus as CrossDomainRule["lastRunStatus"],
		lastRunMessage: row.lastRunMessage,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export function serializeCrossDomainDraft(draft: CrossDomainRuleDraft) {
	return {
		name: draft.name,
		document: JSON.stringify(draft.document),
		scope: JSON.stringify(draft.scope),
		actions: JSON.stringify(draft.actions),
	};
}

export async function scanCrossDomainRule(
	deps: { prisma: PrismaClient; arrClientFactory: ArrClientFactory; log: FastifyBaseLogger },
	userId: string,
	document: RuleDocument,
	scope: CrossDomainRuleScope,
): Promise<{ itemsEvaluated: number; matches: CrossDomainMatch[] }> {
	const v0 = serializeCriteriaDocumentToV0(document);
	const evalRule = {
		enabled: true,
		ruleType: v0.ruleType,
		parameters: JSON.stringify(v0.parameters),
		conditions: v0.conditions ? JSON.stringify(v0.conditions) : null,
	};
	const cleanupDeps: CleanupExecutorDeps = deps;
	const context = await buildEvalContext(cleanupDeps, userId, [evalRule]);

	const instances = await deps.prisma.serviceInstance.findMany({
		where: {
			userId,
			enabled: true,
			service: {
				in: scope.serviceTypes.length > 0 ? scope.serviceTypes : ["SONARR", "RADARR"],
			},
			...(scope.instanceIds.length > 0 ? { id: { in: scope.instanceIds } } : {}),
		},
		select: { id: true, label: true, service: true },
	});
	const instanceMap = new Map(instances.map((instance) => [instance.id, instance]));
	if (instances.length === 0) return { itemsEvaluated: 0, matches: [] };

	const matches: CrossDomainMatch[] = [];
	let itemsEvaluated = 0;
	let cursor: string | undefined;
	while (true) {
		const batch: CacheItemForEval[] = await deps.prisma.libraryCache.findMany({
			where: { instanceId: { in: instances.map((instance) => instance.id) } },
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
			take: SCAN_BATCH_SIZE,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
			orderBy: { id: "asc" },
		});
		if (batch.length === 0) break;
		for (const item of batch) {
			itemsEvaluated++;
			const instance = instanceMap.get(item.instanceId);
			if (!instance) continue;
			const result = evaluateDocument(document, (predicate) =>
				evaluateSingleCondition(item, predicate.kind, predicate.params, context, null),
			);
			if (result.matched && (item.itemType === "movie" || item.itemType === "series")) {
				matches.push({
					cacheId: item.id,
					instanceId: item.instanceId,
					instanceName: instance.label,
					arrItemId: item.arrItemId,
					itemType: item.itemType,
					title: item.title,
					year: item.year,
					reason: result.reason,
				});
			}
		}
		cursor = batch.at(-1)!.id;
		if (batch.length < SCAN_BATCH_SIZE) break;
	}
	return { itemsEvaluated, matches };
}
