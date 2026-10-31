import { once } from "node:events";
import { existsSync, lstatSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { afterAll, describe, expect, it } from "vitest";
import { getRestoreRuntimeClientContext } from "../../lib/backup/restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../../lib/jellyfin/jellyfin-generation-metadata.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { encodeAuthoritativePlexGenerationMetadata } from "../../lib/plex/plex-generation-metadata.js";
import { createPlexTargetLedgerBinding } from "../../lib/plex/plex-generation-target-ledger.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import jellyfin from "../jellyfin-episode-cache-scheduler.js";
import notifications from "../notification-service.js";
import plex from "../plex-episode-cache-scheduler.js";
import registry from "../scheduler-registry.js";

type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type Service = "PLEX" | "JELLYFIN" | "EMBY";
const observations: Record<string, unknown>[] = [];
function ownedFixtureDirectory(native: Native): string {
	const url = new URL(getRestoreRuntimeClientContext(native.runtime).databaseUrl);
	if (url.protocol !== "file:") throw Error("Owned synthetic SQLite fixture required");
	const file = fileURLToPath(url),
		directory = dirname(file);
	if (basename(file) !== "owned.db") throw Error("Owned synthetic SQLite fixture required");
	assertOwnedFixtureDirectory(directory);
	return directory;
}

function assertOwnedFixtureDirectory(directory: string): void {
	if (
		dirname(directory) !== realpathSync(tmpdir()) ||
		!/^arr-outbox-worker-[A-Za-z0-9]+$/.test(basename(directory)) ||
		!lstatSync(directory).isDirectory() ||
		lstatSync(directory).isSymbolicLink() ||
		realpathSync(directory) !== directory ||
		!lstatSync(join(directory, "owned.db")).isFile() ||
		lstatSync(join(directory, "owned.db")).isSymbolicLink()
	)
		throw Error("Owned synthetic SQLite fixture required");
}
afterAll(() => {
	if (process.env.EPISODE_CANCELLATION_REPORT)
		writeFileSync(
			process.env.EPISODE_CANCELLATION_REPORT,
			`${JSON.stringify(observations, null, 2)}\n`,
			{
				mode: 0o600,
				flag: "wx",
			},
		);
});

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | "expired"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<"expired">((resolve) => {
				timer = setTimeout(() => resolve("expired"), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// Real persisted parent evidence, using the existing repository fixture contracts.
// No authority reader, identity guard, HTTP client or refresher is mocked.
async function seedParent(native: Native, service: Service, baseUrl: string) {
	return await native.run(async () => {
		const now = new Date(),
			encrypted = native.encryptor.encrypt("synthetic-token");
		const instance = await native.prisma.serviceInstance.create({
			data: {
				userId: native.userId,
				service,
				label: "Synthetic",
				baseUrl,
				enabled: true,
				encryptedApiKey: encrypted.value,
				encryptionIv: encrypted.iv,
				connectionGeneration: 7,
				identityGeneration: 3,
				expectedIdentity: "synthetic-id",
				identityStatus: "VERIFIED",
				...(service === "PLEX"
					? { identityKind: "PLEX_MACHINE_IDENTIFIER", identityVerifiedAt: now }
					: {}),
			},
		});
		const unit = {
			scopeKey: service === "PLEX" ? "section:shows" : "library:library-1",
			expectedRawCount: 1,
			pagesAttempted: 1,
			pagesCompleted: 1,
			rawObserved: 1,
			sourceBindings: 1,
			canonicalEntities: 1,
			acceptedSkips: [],
			fatalCount: 0,
		};
		const receipt = {
			version: 2 as const,
			provider:
				service === "PLEX"
					? ("plex" as const)
					: service === "EMBY"
						? ("emby" as const)
						: ("jellyfin" as const),
			attemptStartedAt: now.toISOString(),
			observedAt: now.toISOString(),
			evidence: "complete" as const,
			units: [unit],
			publishedCanonicalEntities: 1,
			domains: (
				["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"] as const
			).map((domain) => ({
				domain,
				evidence: "complete" as const,
				valueSemantics: "exact" as const,
				units: [
					{ ...unit, scopeKey: service === "PLEX" ? "section:shows" : `${domain}:library-1` },
				],
				publishedCanonicalEntities: 1,
			})),
		};
		let metadata: string;
		if (service === "PLEX") {
			const target = {
				instanceId: instance.id,
				generationId: "seeded-parent",
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series" as const,
				tmdbId: 42,
				tvdbId: 99,
				ratingKey: "show-1",
			};
			const targetLedger = createPlexTargetLedgerBinding({
				instanceId: instance.id,
				generationId: "seeded-parent",
				connectionGeneration: 7,
				identityGeneration: 3,
				targets: [target],
			});
			metadata = encodeAuthoritativePlexGenerationMetadata({
				sections: [
					{
						key: "shows",
						uuid: "shows-uuid",
						title: "Shows",
						type: "show",
						refreshing: false,
						scannedAt: 1,
						updatedAt: 2,
					},
				],
				itemCount: 1,
				canonicalizationVersion: 1,
				targetLedger,
				partialReasons: [],
				roots: [{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) }],
				coverageReceipt: { ...receipt, provider: "plex" },
			});
			await native.prisma.plexCache.create({
				data: {
					instanceId: instance.id,
					tmdbId: 42,
					mediaType: "series",
					sectionId: "shows",
					sectionTitle: "Shows",
					ratingKey: "show-1",
					watchedByUsers: "[]",
					collections: "[]",
					labels: "[]",
					connectionGeneration: 7,
					identityGeneration: 3,
				},
			});
			await native.prisma.plexGenerationTarget.create({ data: target });
		} else {
			const row = {
				instanceId: instance.id,
				tmdbId: 42,
				mediaType: "series" as const,
				libraryId: "library-1",
				libraryName: "Library",
				title: "Show",
				jellyfinId: "series-1",
				lastWatchedAt: null,
				watchCount: 0,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				addedAt: null,
				thumb: null,
				connectionGeneration: 7,
				identityGeneration: 3,
			};
			metadata = encodeJellyfinLibraryGenerationMetadata({
				version: 1,
				provider: service === "EMBY" ? "emby" : "jellyfin",
				cacheType: "jellyfin",
				publicationLevel: "authoritative",
				completeness: "complete",
				canonicalizationVersion: 1,
				itemCount: 1,
				connectionGeneration: 7,
				identityGeneration: 3,
				contentFingerprint: fingerprintJellyfinLibraryRows([row]),
				coverageReceipt: { ...receipt, provider: service === "EMBY" ? "emby" : "jellyfin" },
			});
			await native.prisma.jellyfinCache.create({ data: row });
		}
		const cacheType = service === "PLEX" ? "plex" : "jellyfin";
		const common = {
			instanceId: instance.id,
			lastRefreshedAt: now,
			lastResult: "success",
			itemCount: 1,
			lastAttemptAt: now,
			lastAttemptResult: "success",
			connectionGeneration: 7,
			identityGeneration: 3,
		};
		await native.prisma.cacheRefreshStatus.createMany({
			data: [
				{ ...common, cacheType, generationId: "seeded-parent", generationMetadata: metadata },
				{
					...common,
					cacheType: `${cacheType}_episode`,
					generationId: "seeded-last-good",
					generationMetadata: "synthetic-last-good-metadata",
				},
			],
		});
		const episode = {
			instanceId: instance.id,
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 1,
			title: "Last good synthetic episode",
			watched: true,
			watchedByUsers: "[]",
			connectionGeneration: 7,
			identityGeneration: 3,
		};
		if (service === "PLEX")
			await native.prisma.plexEpisodeCache.create({
				data: { ...episode, ratingKey: "old-episode" },
			});
		else
			await native.prisma.jellyfinEpisodeCache.create({
				data: { ...episode, jellyfinId: "old-episode" },
			});
		return { instance, now, cacheType: `${cacheType}_episode` };
	});
}

describe("episode shutdown physically cancels accepted provider reads", () => {
	for (const service of ["PLEX", "JELLYFIN", "EMBY"] as const) {
		for (const phase of ["headers", "body"] as const) {
			// Missing cancellation must fail close/socket expectations while the real
			// provider request is held. Cleanup release is never a passing result.
			it(`${service}: ${phase}`, async () => {
				const native = await createNotificationOutboxNativeFixture();
				const fixtureDirectory = ownedFixtureDirectory(native);
				const sockets = new Set<Socket>(),
					paths: string[] = [];
				let response: ServerResponse | undefined,
					heldClosed = false,
					released = false,
					invalid = 0;
				let admitted!: () => void;
				const accepted = new Promise<void>((resolve) => {
					admitted = resolve;
				});
				const heldPath = service === "PLEX" ? "/library/metadata/show-1/allLeaves" : "/Users";
				const server = createServer((request, reply) => {
					const path = new URL(request.url!, "http://synthetic.invalid").pathname;
					paths.push(path);
					if (
						request.method !== "GET" ||
						(service === "PLEX"
							? request.headers["x-plex-token"] !== "synthetic-token"
							: !request.headers.authorization?.includes('Token="synthetic-token"'))
					)
						invalid++;
					if (path === (service === "PLEX" ? "/identity" : "/System/Info")) {
						reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
						reply.end(
							JSON.stringify(
								service === "PLEX"
									? { MediaContainer: { machineIdentifier: "synthetic-id", version: "1" } }
									: { Id: "synthetic-id", ServerName: "Synthetic", Version: "1" },
							),
						);
					} else if (path === heldPath && !response) {
						response = reply;
						reply.once("close", () => {
							heldClosed = true;
						});
						if (phase === "body") {
							reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
							reply.write('{"');
						}
						admitted();
					} else {
						invalid++;
						reply.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
						reply.end("{}");
					}
				});
				server.on("connection", (socket) => {
					sockets.add(socket);
					socket.once("close", () => sockets.delete(socket));
				});
				try {
					server.listen(0, "127.0.0.1");
					await once(server, "listening");
					const address = server.address();
					if (!address || typeof address === "string") throw Error("missing synthetic loopback");
					const seeded = await seedParent(native, service, `http://127.0.0.1:${address.port}`);
					await native.restart(false);
					const client = createRuntimePrismaClient(native.runtime),
						app = Fastify({ logger: false });
					app.decorate("restoreRuntime", native.runtime);
					app.decorate("prisma", client.prisma);
					app.decorate("encryptor", native.encryptor);
					app.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
					let clientClosed = false,
						closing: Promise<void> | undefined;
					const observation: Record<string, unknown> = { service, phase, heldPath };
					observations.push(observation);
					await app.register(
						fp(
							async (instance) => {
								instance.addHook("onClose", async () => {
									expect(
										app.schedulerRegistry.getStatus(
											service === "PLEX" ? JOB_ID.plexEpisodeCache : JOB_ID.jellyfinEpisodeCache,
										)?.state,
									).toBe("idle");
									await client.close();
									clientClosed = true;
								});
							},
							{ name: "prisma" },
						),
					);
					await app.register(fp(async () => {}, { name: "security" }));
					if (service === "PLEX") registerRestoreBootstrapPlugin(app, notifications);
					registerRestoreBootstrapPlugin(app, registry);
					registerRestoreBootstrapPlugin(app, service === "PLEX" ? plex : jellyfin);
					registerRestoreRuntimeActivation(app);
					const realTimeout = globalThis.setTimeout;
					let startupSelected = 0;
					globalThis.setTimeout = ((
						callback: (...args: unknown[]) => void,
						ms?: number,
						...args: unknown[]
					) => {
						if (ms === (service === "PLEX" ? 300_000 : 360_000) && startupSelected === 0) {
							startupSelected++;
							return realTimeout(callback, 1, ...args);
						}
						return realTimeout(callback, ms, ...args);
					}) as typeof setTimeout;
					try {
						await app.ready();
						globalThis.setTimeout = realTimeout;
						expect(await within(accepted, 4000), "real episode provider read admission").not.toBe(
							"expired",
						);
						expect(startupSelected).toBe(1);
						expect(invalid).toBe(0);
						const start = performance.now();
						closing = app.close();
						const result = await within(closing, 2500);
						if (result !== "expired") {
							for (let i = 0; i < 100 && !heldClosed; i++) await delay(10);
						}
						Object.assign(observation, {
							elapsedMs: performance.now() - start,
							closeResolved: result !== "expired",
							heldClosed,
							released,
							clientClosed,
							paths: [...paths],
							invalid,
						});
						// Soft expectations preserve both failure categories before finally joins.
						expect
							.soft(result, "close must join without fixture responder release")
							.not.toBe("expired");
						expect
							.soft(heldClosed, "actual held provider socket must close on shutdown")
							.toBe(true);
						expect
							.soft(clientClosed, "database client closes after accepted work physically joins")
							.toBe(true);
					} finally {
						globalThis.setTimeout = realTimeout;
						if (response && !response.destroyed && !response.writableEnded) {
							released = true;
							if (phase === "headers")
								response.writeHead(503, {
									"Content-Type": "application/json",
									Connection: "close",
								});
							response.end(phase === "body" ? 'unfinished":true}' : "{}");
						}
						await (closing ?? app.close());
						const status = await native.run(() =>
							native.prisma.cacheRefreshStatus.findUniqueOrThrow({
								where: {
									instanceId_cacheType: {
										instanceId: seeded.instance.id,
										cacheType: seeded.cacheType,
									},
								},
							}),
						);
						const lastGoodRetained =
							status.generationId === "seeded-last-good" &&
							status.lastResult === "success" &&
							status.generationMetadata === "synthetic-last-good-metadata" &&
							status.lastRefreshedAt?.getTime() === seeded.now.getTime();
						const episodeRows = await native.run(async () =>
							service === "PLEX"
								? await native.prisma.plexEpisodeCache.findMany({
										where: { instanceId: seeded.instance.id },
									})
								: await native.prisma.jellyfinEpisodeCache.findMany({
										where: { instanceId: seeded.instance.id },
									}),
						);
						const requestCount = paths.length;
						await new Promise<void>((resolve, reject) =>
							server.close((error) => (error ? reject(error) : resolve())),
						);
						await delay(50);
						await native.close();
						assertOwnedFixtureDirectory(fixtureDirectory);
						rmSync(fixtureDirectory, { recursive: true });
						await delay(50);
						Object.assign(observation, {
							cleanupReleased: released,
							clientClosedAtEnd: clientClosed,
							heldClosedAtEnd: heldClosed,
							socketsAtEnd: sockets.size,
							providerClosed: !server.listening,
							nativeClosed: true,
							fixtureRemoved: !existsSync(fixtureDirectory),
							lastGoodRetained,
							attemptResult: status.lastAttemptResult,
							requestsAfterJoin: paths.length - requestCount,
							allPaths: [...paths],
							invalidAtEnd: invalid,
							lastGoodEpisodeRows: episodeRows.length,
						});
						expect(
							lastGoodRetained,
							"last good episode publication survives aborted collection",
						).toBe(true);
						expect(episodeRows).toHaveLength(1);
						expect(episodeRows[0]).toMatchObject({
							showTmdbId: 42,
							seasonNumber: 1,
							episodeNumber: 1,
							title: "Last good synthetic episode",
							watched: true,
						});
						expect(sockets.size).toBe(0);
						expect(paths).toHaveLength(requestCount);
						expect(clientClosed).toBe(true);
						expect(invalid).toBe(0);
					}
				} finally {
					// Also join fixture/setup failures, which never count as behavioral RED.
					if (server.listening) {
						for (const socket of sockets) socket.destroy();
						await new Promise<void>((resolve) => server.close(() => resolve()));
					}
					await native.close();
					if (existsSync(fixtureDirectory)) {
						assertOwnedFixtureDirectory(fixtureDirectory);
						rmSync(fixtureDirectory, { recursive: true });
					}
				}
			}, 20_000);
		}
	}
});
