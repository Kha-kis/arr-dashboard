/**
 * Label Sync — rule execution engine (issue #384).
 *
 * Pure orchestration over the strategy registry. The executor doesn't know
 * about specific services — it asks the registry for a `SourceReader` keyed
 * on `rule.sourceService` and a `DestWriter` keyed on `rule.destService`,
 * then runs:
 *
 *   1. Resolve source instance(s) the rule targets.
 *   2. For each source instance, call the reader → MatchCandidate[].
 *   3. Resolve the destination instance.
 *   4. Pass the merged candidate set to the writer → counts.
 *   5. Return a structured run result; the caller persists it.
 *
 * Same-service rules (e.g., Plex → Plex, Sonarr → Sonarr) drop out of the
 * design naturally: the executor never compares source vs. dest service.
 */

import type { LabelSyncService } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient } from "../prisma.js";
import { DEST_WRITERS, SOURCE_READERS } from "./strategy-registry.js";
import type { MatchCandidate } from "./strategy-types.js";

export interface LabelSyncRuleInput {
	id: string;
	userId: string;
	sourceService: string;
	sourceInstanceId: string | null;
	sourceTagName: string;
	destService: string;
	destInstanceId: string;
	destTagName: string;
}

export interface LabelSyncRunResult {
	status: "success" | "partial" | "failed";
	message: string;
	totals: {
		sourceInstancesScanned: number;
		taggedItemsFound: number;
		destMatchesFound: number;
		labelsApplied: number;
		failures: number;
	};
}

interface ExecuteOpts {
	rule: LabelSyncRuleInput;
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

const ZERO_TOTALS: LabelSyncRunResult["totals"] = {
	sourceInstancesScanned: 0,
	taggedItemsFound: 0,
	destMatchesFound: 0,
	labelsApplied: 0,
	failures: 0,
};

/**
 * Execute a label-sync rule. Pure-execution function — does NOT persist
 * the result. Callers should write `lastRunAt` / `lastRunStatus` /
 * `lastRunMessage` themselves so the rule's persistence model stays
 * decoupled from the engine.
 */
export async function executeLabelSyncRule(opts: ExecuteOpts): Promise<LabelSyncRunResult> {
	const { rule, prisma, arrClientFactory, encryptor, log } = opts;
	const childLog = log.child({
		ruleId: rule.id,
		sourceService: rule.sourceService,
		destService: rule.destService,
	});

	const sourceReader = SOURCE_READERS[rule.sourceService as LabelSyncService];
	if (!sourceReader) {
		return failure(`Unsupported sourceService: ${rule.sourceService}`);
	}

	const destWriter = DEST_WRITERS[rule.destService as LabelSyncService];
	if (!destWriter) {
		return failure(`Unsupported destService: ${rule.destService}`);
	}

	// Resolve source instances (single id or all enabled instances of the service)
	const sourceInstanceWhere = rule.sourceInstanceId
		? {
				id: rule.sourceInstanceId,
				userId: rule.userId,
				service: sourceReader.prismaService,
				enabled: true,
			}
		: { userId: rule.userId, service: sourceReader.prismaService, enabled: true };

	const sourceInstances = await prisma.serviceInstance.findMany({ where: sourceInstanceWhere });
	if (sourceInstances.length === 0) {
		return failure(
			`No enabled ${rule.sourceService} instance${rule.sourceInstanceId ? "" : "s"} found.`,
		);
	}

	// Resolve destination instance (always exactly one)
	const destInstance = await prisma.serviceInstance.findFirst({
		where: {
			id: rule.destInstanceId,
			userId: rule.userId,
			service: destWriter.prismaService,
			enabled: true,
		},
	});
	if (!destInstance) {
		return failure(`Destination ${rule.destService} instance not found or disabled.`);
	}

	// Pass 1: source-side reads
	const allCandidates: MatchCandidate[] = [];
	let sourceFailures = 0;
	for (const sourceInstance of sourceInstances) {
		const result = await sourceReader.readTaggedItems({
			rule,
			sourceInstance,
			prisma,
			arrClientFactory,
			encryptor,
			log: childLog.child({ sourceInstanceId: sourceInstance.id }),
		});
		allCandidates.push(...result.matches);
		if (result.failed) sourceFailures++;
	}

	if (allCandidates.length === 0) {
		const totals: LabelSyncRunResult["totals"] = {
			sourceInstancesScanned: sourceInstances.length,
			taggedItemsFound: 0,
			destMatchesFound: 0,
			labelsApplied: 0,
			failures: sourceFailures,
		};
		if (sourceFailures > 0) {
			return {
				status: "failed",
				message: `Source reads failed on ${sourceFailures} instance${sourceFailures === 1 ? "" : "s"} — no candidates collected.`,
				totals,
			};
		}
		return {
			status: "success",
			message: `No items in ${rule.sourceService} carry tag "${rule.sourceTagName}".`,
			totals,
		};
	}

	// Pass 2: destination-side writes
	const writeResult = await destWriter.applyLabels({
		rule,
		destInstance,
		candidates: allCandidates,
		prisma,
		arrClientFactory,
		encryptor,
		log: childLog.child({ destInstanceId: destInstance.id }),
	});

	const totalFailures = sourceFailures + writeResult.failures;

	const totals: LabelSyncRunResult["totals"] = {
		sourceInstancesScanned: sourceInstances.length,
		taggedItemsFound: allCandidates.length,
		destMatchesFound: writeResult.matchesFound,
		labelsApplied: writeResult.labelsApplied,
		failures: totalFailures,
	};

	if (totalFailures > 0 && writeResult.labelsApplied === 0) {
		return {
			status: "failed",
			message: `All ${totalFailures} attempts failed.`,
			totals,
		};
	}

	if (totalFailures > 0) {
		return {
			status: "partial",
			message: `Applied ${writeResult.labelsApplied} label${writeResult.labelsApplied === 1 ? "" : "s"}, ${totalFailures} failure${totalFailures === 1 ? "" : "s"}.`,
			totals,
		};
	}

	return {
		status: "success",
		message: `Applied label "${rule.destTagName}" to ${writeResult.labelsApplied} item${writeResult.labelsApplied === 1 ? "" : "s"} (${writeResult.matchesFound} match${writeResult.matchesFound === 1 ? "" : "es"} from ${allCandidates.length} tagged item${allCandidates.length === 1 ? "" : "s"}).`,
		totals,
	};
}

function failure(message: string): LabelSyncRunResult {
	return {
		status: "failed",
		message,
		totals: { ...ZERO_TOTALS },
	};
}
