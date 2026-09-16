import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { ArrClientFactory } from "../../arr/client-factory.js";
import { Encryptor } from "../../auth/encryption.js";
import { evidenceFingerprint } from "../../evidence-fingerprint.js";
import type { PrismaClient, ServiceInstance } from "../../prisma.js";
import { TargetWatchReadBudget } from "../../tautulli/target-watch-read-budget.js";
import {
	executeApprovedItems,
	executeCleanupPreview,
	executeCleanupRun,
} from "../cleanup-executor.js";
import { createArrServiceFingerprint } from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

const watchAdapters = vi.hoisted(() => ({
	jellyfinRead: vi.fn(),
	jellyfinVerify: vi.fn(),
	tautulliRead: vi.fn(),
	tautulliVerify: vi.fn(),
}));

const jellyfinEvidence = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("../../jellyfin/jellyfin-target-watch-evidence.js", () => ({
	readJellyfinTargetWatchEvidence: watchAdapters.jellyfinRead,
	revalidateJellyfinTargetWatchEvidence: watchAdapters.jellyfinVerify,
}));
vi.mock("../../tautulli/tautulli-target-watch-evidence.js", () => ({
	readTautulliTargetWatchEvidence: watchAdapters.tautulliRead,
	revalidateTautulliTargetWatchEvidence: watchAdapters.tautulliVerify,
}));
vi.mock("../../jellyfin/jellyfin-evidence-repository.js", () => ({
	readOwnedJellyfinObservation: jellyfinEvidence.read,
	readOwnedJellyfinObservationInTransaction: jellyfinEvidence.read,
}));

const USER_ID = "watch-cleanup-owner";
const MOVIE_ID = 101;
const TMDB_ID = 4242;
const encryptor = new Encryptor("01234567890123456789012345678901");
const silentLog = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
} as unknown as CleanupExecutorDeps["log"];

type ProviderFamily = "jellyfin" | "tautulli";
type Fixture = {
	directory: string;
	prisma: PrismaClient;
	server: Server;
	closeServer: () => Promise<void>;
	arr: ServiceInstance;
	provider: ServiceInstance;
	state: {
		monitored: boolean;
		puts: Array<Record<string, unknown>>;
		gets: number;
	};
	deps: CleanupExecutorDeps;
};

function currentPositiveStatus(availability: "current" | "partial" = "current") {
	return {
		availability,
		evidence: "positive-only" as const,
		reasonCodes: [] as string[],
		domains: [
			{
				domain: "watch-count" as const,
				availability: "current" as const,
				evidence: "positive-only" as const,
				valueSemantics: "lower-bound" as const,
				reasonCodes: [] as string[],
			},
		],
	};
}

function proof(family: ProviderFamily) {
	return {
		userId: USER_ID,
		instanceId: `${family}-provider`,
		mediaType: "movie" as const,
		tmdbId: TMDB_ID,
		generationId: `${family}-generation`,
		coordinate: `${family === "jellyfin" ? "a" : "b"}`.repeat(64),
		observedValue: 3,
		providerStatus: currentPositiveStatus(family === "jellyfin" ? "partial" : "current"),
	};
}

function movie(state: Fixture["state"]) {
	return {
		id: MOVIE_ID,
		tmdbId: TMDB_ID,
		title: "Fixture Movie",
		year: 2024,
		monitored: state.monitored,
		hasFile: true,
		movieFileId: 9001,
		sizeOnDisk: 2_000,
		path: "/movies/Fixture Movie (2024)",
		rootFolderPath: "/movies",
		qualityProfileId: 1,
		qualityProfileName: "HD-1080p",
		status: "released",
		added: "2025-01-01T00:00:00.000Z",
		tags: [],
		genres: ["Drama"],
		originalLanguage: { id: 1, name: "English" },
		statistics: { movieFileCount: 1, sizeOnDisk: 2_000 },
		movieFile: {
			id: 9001,
			path: "/movies/Fixture Movie (2024)/Fixture.Movie.1080p.mkv",
			size: 2_000,
			videoCodec: "x264",
			audioCodec: "AAC",
			resolution: "1080p",
		},
	};
}

