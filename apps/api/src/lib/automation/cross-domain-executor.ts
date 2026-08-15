import type { CrossDomainAction, CrossDomainRuleScope, RuleDocument } from "@arr/shared";
import { serializeCriteriaDocumentToV0 } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { executeAutoTagRule } from "../auto-tag/execute-rule.js";
import type { NotificationService } from "../notifications/notification-service.js";
import type { LibraryItemType, PrismaClient } from "../prisma.js";
import { scanCrossDomainRule, type CrossDomainMatch } from "./cross-domain-rules.js";

interface ActiveRule {
	id: string;
	userId: string;
	deployedName: string;
	deployedDocument: string;
	deployedScope: string;
	deployedActions: string;
	deploymentVersion: number;
}

interface ExecutorDeps {
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	notificationService: NotificationService;
	log: FastifyBaseLogger;
}

export interface CrossDomainExecutionResult {
	status: "success" | "partial" | "failed";
	message: string;
}

export async function executeCrossDomainRule(
	deps: ExecutorDeps,
	rule: ActiveRule,
): Promise<CrossDomainExecutionResult> {
	const document = JSON.parse(rule.deployedDocument) as RuleDocument;
	const scope = JSON.parse(rule.deployedScope) as CrossDomainRuleScope;
	const actions = JSON.parse(rule.deployedActions) as CrossDomainAction[];
	const scan = await scanCrossDomainRule(deps, rule.userId, document, scope);
	const ledgerRows = await deps.prisma.crossDomainRuleMatch.findMany({
		where: { ruleId: rule.id, deploymentVersion: rule.deploymentVersion },
	});
	const ledger = new Map(
		ledgerRows.map((row) => [
			matchKey(row.instanceId, row.arrItemId, row.itemType),
			new Set(parseCompletedActions(row.completedActions)),
		]),
	);

	let completed = 0;
	let failures = 0;
	for (const action of actions) {
		if (action.type === "exempt_cleanup") continue;
		const pending = scan.matches.filter(
			(match) =>
				!ledger.get(matchKey(match.instanceId, match.arrItemId, match.itemType))?.has(action.type),
		);
		if (pending.length === 0) continue;

		if (action.type === "send_notification") {
			for (const match of pending) {
				try {
					await deps.notificationService.notify(
						{
							eventType: "AUTOMATION_RULE_MATCHED",
							title: `${rule.deployedName}: ${match.title}`,
							body: match.reason,
							url: "/console?tab=automation",
							metadata: {
								ruleId: rule.id,
								ruleName: rule.deployedName,
								instanceId: match.instanceId,
								instance: match.instanceName,
								itemType: match.itemType,
								arrItemId: match.arrItemId,
								year: match.year,
								reason: match.reason,
							},
						},
						{ userId: rule.userId },
					);
					await recordCompletedAction(deps.prisma, rule, match, action.type, ledger);
					completed++;
				} catch (error) {
					failures++;
					await recordActionFailure(deps.prisma, rule, match, error);
				}
			}
			continue;
		}

		const v0 = serializeCriteriaDocumentToV0(document);
		const result = await executeAutoTagRule({
			rule: {
				id: rule.id,
				userId: rule.userId,
				name: rule.deployedName,
				ruleType: v0.ruleType,
				parameters: v0.parameters,
				operator: v0.operator,
				conditions: v0.conditions,
				serviceFilter: scope.serviceTypes.map((service) => service.toLowerCase()),
				instanceFilter: scope.instanceIds,
				excludeTags: null,
				excludeTitles: null,
				plexLibraryFilter: null,
				tagName: action.tagName,
			},
			prisma: deps.prisma,
			arrClientFactory: deps.arrClientFactory,
			encryptor: deps.encryptor,
			log: deps.log,
			targetCacheItemIds: pending.map((match) => match.cacheId),
		});
		const outcomes = new Map(result.itemOutcomes.map((outcome) => [outcome.cacheId, outcome]));
		const runFailure = result.status === "failed" ? result.message : null;
		for (const match of pending) {
			const outcome = outcomes.get(match.cacheId);
			if (outcome?.success) {
				await recordCompletedAction(deps.prisma, rule, match, action.type, ledger);
				completed++;
			} else {
				failures++;
				await recordActionFailure(
					deps.prisma,
					rule,
					match,
					outcome?.error ?? runFailure ?? "Matched item disappeared before tag action",
				);
			}
		}
	}

	const status = failures === 0 ? "success" : completed > 0 ? "partial" : "failed";
	return {
		status,
		message: `${scan.matches.length} matched, ${completed} action${completed === 1 ? "" : "s"} completed, ${failures} failed.`,
	};
}

function matchKey(instanceId: string, arrItemId: number, itemType: LibraryItemType): string {
	return `${instanceId}:${arrItemId}:${itemType}`;
}

function parseCompletedActions(value: string): string[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

async function recordCompletedAction(
	prisma: PrismaClient,
	rule: ActiveRule,
	match: CrossDomainMatch,
	actionType: string,
	ledger: Map<string, Set<string>>,
): Promise<void> {
	const key = matchKey(match.instanceId, match.arrItemId, match.itemType);
	const completedActions = ledger.get(key) ?? new Set<string>();
	completedActions.add(actionType);
	ledger.set(key, completedActions);
	await prisma.crossDomainRuleMatch.upsert({
		where: {
			ruleId_deploymentVersion_instanceId_arrItemId_itemType: {
				ruleId: rule.id,
				deploymentVersion: rule.deploymentVersion,
				instanceId: match.instanceId,
				arrItemId: match.arrItemId,
				itemType: match.itemType,
			},
		},
		create: {
			ruleId: rule.id,
			deploymentVersion: rule.deploymentVersion,
			instanceId: match.instanceId,
			arrItemId: match.arrItemId,
			itemType: match.itemType,
			completedActions: JSON.stringify([...completedActions]),
		},
		update: {
			completedActions: JSON.stringify([...completedActions]),
			lastError: null,
			processedAt: new Date(),
		},
	});
}

async function recordActionFailure(
	prisma: PrismaClient,
	rule: ActiveRule,
	match: CrossDomainMatch,
	error: unknown,
): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	await prisma.crossDomainRuleMatch.upsert({
		where: {
			ruleId_deploymentVersion_instanceId_arrItemId_itemType: {
				ruleId: rule.id,
				deploymentVersion: rule.deploymentVersion,
				instanceId: match.instanceId,
				arrItemId: match.arrItemId,
				itemType: match.itemType,
			},
		},
		create: {
			ruleId: rule.id,
			deploymentVersion: rule.deploymentVersion,
			instanceId: match.instanceId,
			arrItemId: match.arrItemId,
			itemType: match.itemType,
			lastError: message,
		},
		update: { lastError: message, processedAt: new Date() },
	});
}
