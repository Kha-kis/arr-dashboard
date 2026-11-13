import type { LabelSyncRecovery } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";

const knownStates = new Set([
	"claimed",
	"sending",
	"unknown",
	"verified",
	"noop",
	"failed",
	"blocked",
	"restored-held",
	"reconciled",
]);

/** Read-only generic projection. Never return private attempts or infer absence after failure. */
export async function projectLabelSyncRecovery(
	prisma: PrismaClient,
	userId: string,
	ruleIds: readonly string[],
	log?: Pick<FastifyBaseLogger, "warn">,
): Promise<Map<string, LabelSyncRecovery>> {
	const ids = [...new Set(ruleIds)];
	if (ids.length === 0) return new Map();
	try {
		const groups = await prisma.labelSyncMutationAttempt.groupBy({
			by: ["ruleId", "status"],
			where: { userId, ruleId: { in: ids }, rule: { userId } },
			_count: { _all: true },
			_max: { lastObservedAt: true },
		});
		const result = new Map<string, LabelSyncRecovery>(
			ids.map((id) => [
				id,
				{
					availability: "known",
					state: "clear",
					heldCount: 0,
					reconciledCount: 0,
					lastCheckAt: null,
				},
			]),
		);
		for (const group of groups) {
			const current = result.get(group.ruleId);
			if (
				!current ||
				current.availability !== "known" ||
				!knownStates.has(group.status) ||
				!Number.isSafeInteger(group._count._all) ||
				group._count._all <= 0
			)
				throw new Error("Recovery aggregate invalid");
			if (group.status !== "restored-held" && group.status !== "reconciled") continue;
			if (group.status === "restored-held") current.heldCount += group._count._all;
			else current.reconciledCount += group._count._all;
			if (
				!Number.isSafeInteger(current.heldCount) ||
				!Number.isSafeInteger(current.reconciledCount)
			)
				throw new Error("Recovery aggregate invalid");
			const observed = group._max.lastObservedAt;
			if (observed !== null) {
				if (!(observed instanceof Date) || !Number.isFinite(observed.getTime()))
					throw new Error("Recovery aggregate invalid");
				const time = observed.toISOString();
				if (current.lastCheckAt === null || time > current.lastCheckAt) current.lastCheckAt = time;
			}
			current.state = current.heldCount > 0 ? "restored-held" : "reconciled";
		}
		return result;
	} catch {
		// Do not attach exception bodies: database errors can contain private values.
		log?.warn({ category: "label_recovery_unavailable" }, "Label recovery projection unavailable");
		return new Map(ids.map((id) => [id, { availability: "unavailable" }]));
	}
}
