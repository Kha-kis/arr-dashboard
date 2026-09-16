import type { LabelSyncRunResult } from "./execute-rule.js";
import type { PrismaClient } from "../prisma.js";

export const LABEL_SYNC_RULE_CHANGED_CODE = "label_sync_rule_changed";
export const LABEL_SYNC_RULE_CHANGED_MESSAGE =
	"Label Sync execution finished, but the rule changed or was deleted before its result could be saved.";

type LabelSyncRuleSnapshot = {
	id: string;
	userId: string;
	name: string;
	enabled: boolean;
	sourceService: string;
	sourceInstanceId: string | null;
	sourceTagName: string;
	destService: string;
	destInstanceId: string;
	destTagName: string;
	updatedAt: Date;
};

/**
 * Persist a run result only when the rule still belongs to the owner and has
 * the same version that was executed. No provider work belongs in this
 * transaction; it only performs the guarded database write and owned read.
 */
export async function persistLabelSyncRunResult(
	prisma: PrismaClient,
	rule: LabelSyncRuleSnapshot,
	result: LabelSyncRunResult,
) {
	const lastRunAt = new Date();
	return await prisma.$transaction(async (tx) => {
		const persisted = await tx.labelSyncRule.updateMany({
			where: {
				id: rule.id,
				userId: rule.userId,
				name: rule.name,
				enabled: rule.enabled,
				sourceService: rule.sourceService,
				sourceInstanceId: rule.sourceInstanceId,
				sourceTagName: rule.sourceTagName,
				destService: rule.destService,
				destInstanceId: rule.destInstanceId,
				destTagName: rule.destTagName,
				updatedAt: rule.updatedAt,
			},
			data: {
				lastRunAt,
				lastRunStatus: result.status,
				lastRunMessage: result.message,
			},
		});
		if (persisted.count !== 1) return null;

		return await tx.labelSyncRule.findFirst({ where: { id: rule.id, userId: rule.userId } });
	});
}
