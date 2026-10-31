import { lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getRestoreRuntimeClientContext } from "../../backup/restore-runtime-admission.js";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import { planPlexEpisodeRefresh } from "../../plex/plex-episode-refresh-plan.js";
import { claimProviderCacheRefreshAttempt } from "../../services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import {
	claimObservationUnit,
	createOrLoadObservationRun,
	releaseCancelledObservationUnitClaim,
} from "../observation-run-repository.js";

describe("joined episode cancellation claim fencing", () => {
	it.each([
		"owned",
		"wrong-token",
		"reclaimed-token",
		"authority-drift",
		"attempt-drift",
		"concurrent",
	] as const)("preserves progress and retry allowance for %s", async (scenario) => {
		const native = await createNotificationOutboxNativeFixture();
		const url = new URL(getRestoreRuntimeClientContext(native.runtime).databaseUrl);
		if (url.protocol !== "file:") throw Error("Owned fixture required");
		const file = fileURLToPath(url),
			directory = dirname(file);
		const checkTarget = () => {
			if (
				basename(file) !== "owned.db" ||
				dirname(directory) !== realpathSync(tmpdir()) ||
				!/^arr-outbox-worker-[A-Za-z0-9]+$/.test(basename(directory)) ||
				!lstatSync(directory).isDirectory() ||
				lstatSync(directory).isSymbolicLink() ||
				realpathSync(directory) !== directory
			)
				throw Error("Owned fixture required");
		};
		checkTarget();
		try {
			await native.run(async () => {
				const encrypted = native.encryptor.encrypt("synthetic-token");
				const instance = await native.prisma.serviceInstance.create({
					data: {
						userId: native.userId,
						service: "PLEX",
						label: "Synthetic",
						baseUrl: "http://synthetic.invalid",
						enabled: true,
						encryptedApiKey: encrypted.value,
						encryptionIv: encrypted.iv,
						expectedIdentity: "synthetic-id",
						identityStatus: "VERIFIED",
						connectionGeneration: 7,
						identityGeneration: 3,
					},
				});
				const authority = createProviderPublicationAuthority(instance),
					now = new Date();
				const outer = await claimProviderCacheRefreshAttempt(
					native.prisma,
					"plex_episode",
					authority,
				);
				if (outer.status !== "acquired") throw Error("Synthetic attempt required");
				const plan = planPlexEpisodeRefresh([
					{
						instanceId: instance.id,
						generationId: "parent",
						showTmdbId: 42,
						sectionId: "shows",
						sectionUuid: "shows-uuid",
						mediaType: "series",
						tvdbId: 99,
						ratingKey: "show-1",
					},
				]);
				const run = await createOrLoadObservationRun(native.prisma, {
					authority: {
						provider: "plex_episode",
						cacheType: "plex_episode",
						instanceId: instance.id,
						parentGenerationId: "parent",
						targetDigest: plan.targetDigest,
						connectionGeneration: 7,
						identityGeneration: 3,
					},
					units: plan.units.map((unit) => ({
						ordinal: unit.ordinal,
						scopeKey: unit.scopeKey,
						scopeDigest: unit.scopeDigest,
						phase: "collect" as const,
						expectedTargets: unit.targets.length,
						scopePayload: JSON.stringify({ ordinal: unit.ordinal }),
					})),
				});
				const claim = await claimObservationUnit(native.prisma, { runId: run.id, now });
				if (!claim) throw Error("Synthetic claim required");
				await native.prisma.providerObservationUnit.update({
					where: { id: claim.unitId },
					data: {
						cursor: 1,
						expectedRawCount: 2,
						observedRawCount: 1,
						completedPages: 1,
						attemptCount: 2,
					},
				});
				const stage = await native.prisma.plexEpisodeObservationStage.create({
					data: {
						runId: run.id,
						unitId: claim.unitId,
						showTmdbId: 42,
						parentRatingKey: "show-1",
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-1",
						title: "Synthetic",
						watched: true,
						watchedByUsers: "[]",
						watchCount: 2,
						refreshedAt: now,
						sourceFingerprint: "a".repeat(64),
					},
				});
				if (scenario === "reclaimed-token")
					await native.prisma.providerObservationUnit.update({
						where: { id: claim.unitId },
						data: { claimToken: "different-current-token" },
					});
				if (scenario === "authority-drift")
					await native.prisma.serviceInstance.update({
						where: { id: instance.id },
						data: { connectionGeneration: 8 },
					});
				if (scenario === "attempt-drift")
					await native.prisma.cacheRefreshStatus.update({
						where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex_episode" } },
						data: { lastAttemptResult: "different-current-marker" },
					});
				const input = {
					claim: scenario === "wrong-token" ? { ...claim, claimToken: "wrong-token" } : claim,
					authority,
					attempt: outer.attempt,
				};
				const before = await native.prisma.providerObservationUnit.findUniqueOrThrow({
					where: { id: claim.unitId },
				});
				const results =
					scenario === "concurrent"
						? await Promise.all([
								releaseCancelledObservationUnitClaim(native.prisma, input),
								releaseCancelledObservationUnitClaim(native.prisma, input),
							])
						: [await releaseCancelledObservationUnitClaim(native.prisma, input)];
				const released = scenario === "owned" || scenario === "concurrent";
				expect(results.filter(Boolean)).toHaveLength(released ? 1 : 0);
				const after = await native.prisma.providerObservationUnit.findUniqueOrThrow({
					where: { id: claim.unitId },
				});
				if (!released) expect(after).toEqual(before);
				expect(after).toMatchObject({
					cursor: 1,
					expectedRawCount: 2,
					observedRawCount: 1,
					completedPages: 1,
					attemptCount: 2,
					...(released ? { state: "pending", claimToken: null, nextAttemptAt: null } : {}),
				});
				expect(
					await native.prisma.plexEpisodeObservationStage.findUnique({ where: { id: stage.id } }),
				).toEqual(stage);
				if (released) {
					expect(await releaseCancelledObservationUnitClaim(native.prisma, input)).toBe(false);
					const next = await claimObservationUnit(native.prisma, {
						runId: run.id,
						now: new Date(),
					});
					expect(next).toMatchObject({ unitId: claim.unitId, cursor: 1, observedRawCount: 1 });
					expect(next?.claimToken).not.toBe(claim.claimToken);
				}
			});
		} finally {
			await native.close();
			checkTarget();
			rmSync(directory, { recursive: true });
		}
	});
});
