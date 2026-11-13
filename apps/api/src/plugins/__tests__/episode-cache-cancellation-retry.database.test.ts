import { once } from "node:events";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { getRestoreRuntimeClientContext } from "../../lib/backup/restore-runtime-admission.js";
import { refreshOwnedJellyfinEpisodeCache } from "../../lib/jellyfin/jellyfin-episode-cache-refresher.js";
import { runJellyfinEpisodeFinalizerWorker } from "../../lib/jellyfin/jellyfin-episode-finalizer-worker-transport.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../../lib/jellyfin/jellyfin-generation-metadata.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { encodeAuthoritativePlexGenerationMetadata } from "../../lib/plex/plex-generation-metadata.js";
import { createPlexTargetLedgerBinding } from "../../lib/plex/plex-generation-target-ledger.js";
import { refreshOwnedPlexEpisodeCache } from "../../lib/plex/plex-refresh-orchestration.js";

type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type Service = "PLEX" | "JELLYFIN" | "EMBY";
function ownedFixtureDirectory(native: Native) {
	const url = new URL(getRestoreRuntimeClientContext(native.runtime).databaseUrl);
	if (url.protocol !== "file:") throw Error("Owned synthetic SQLite fixture required");
	const file = fileURLToPath(url),
		dir = dirname(file);
	if (basename(file) !== "owned.db") throw Error("Owned synthetic SQLite fixture required");
	assertOwnedFixtureDirectory(dir);
	return dir;
}
function assertOwnedFixtureDirectory(dir: string) {
	if (
		dirname(dir) !== realpathSync(tmpdir()) ||
		!/^arr-outbox-worker-[A-Za-z0-9]+$/.test(basename(dir)) ||
		lstatSync(dir).isSymbolicLink() ||
		realpathSync(dir) !== dir
	)
		throw Error("Owned synthetic SQLite fixture required");
}
async function bounded<T>(promise: Promise<T>, ms = 1500): Promise<T | "expired"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<"expired">((resolve) => {
				timer = setTimeout(() => resolve("expired"), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
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

describe("cancelled episode work can really resume", () => {
	it.each(["JELLYFIN", "EMBY"] as const)(
		"%s cancels a real owned episode page then resumes and publishes",
		async (service) => {
			const native = await createNotificationOutboxNativeFixture(),
				directory = ownedFixtureDirectory(native),
				app = Fastify({ logger: false }),
				controller = new AbortController();
			let held: ServerResponse | undefined,
				accepted!: () => void,
				readComplete = false,
				released = false,
				socketClosed = false,
				invalid = 0,
				pageReads = 0;
			const ready = new Promise<void>((resolve) => {
				accepted = resolve;
			});
			const server = createServer((request, response) => {
				response.setHeader("Content-Type", "application/json");
				response.setHeader("Connection", "close");
				const path = new URL(request.url!, "http://synthetic.invalid").pathname;
				if (request.method !== "GET") invalid++;
				if (path === "/System/Info")
					return response.end(
						JSON.stringify({ Id: "synthetic-id", ServerName: "Synthetic", Version: "1" }),
					);
				if (path === "/Users")
					return response.end(JSON.stringify([{ Id: "synthetic-user", Name: "Synthetic" }]));
				if (path === "/Users/synthetic-user/Views")
					return response.end(
						JSON.stringify({
							Items: [
								{
									Id: "library-1",
									Name: "Library",
									CollectionType: "tvshows",
									Type: "CollectionFolder",
								},
							],
							TotalRecordCount: 1,
						}),
					);
				if (path === "/Users/synthetic-user/Items") {
					pageReads++;
					if (!readComplete) {
						held = response;
						response.once("close", () => {
							socketClosed = true;
						});
						accepted();
						return;
					}
					return response.end(
						JSON.stringify({
							StartIndex: 0,
							TotalRecordCount: 1,
							Items: [
								{
									Id: "episode-1",
									Name: "Synthetic episode",
									Type: "Episode",
									SeriesId: "series-1",
									ParentIndexNumber: 1,
									IndexNumber: 1,
									UserData: { Played: true, PlayCount: 2 },
								},
							],
						}),
					);
				}
				invalid++;
				response.writeHead(503);
				response.end("{}");
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string") throw Error("missing synthetic loopback");
			let pending: Promise<unknown> | undefined,
				stagedRowsObserved = 0;
			try {
				const { instance } = await seedParent(native, service, `http://127.0.0.1:${address.port}`);
				const context = {
					prisma: native.prisma,
					databaseUrl: getRestoreRuntimeClientContext(native.runtime).databaseUrl,
					encryptor: native.encryptor,
					instance,
					log: app.log,
					resumeFailed: false,
				};
				pending = native
					.run(() => refreshOwnedJellyfinEpisodeCache({ ...context, signal: controller.signal }))
					.catch((error) => error);
				expect(await bounded(ready, 5000), "actual episode page worker request admission").not.toBe(
					"expired",
				);
				const before = await native.run(() =>
					native.prisma.providerObservationUnit.findFirstOrThrow({
						where: { run: { instanceId: instance.id }, state: "running" },
					}),
				);
				controller.abort(new Error("SECRET_SENTINEL"));
				const cancelled = await bounded(pending);
				if (cancelled === "expired") {
					released = true;
					readComplete = true;
					held?.writeHead(503);
					held?.end("{}");
				}
				await pending;
				for (let i = 0; i < 100 && !socketClosed; i++) await delay(10);
				const after = await native.run(() =>
					native.prisma.providerObservationUnit.findUniqueOrThrow({ where: { id: before.id } }),
				);
				expect.soft(cancelled).toMatchObject({ code: "PUBLICATION_CANCELLED" });
				expect.soft(released, "cancellation never needs fixture response release").toBe(false);
				expect.soft(socketClosed).toBe(true);
				expect.soft(after).toMatchObject({
					state: "pending",
					claimToken: null,
					nextAttemptAt: null,
					attemptCount: before.attemptCount,
					cursor: before.cursor,
					observedRawCount: before.observedRawCount,
					completedPages: before.completedPages,
				});
				readComplete = true;
				let complete = false,
					upserted = 0;
				for (let work = 0; work < 6 && !complete; work++) {
					const result = await native.run(() => refreshOwnedJellyfinEpisodeCache(context));
					stagedRowsObserved = Math.max(
						stagedRowsObserved,
						await native.run(() =>
							native.prisma.jellyfinEpisodeObservationStage.count({
								where: { runId: before.runId },
							}),
						),
					);
					complete = result.complete;
					upserted = result.upserted;
				}
				expect(complete, "real next owned work items eventually publish").toBe(true);
				expect(upserted).toBe(1);
				expect(stagedRowsObserved).toBeGreaterThan(0);
				const status = await native.run(() =>
					native.prisma.cacheRefreshStatus.findUniqueOrThrow({
						where: {
							instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin_episode" },
						},
					}),
				);
				expect(["success", "partial"]).toContain(status.lastAttemptResult);
				expect(status.generationId).not.toBe("seeded-last-good");
				const published = await native.run(() =>
					native.prisma.jellyfinEpisodeGenerationRow.findMany({
						where: { instanceId: instance.id, generationId: status.generationId! },
					}),
				);
				expect(published).toHaveLength(1);
				expect(published[0]).toMatchObject({
					showTmdbId: 42,
					seasonNumber: 1,
					episodeNumber: 1,
					watched: true,
				});
				expect(
					await native.run(() =>
						native.prisma.serviceInstance.findUniqueOrThrow({ where: { id: instance.id } }),
					),
				).toMatchObject({
					identityStatus: "VERIFIED",
					connectionGeneration: 7,
					identityGeneration: 3,
				});
				expect(invalid).toBe(0);
				process.stdout.write(
					`${JSON.stringify({ category: "owned-episode-page-retry", service, pageReads, released, socketClosed, attemptCountBefore: before.attemptCount, attemptCountAfter: after.attemptCount, stagedRowsObserved, publishedRows: published.length, attemptResult: status.lastAttemptResult })}\n`,
				);
			} finally {
				readComplete = true;
				if (held && !held.destroyed) held.end("{}");
				await pending;
				await app.close();
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await native.close();
				assertOwnedFixtureDirectory(directory);
				rmSync(directory, { recursive: true });
			}
		},
		20_000,
	);
	it("releases its own Plex claim without spending retry allowance and publishes on actual retry", async () => {
		const native = await createNotificationOutboxNativeFixture(),
			directory = ownedFixtureDirectory(native),
			app = Fastify({ logger: false }),
			controller = new AbortController();
		let held: ServerResponse | undefined,
			accepted!: () => void,
			complete = false;
		const ready = new Promise<void>((resolve) => {
			accepted = resolve;
		});
		const server = createServer((request, response) => {
			response.setHeader("Content-Type", "application/json");
			response.setHeader("Connection", "close");
			if (request.url?.startsWith("/identity"))
				return response.end(
					JSON.stringify({ MediaContainer: { machineIdentifier: "synthetic-id", version: "1" } }),
				);
			if (!request.url?.startsWith("/library/metadata/show-1/allLeaves")) {
				response.writeHead(503);
				return response.end("{}");
			}
			if (!complete) {
				held = response;
				accepted();
				return;
			}
			response.end(
				JSON.stringify({
					MediaContainer: {
						size: 1,
						totalSize: 1,
						offset: 0,
						Metadata: [
							{
								ratingKey: "new-episode",
								title: "Synthetic episode",
								type: "episode",
								parentIndex: 1,
								index: 1,
								viewCount: 2,
							},
						],
					},
				}),
			);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw Error("missing loopback");
		let pending: Promise<unknown> | undefined;
		try {
			const { instance } = await seedParent(native, "PLEX", `http://127.0.0.1:${address.port}`);
			const context = {
				prisma: native.prisma,
				encryptor: native.encryptor,
				instance,
				log: app.log,
			};
			pending = native
				.run(() => refreshOwnedPlexEpisodeCache({ ...context, signal: controller.signal }))
				.catch((error) => error);
			expect(await bounded(ready, 4000)).not.toBe("expired");
			controller.abort(new Error("SECRET_SENTINEL"));
			const result = await bounded(pending);
			// Cleanup release makes old behavior finite; never counts as cancellation.
			if (result === "expired") {
				complete = true;
				held?.writeHead(503);
				held?.end("{}");
			}
			await pending;
			const unit = await native.run(() =>
				native.prisma.providerObservationUnit.findFirstOrThrow({
					where: { run: { instanceId: instance.id } },
				}),
			);
			expect
				.soft(result, "cancelled provider invocation joins without response release")
				.not.toBe("expired");
			expect.soft(result).toMatchObject({ code: "PUBLICATION_CANCELLED" });
			expect.soft(unit).toMatchObject({
				state: "pending",
				claimToken: null,
				attemptCount: 0,
				cursor: 0,
				completedPages: 0,
				nextAttemptAt: null,
			});
			complete = true;
			const retry = await native.run(() => refreshOwnedPlexEpisodeCache(context));
			expect(retry).toMatchObject({ complete: true, upserted: 1 });
			const status = await native.run(() =>
				native.prisma.cacheRefreshStatus.findUniqueOrThrow({
					where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex_episode" } },
				}),
			);
			// The unchanged bounded positive-only Plex publisher truthfully records
			// partial authority even after this work item completed and published.
			expect(status.lastAttemptResult).toBe("partial");
			expect(JSON.parse(status.generationMetadata!)).toMatchObject({
				publicationLevel: "positive-only",
			});
			expect(status.generationId).not.toBe("seeded-last-good");
		} finally {
			complete = true;
			if (held && !held.destroyed) held.end("{}");
			await pending;
			await app.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await native.close();
			rmSync(directory, { recursive: true });
		}
	});
	it.each(["headers", "body"] as const)(
		"cooperatively cancels a real finalizer identity %s read and joins its runtime",
		async (phase) => {
			const native = await createNotificationOutboxNativeFixture(),
				directory = ownedFixtureDirectory(native),
				controller = new AbortController();
			let held: ServerResponse | undefined,
				accepted!: () => void,
				closed = false;
			const ready = new Promise<void>((resolve) => {
				accepted = resolve;
			});
			const server = createServer((request, response) => {
				if (!request.url?.startsWith("/System/Info")) {
					response.writeHead(503);
					response.end("{}");
					return;
				}
				held = response;
				response.once("close", () => {
					closed = true;
				});
				if (phase === "body") {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.write('{"');
				}
				accepted();
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string") throw Error("missing loopback");
			let pending: Promise<unknown> | undefined;
			try {
				const { instance, now } = await seedParent(
					native,
					"JELLYFIN",
					`http://127.0.0.1:${address.port}`,
				);
				const payload = {
					databaseUrl: getRestoreRuntimeClientContext(native.runtime).databaseUrl,
					userId: instance.userId,
					instance: { ...instance, service: "JELLYFIN" as const, apiKey: "synthetic-token" },
					runId: "synthetic-no-publication",
					scopes: [],
					attempt: { attemptedAt: now, resultMarker: "synthetic-attempt" },
					now,
				};
				pending = native
					.run(() => runJellyfinEpisodeFinalizerWorker(payload, { signal: controller.signal }))
					.catch((error) => error);
				expect(await bounded(ready, 5000)).not.toBe("expired");
				controller.abort();
				const result = await bounded(pending);
				if (result === "expired") {
					if (phase === "headers")
						held?.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
					held?.end(phase === "body" ? 'unfinished":true}' : "{}");
				}
				await pending;
				for (let i = 0; i < 100 && !closed; i++) await delay(10);
				expect(result).toEqual({ status: "cancelled" });
				expect(closed).toBe(true);
				const status = await native.run(() =>
					native.prisma.cacheRefreshStatus.findUniqueOrThrow({
						where: {
							instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin_episode" },
						},
					}),
				);
				expect(status).toMatchObject({
					generationId: "seeded-last-good",
					lastResult: "success",
					lastAttemptResult: "success",
				});
			} finally {
				if (held && !held.destroyed) held.end("{}");
				await pending;
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await native.close();
				rmSync(directory, { recursive: true });
				expect(existsSync(directory)).toBe(false);
			}
		},
	);
});