async function startRadarr(state: Fixture["state"]): Promise<{
	server: Server;
	baseUrl: string;
	close: () => Promise<void>;
}> {
	const server = createServer(async (request, response) => {
		const parsed = new URL(request.url ?? "/", "http://radarr.fixture");
		if (parsed.pathname !== `/api/v3/movie/${MOVIE_ID}`) {
			response.statusCode = 404;
			response.end();
			return;
		}
		if (request.method === "GET") {
			state.gets++;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(movie(state)));
			return;
		}
		if (request.method === "PUT") {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			state.puts.push(body);
			state.monitored = body.monitored === false ? false : state.monitored;
			response.statusCode = 200;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(movie(state)));
			return;
		}
		response.statusCode = 405;
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Radarr fixture did not bind");
	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

async function createFixture(
	family: ProviderFamily,
	requireApproval = false,
	includeGenericJellyfinObservation = false,
): Promise<Fixture> {
	const directory = mkdtempSync(join(tmpdir(), "positive-watch-cleanup-"));
	const databasePath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(databasePath);
	await prisma.user.create({ data: { id: USER_ID, username: USER_ID } });
	const arrCredentials = encryptor.encrypt("radarr-fixture-key");
	const state: Fixture["state"] = { monitored: true, puts: [], gets: 0 };
	const running = await startRadarr(state);
	const arr = await prisma.serviceInstance.create({
		data: {
			id: "radarr-provider-watch",
			userId: USER_ID,
			service: "RADARR",
			label: "Fixture Radarr",
			baseUrl: running.baseUrl,
			encryptedApiKey: arrCredentials.value,
			encryptionIv: arrCredentials.iv,
		},
	});
	const providerCredentials = encryptor.encrypt(`${family}-fixture-key`);
	const provider = await prisma.serviceInstance.create({
		data: {
			id: `${family}-provider`,
			userId: USER_ID,
			service: family === "jellyfin" ? "JELLYFIN" : "TAUTULLI",
			label: `Fixture ${family}`,
			baseUrl: `http://${family}.fixture`,
			encryptedApiKey: providerCredentials.value,
			encryptionIv: providerCredentials.iv,
			...(family === "jellyfin"
				? {
						expectedIdentity: "jellyfin-fixture-server",
						identityKind: "JELLYFIN_SERVER_ID" as const,
						identityStatus: "VERIFIED" as const,
						identityVerifiedAt: new Date(),
					}
				: {}),
		},
	});
	if (family === "jellyfin" && includeGenericJellyfinObservation) {
		const publishedAt = provider.updatedAt;
		const row = {
			id: "jellyfin-generic-row",
			instanceId: provider.id,
			tmdbId: TMDB_ID,
			mediaType: "movie" as const,
			libraryId: "movies",
			libraryName: "Movies",
			title: "Fixture Movie",
			jellyfinId: "native-movie-42",
			lastWatchedAt: new Date("2026-09-14T00:00:00.000Z"),
			watchCount: 3,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			addedAt: new Date("2025-01-01T00:00:00.000Z"),
			thumb: null,
			connectionGeneration: provider.connectionGeneration,
			identityGeneration: provider.identityGeneration,
		};
		const authority = {
			generationId: "jellyfin-generation",
			publishedAt,
			itemCount: 1,
			connectionGeneration: provider.connectionGeneration,
			identityGeneration: provider.identityGeneration,
			statusFingerprint: evidenceFingerprint({ fixture: "jellyfin-status" }),
			rowFingerprint: evidenceFingerprint([row]),
		};
		await prisma.jellyfinCache.create({ data: row });
		await prisma.cacheRefreshStatus.create({
			data: {
				instanceId: provider.id,
				cacheType: "jellyfin",
				lastRefreshedAt: publishedAt,
				lastResult: "success",
				itemCount: 1,
				generationId: authority.generationId,
				lastAttemptAt: publishedAt,
				lastAttemptResult: "success",
				connectionGeneration: provider.connectionGeneration,
				identityGeneration: provider.identityGeneration,
			},
		});
		jellyfinEvidence.read.mockResolvedValue({
			available: true,
			instanceId: provider.id,
			service: "JELLYFIN",
			cacheType: "jellyfin",
			generationId: authority.generationId,
			publishedAt,
			metadata: null,
			rows: [row],
			providerStatus: proof("jellyfin").providerStatus,
			mutationAvailable: true,
			authority,
		});
	}
	await prisma.libraryCleanupConfig.create({
		data: {
			id: "positive-watch-config",
			userId: USER_ID,
			enabled: true,
			dryRunMode: false,
			requireApproval,
			maxRemovalsPerRun: 10,
			rules: {
				create: {
					id: `${family}-watch-rule`,
					name: `${family} positive watch cleanup`,
					enabled: true,
					priority: 1,
					ruleType: `${family}_watch_count`,
					parameters: JSON.stringify({ operator: "greater_than", count: 2 }),
					serviceFilter: JSON.stringify(["RADARR"]),
					targetScope: "series",
					action: "unmonitor",
				},
			},
		},
	});
	await prisma.libraryCache.create({
		data: {
			id: "positive-watch-cache",
			instanceId: arr.id,
			arrItemId: MOVIE_ID,
			itemType: "movie",
			title: "Fixture Movie",
			year: 2024,
			monitored: true,
			hasFile: true,
			sizeOnDisk: 2_000,
			data: JSON.stringify({
				_arrDashboardSource: { serviceFingerprint: createArrServiceFingerprint(arr) },
				service: "radarr",
				remoteIds: { tmdbId: TMDB_ID },
				path: "/movies/Fixture Movie (2024)",
				movieFile: { path: "/movies/Fixture Movie (2024)/Fixture.Movie.1080p.mkv" },
			}),
			cachedAt: new Date(arr.updatedAt.getTime() + 1_000),
			arrAddedAt: new Date("2025-01-01T00:00:00.000Z"),
		},
	});
	const deps: CleanupExecutorDeps = {
		prisma,
		encryptor,
		arrClientFactory: new ArrClientFactory(encryptor),
		log: silentLog,
		skipPendingMediaServerRescanRetry: true,
	};
	if (family === "jellyfin" && includeGenericJellyfinObservation) {
		Object.assign(deps, { providerEvidenceAuthorityChecker: vi.fn().mockResolvedValue(undefined) });
	}
	databases.push({
		directory,
		prisma,
		server: running.server,
		closeServer: running.close,
		arr,
		provider,
		state,
		deps,
	});
	return {
		directory,
		prisma,
		server: running.server,
		closeServer: running.close,
		arr,
		provider,
		state,
		deps,
	};
}

const databases: Fixture[] = [];

afterEach(async () => {
	vi.clearAllMocks();
	for (const fixture of databases.splice(0)) {
		await fixture.prisma.$disconnect();
		await fixture.closeServer().catch(() => undefined);
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

beforeEach(() => {
	jellyfinEvidence.read.mockResolvedValue(null);
});

function configureProvider(family: ProviderFamily, verify: () => Promise<boolean>) {
	const itemProof = proof(family);
	if (family === "jellyfin") {
		watchAdapters.jellyfinRead.mockResolvedValue([itemProof]);
		watchAdapters.jellyfinVerify.mockImplementation(verify);
	} else {
		watchAdapters.tautulliRead.mockResolvedValue([itemProof]);
		watchAdapters.tautulliVerify.mockImplementation(verify);
	}
}

describe.each(["jellyfin", "tautulli"] as const)(
	"positive %s watch cleanup against disposable SQLite and Radarr",
	(family) => {
		it("keeps preview write-free, then unmonitors only after current proof", async () => {
			const fixture = await createFixture(family);
			configureProvider(family, async () => true);

			const preview = await executeCleanupPreview(fixture.deps, USER_ID);
			expect(preview).toMatchObject({ itemsEvaluated: 1, itemsFlagged: 1, itemsUnmonitored: 0 });
			expect(fixture.state.puts).toHaveLength(0);
			expect(await fixture.prisma.libraryCleanupApproval.count()).toBe(0);
			expect(
				await fixture.prisma.libraryCache.findUniqueOrThrow({
					where: { id: "positive-watch-cache" },
				}),
			).toMatchObject({ monitored: true });

			const result = await executeCleanupRun(fixture.deps, USER_ID);
			expect(result).toMatchObject({ itemsEvaluated: 1, itemsFlagged: 1, itemsUnmonitored: 1 });
			expect(fixture.state.monitored).toBe(false);
			expect(fixture.state.puts).toHaveLength(1);
			expect(fixture.state.puts[0]).toMatchObject({
				id: MOVIE_ID,
				tmdbId: TMDB_ID,
				monitored: false,
			});
			expect(
				await fixture.prisma.libraryCache.findUniqueOrThrow({
					where: { id: "positive-watch-cache" },
				}),
			).toMatchObject({ monitored: false });
		}, 15_000);

		it("leaves the ARR target untouched and expires the intent when reproof changes", async () => {
			const fixture = await createFixture(family);
			let verificationCalls = 0;
			configureProvider(family, async () => {
				verificationCalls++;
				return verificationCalls === 1;
			});

			const result = await executeCleanupRun(fixture.deps, USER_ID);
			expect(result.itemsFlagged).toBe(1);
			expect(result.itemsUnmonitored).toBe(0);
			expect(result.itemsSkipped).toBeGreaterThanOrEqual(1);
			expect(fixture.state.monitored).toBe(true);
			expect(fixture.state.puts).toHaveLength(0);
			const retry = await fixture.prisma.libraryCleanupApproval.findFirstOrThrow();
			expect(retry.status).toBe("expired");
			expect(retry.lastExecutionError).toContain("provider evidence");
		}, 15_000);

		it("queues an approval without ARR writes and executes it after approval", async () => {
			const fixture = await createFixture(family, true);
			configureProvider(family, async () => true);

			const queued = await executeCleanupRun(fixture.deps, USER_ID);
			expect(queued).toMatchObject({ itemsFlagged: 1, itemsUnmonitored: 0 });
			expect(fixture.state.puts).toHaveLength(0);
			const approval = await fixture.prisma.libraryCleanupApproval.findFirstOrThrow();
			expect(approval.status).toBe("pending");

			await fixture.prisma.libraryCleanupApproval.update({
				where: { id: approval.id },
				data: { status: "approved" },
			});
			const executed = await executeApprovedItems(fixture.deps, USER_ID, [approval.id]);
			expect(executed).toMatchObject({ removed: 1, failed: 0 });
			expect(fixture.state.monitored).toBe(false);
			expect(fixture.state.puts).toHaveLength(1);
		}, 15_000);
	},
);

it("reports an exhausted provider budget as partial without flagging or mutating unverified items", async () => {
	const fixture = await createFixture("tautulli");
	configureProvider("tautulli", async () => true);
	const budget = new TargetWatchReadBudget(0);
	expect(budget.tryConsume()).toBe(false);
	const deps = { ...fixture.deps, targetWatchReadBudget: budget };
	const preview = await executeCleanupPreview(deps, USER_ID);
	expect(preview).toMatchObject({ status: "partial", itemsFlagged: 0, itemsUnmonitored: 0 });
	expect(preview.warnings).toEqual(
		expect.arrayContaining([expect.stringContaining("provider read limit")]),
	);
	expect(await fixture.prisma.libraryCleanupLog.count()).toBe(0);
	const result = await executeCleanupRun(deps, USER_ID);
	expect(result).toMatchObject({ status: "partial", itemsFlagged: 0, itemsUnmonitored: 0 });
	expect(fixture.state.puts).toHaveLength(0);
	expect(watchAdapters.tautulliRead).not.toHaveBeenCalled();
	const log = await fixture.prisma.libraryCleanupLog.findFirstOrThrow();
	expect(log.status).toBe("partial");
	expect(log.warnings).toContain("provider read limit");
}, 30_000);

it("uses target proof alongside a generic Jellyfin observation for preview and mutation", async () => {
	const fixture = await createFixture("jellyfin", false, true);
	configureProvider("jellyfin", async () => true);

	const preview = await executeCleanupPreview(fixture.deps, USER_ID);
	expect(preview).toMatchObject({ itemsEvaluated: 1, itemsFlagged: 1, itemsUnmonitored: 0 });
	expect(fixture.state.puts).toHaveLength(0);

	const result = await executeCleanupRun(fixture.deps, USER_ID);
	expect(result).toMatchObject({ itemsEvaluated: 1, itemsFlagged: 1, itemsUnmonitored: 1 });
	expect(fixture.state.puts).toHaveLength(1);
	expect(watchAdapters.jellyfinVerify).toHaveBeenCalledWith(
		expect.objectContaining({ threshold: 2 }),
	);

	const approvedFixture = await createFixture("jellyfin", true, true);
	configureProvider("jellyfin", async () => true);
	const queued = await executeCleanupRun(approvedFixture.deps, USER_ID);
	expect(queued).toMatchObject({ itemsFlagged: 1, itemsUnmonitored: 0 });
	const approval = await approvedFixture.prisma.libraryCleanupApproval.findFirstOrThrow();
	await approvedFixture.prisma.libraryCleanupApproval.update({
		where: { id: approval.id },
		data: { status: "approved" },
	});
	const executed = await executeApprovedItems(approvedFixture.deps, USER_ID, [approval.id]);
	expect(executed).toMatchObject({ removed: 1, failed: 0 });
	expect(approvedFixture.state.puts).toHaveLength(1);
	expect(watchAdapters.jellyfinVerify).toHaveBeenCalledWith(
		expect.objectContaining({ threshold: 2 }),
	);
}, 30_000);
