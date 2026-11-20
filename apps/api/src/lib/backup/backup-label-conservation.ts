import { BackupCompatibilityError } from "../errors.js";
import type { Prisma, PrismaClient } from "../prisma.js";
import { validateLabelSyncMutationAttempts } from "./backup-validation.js";
import {
	originalPreparedRestoreRecords,
	preparedRestoreConnectionMatches,
	type PreparedRestoreData,
} from "./backup-restore-preparation.js";

type Row = Record<string, unknown>;
const RULE_AUTHORITY_FIELDS = [
	"userId",
	"enabled",
	"sourceService",
	"sourceInstanceId",
	"sourceTagName",
	"destService",
	"destInstanceId",
	"destTagName",
] as const;

function indexed(value: unknown): Map<string, Row> {
	if (!Array.isArray(value)) throw new BackupCompatibilityError();
	const result = new Map<string, Row>();
	for (const row of value) {
		if (!row || typeof row !== "object" || typeof row.id !== "string" || result.has(row.id))
			throw new BackupCompatibilityError();
		result.set(row.id, row);
	}
	return result;
}

/** Prepared-only proof against authenticated historical rows, never insertion data. */
export async function assertPreparedLabelConservation(
	client: PrismaClient | Prisma.TransactionClient,
	prepared: PreparedRestoreData,
): Promise<void> {
	try {
		const original = originalPreparedRestoreRecords(prepared);
		const users = await client.user.findMany();
		const rules = await client.labelSyncRule.findMany();
		const instances = await client.serviceInstance.findMany();
		const current = validateLabelSyncMutationAttempts(
			await client.labelSyncMutationAttempt.findMany(),
			users,
			rules,
			instances,
		);
		const incoming = validateLabelSyncMutationAttempts(
			original.labelSyncMutationAttempts,
			original.users,
			original.labelSyncRule,
			original.serviceInstances,
		);
		const attempts = new Map(incoming.map((row) => [row.id, row]));
		const translatedAttempts = new Map(
			validateLabelSyncMutationAttempts(
				prepared.records.labelSyncMutationAttempts,
				prepared.records.users,
				prepared.records.labelSyncRule,
				prepared.records.serviceInstances,
			).map((row) => [row.id, row]),
		);
		const currentRules = indexed(rules),
			originalRules = indexed(original.labelSyncRule);
		const currentInstances = indexed(instances),
			originalInstances = indexed(original.serviceInstances);
		const currentUsers = indexed(users),
			originalUsers = indexed(original.users);
		for (const row of current) {
			// Accept only exact original evidence or its already-documented inert
			// Restore projection. New claims, counters and outcomes still refuse.
			const before = attempts.get(row.id);
			if (
				!before ||
				(JSON.stringify(row) !== JSON.stringify(before) &&
					JSON.stringify(row) !== JSON.stringify(translatedAttempts.get(row.id))) ||
				!currentUsers.has(row.userId) ||
				!originalUsers.has(row.userId)
			)
				throw new BackupCompatibilityError();
			const rule = currentRules.get(row.ruleId),
				originalRule = originalRules.get(row.ruleId);
			const connection = currentInstances.get(row.destinationInstanceId),
				originalConnection = originalInstances.get(row.destinationInstanceId);
			if (
				!rule ||
				!originalRule ||
				!connection ||
				!originalConnection ||
				RULE_AUTHORITY_FIELDS.some((field) => rule[field] !== originalRule[field]) ||
				!preparedRestoreConnectionMatches(prepared, connection)
			)
				throw new BackupCompatibilityError();
			// A specific source instance is part of the rule's execution authority too.
			if (typeof rule.sourceInstanceId === "string") {
				const source = currentInstances.get(rule.sourceInstanceId),
					originalSource = originalInstances.get(rule.sourceInstanceId);
				if (
					!source ||
					!originalSource ||
					source.userId !== row.userId ||
					originalSource.userId !== row.userId ||
					!preparedRestoreConnectionMatches(prepared, source)
				)
					throw new BackupCompatibilityError();
			}
		}
	} catch {
		throw new BackupCompatibilityError();
	}
}
