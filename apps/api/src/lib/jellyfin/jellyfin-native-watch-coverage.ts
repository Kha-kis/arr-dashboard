import type { ProviderNativeWatchCoverage } from "@arr/shared";
import type { PrismaClient } from "../prisma.js";
import { parseNativeWatchScopeDiagnostics } from "./jellyfin-native-watch-diagnostics.js";

type AvailableCoverage = Extract<ProviderNativeWatchCoverage, { status: "available" }>;
type Reason = AvailableCoverage["reasonCodes"][number];
const unavailable = (
	reason: Extract<ProviderNativeWatchCoverage, { status: "unavailable" }>["reason"],
): ProviderNativeWatchCoverage => ({ status: "unavailable", reason });

/** Recorded publication explanation only. Never used by watch values or mutations. */
export async function readOwnedNativeWatchCoverage(
	prisma: PrismaClient,
	input: { userId: string; instanceId: string },
): Promise<ProviderNativeWatchCoverage> {
	return prisma.$transaction(
		async (tx) => {
			const instance = await tx.serviceInstance.findFirst({
				where: {
					id: input.instanceId,
					userId: input.userId,
					enabled: true,
					service: { in: ["JELLYFIN", "EMBY"] },
				},
				select: {
					connectionGeneration: true,
					identityGeneration: true,
					identityStatus: true,
					expectedIdentity: true,
				},
			});
			if (!instance) return unavailable("not-owned");
			if (instance.identityStatus !== "VERIFIED" || !instance.expectedIdentity?.trim())
				return unavailable("identity-changed");
			const [pointer, status] = await Promise.all([
				tx.jellyfinNativeWatchPublication.findUnique({
					where: {
						instanceId: input.instanceId,
						instance: { userId: input.userId, enabled: true },
					},
				}),
				tx.cacheRefreshStatus.findUnique({
					where: {
						instanceId_cacheType: { instanceId: input.instanceId, cacheType: "jellyfin_episode" },
						instance: { userId: input.userId, enabled: true },
					},
				}),
			]);
			if (!pointer) return unavailable("no-publication");
			if (
				pointer.connectionGeneration !== instance.connectionGeneration ||
				pointer.identityGeneration !== instance.identityGeneration ||
				status?.connectionGeneration !== instance.connectionGeneration ||
				status.identityGeneration !== instance.identityGeneration
			)
				return unavailable("identity-changed");
			if (status.generationId !== pointer.activeCacheGenerationId)
				return unavailable("snapshot-changed");
			const expected = pointer.activeExpectedScopeCount;
			if (
				status.lastResult !== "success" ||
				!Number.isSafeInteger(expected) ||
				expected < 1 ||
				expected > 256 ||
				!Number.isFinite(pointer.activeObservedAt.getTime())
			)
				return unavailable("malformed-publication");
			const [receipts, runs] = await Promise.all([
				tx.jellyfinNativeWatchScopeReceipt.findMany({
					where: {
						instanceId: input.instanceId,
						runId: pointer.activeRunId,
						instance: { userId: input.userId, enabled: true },
					},
					take: expected + 1,
				}),
				tx.providerObservationRun.findMany({
					where: {
						instanceId: input.instanceId,
						cacheType: "jellyfin_episode",
						instance: { userId: input.userId, enabled: true },
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
						activeSlotKey: { not: null },
					},
					select: {
						state: true,
						totalUnits: true,
						completedUnits: true,
						units: { select: { phase: true, state: true }, take: 513 },
					},
					take: 2,
				}),
			]);
			if (
				receipts.length !== expected ||
				new Set(receipts.map((r) => JSON.stringify([r.userKeyDigest, r.libraryId]))).size !==
					expected ||
				receipts.some(
					(r) =>
						r.connectionGeneration !== instance.connectionGeneration ||
						r.identityGeneration !== instance.identityGeneration ||
						r.observedAt.getTime() !== pointer.activeObservedAt.getTime() ||
						!/^[a-f0-9]{64}$/.test(r.contentFingerprint) ||
						!Number.isSafeInteger(r.expectedRawCount) ||
						r.expectedRawCount < 0 ||
						!Number.isSafeInteger(r.observedRawCount) ||
						r.observedRawCount < 0,
				)
			)
				return unavailable("malformed-publication");
			const reasons = new Set<Reason>();
			let diagnosticStatus: AvailableCoverage["diagnosticStatus"] = "recorded";
			for (const receipt of receipts) {
				const d = parseNativeWatchScopeDiagnostics(receipt.diagnosticsJson);
				if (!d) {
					diagnosticStatus = "unavailable";
					reasons.add("diagnostics-unavailable");
					continue;
				}
				if (d.collectUnits !== 1 || d.verifyUnits !== 1) reasons.add("unit-evidence-incomplete");
				if (!d.expectedCountsMatch) reasons.add("provider-count-changed");
				if (
					d.collectStageRows !== receipt.expectedRawCount ||
					d.verifyStageRows !== receipt.observedRawCount
				)
					reasons.add("staging-coverage-incomplete");
				if (d.excludedRows > 0) reasons.add("excluded-observations");
				if (d.invalidCollectRows > 0 || d.invalidVerifyRows > 0)
					reasons.add("invalid-observations");
				if (d.conflictedCoordinates > 0) reasons.add("ambiguous-identity");
				if (d.duplicateCollectCoordinates > 0 || d.duplicateVerifyCoordinates > 0)
					reasons.add("duplicate-observations");
				if (d.missingVerifyCoordinates > 0) reasons.add("missing-verification");
				if (d.changedObservationCoordinates > 0) reasons.add("changed-observations");
				if (d.verifyOnlyCoordinates > 0) reasons.add("verification-only-observations");
			}
			const verifiedScopes = receipts.filter((r) => r.exact).length;
			if (verifiedScopes < expected) reasons.add("coverage-incomplete");
			// A canonical active slot is authoritative for suppressing duplicate recovery.
			let refreshPhase: AvailableCoverage["refreshPhase"] = "idle";
			if (runs.length > 1) refreshPhase = "unknown";
			else if (runs[0]) {
				const run = runs[0];
				refreshPhase =
					run.units.length > 512 ||
					!Number.isSafeInteger(run.totalUnits) ||
					run.totalUnits < 0 ||
					!Number.isSafeInteger(run.completedUnits) ||
					run.completedUnits < 0 ||
					run.completedUnits > run.totalUnits
						? "unknown"
						: run.state === "failed"
							? "failed"
							: run.state !== "running"
								? "unknown"
								: run.completedUnits === run.totalUnits
									? "finalizing"
									: run.units.some((u) => u.phase === "collect" && u.state !== "complete")
										? "collecting"
										: "verifying";
			} else if (
				status.lastAttemptResult === "in_progress" ||
				status.lastAttemptResult?.startsWith("in_progress:")
			)
				refreshPhase = "unknown";
			else if (status.lastAttemptResult === "error" || status.lastAttemptResult === "failed")
				refreshPhase = "failed";
			const latest = await tx.jellyfinNativeWatchPublication.findUnique({
				where: { instanceId: input.instanceId, instance: { userId: input.userId, enabled: true } },
			});
			if (
				!latest ||
				latest.activeRunId !== pointer.activeRunId ||
				latest.activeCacheGenerationId !== pointer.activeCacheGenerationId ||
				latest.activeExpectedScopeCount !== pointer.activeExpectedScopeCount ||
				latest.connectionGeneration !== pointer.connectionGeneration ||
				latest.identityGeneration !== pointer.identityGeneration ||
				latest.activeObservedAt.getTime() !== pointer.activeObservedAt.getTime()
			)
				return unavailable("snapshot-changed");
			return {
				status: "available",
				observedAt: pointer.activeObservedAt.toISOString(),
				expectedScopes: expected,
				verifiedScopes,
				incompleteScopes: expected - verifiedScopes,
				diagnosticStatus,
				reasonCodes: [...reasons].sort(),
				refreshPhase,
			};
		},
		{ isolationLevel: "Serializable", timeout: 10_000 },
	);
}
