import { parentPort, workerData } from "node:worker_threads";
import { openRestoreRuntimeWorker } from "../../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../backup/restore-runtime-client.js";
import {
	prepareNativeWatchGeneration,
	verifyPreparedNativeWatchGeneration,
} from "../../jellyfin-native-watch-repository.js";

if (!parentPort) throw new Error("Fixture parent missing");
const port = parentPort;
const runtime = await openRestoreRuntimeWorker(workerData.binding, workerData.databaseUrl);
let client: ReturnType<typeof createRuntimePrismaClient> | undefined;
let result: object | undefined;
try {
	client = createRuntimePrismaClient(runtime);
	const prisma = client.prisma;
	result = await runtime.runOperation(async () => {
		await prisma.user.create({ data: { id: "owner", username: "synthetic" } });
		await prisma.serviceInstance.create({
			data: {
				id: "instance",
				userId: "owner",
				service: "JELLYFIN",
				label: "Synthetic",
				baseUrl: "https://provider.invalid",
				encryptedApiKey: "not-a-key",
				encryptionIv: "not-an-iv",
				identityStatus: "VERIFIED",
				expectedIdentity: "synthetic",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		const inputFor = async (runId: string, count: number) => {
			await prisma.providerObservationRun.create({
				data: {
					id: runId,
					instanceId: "instance",
					provider: "jellyfin_episode",
					cacheType: "jellyfin_episode",
					authorityKey: runId,
					targetDigest: runId,
					targetCount: 1,
					connectionGeneration: 1,
					identityGeneration: 1,
					state: "running",
					activeSlotKey: runId,
					totalUnits: 2,
					completedUnits: 2,
					totalWork: 1,
					completedWork: 1,
				},
			});
			await prisma.jellyfinEpisodePreparation.create({
				data: {
					runId,
					instanceId: "instance",
					generationId: runId,
					token: "synthetic-token",
					state: "verified",
					leaseExpiresAt: new Date(Date.now() + 300_000),
				},
			});
			return {
				userId: "owner",
				instanceId: "instance",
				runId,
				cacheGenerationId: runId,
				preparationToken: "synthetic-token",
				connectionGeneration: 1,
				identityGeneration: 1,
				observedAt: new Date(),
				expectedScopeCount: 1,
				candidates: Array.from({ length: count }, (_, index) => ({
					userKeyDigest: "synthetic-digest",
					libraryId: "synthetic-library",
					jellyfinId: `episode-${String(index).padStart(5, "0")}`,
					seriesId: "synthetic-series",
					seasonNumber: 1,
					episodeNumber: index + 1,
					played: false,
					playCount: 0,
					lastPlayedAt: null,
				})),
				receipts: [
					{
						userKeyDigest: "synthetic-digest",
						libraryId: "synthetic-library",
						expectedRawCount: count,
						observedRawCount: count,
						exact: true,
						contentFingerprint: "a".repeat(64),
					},
				],
			};
		};
		const counts = async (runId: string) => ({
			rows: await prisma.jellyfinNativeWatchRow.count({ where: { runId } }),
			receipts: await prisma.jellyfinNativeWatchScopeReceipt.count({ where: { runId } }),
			pointers: await prisma.jellyfinNativeWatchPublication.count(),
		});
		// Owned synthetic SQL cost from the native reproduction: about 7.2s for
		// 500 rows. Production transaction/proof/lease defaults remain unchanged.
		await prisma.$executeRawUnsafe(`CREATE TRIGGER synthetic_native_watch_row_cost
			AFTER INSERT ON jellyfin_native_watch_rows BEGIN
				SELECT (WITH RECURSIVE synthetic_cost(x) AS (
					VALUES(1) UNION ALL SELECT x+1 FROM synthetic_cost WHERE x < 150000
				) SELECT SUM(x) FROM synthetic_cost);
			END`);
		const loaded = await inputFor("loaded", 500);
		let failure: string | null = null;
		try {
			await prepareNativeWatchGeneration(prisma, loaded);
		} catch (error) {
			failure = error instanceof Error ? error.name : "unknown";
		}
		const loadedCounts = await counts("loaded");
		await prisma.$executeRawUnsafe("DROP TRIGGER synthetic_native_watch_row_cost");
		// A later transaction fails after part of that chunk has executed. Its
		// rows must roll back and the earlier committed chunk must stay invisible.
		const rejected = await inputFor("rejected", 550);
		await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_later_native_watch_row
			BEFORE INSERT ON jellyfin_native_watch_rows
			WHEN NEW.runId = 'rejected' AND NEW.jellyfinId = 'episode-00350'
			BEGIN SELECT RAISE(ABORT, 'synthetic later chunk rejection'); END`);
		let rejectedWrite = false;
		try {
			await prepareNativeWatchGeneration(prisma, rejected);
		} catch {
			rejectedWrite = true;
		}
		const rejectedCounts = await counts("rejected");
		let rejectedVerification = false;
		try {
			await verifyPreparedNativeWatchGeneration(prisma, rejected);
		} catch {
			rejectedVerification = true;
		}
		await prisma.$executeRawUnsafe("DROP TRIGGER reject_later_native_watch_row");
		await prepareNativeWatchGeneration(prisma, rejected);
		return {
			failure,
			loaded: loadedCounts,
			rejectedWrite,
			rejectedVerification,
			rejected: rejectedCounts,
			recovered: await counts("rejected"),
		};
	});
} finally {
	try {
		await client?.close();
	} finally {
		await runtime.close();
	}
}
port.postMessage({ result, clientClosed: true, runtimeClosed: true });
port.close();
