import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import lifecyclePlugin from "../../../plugins/lifecycle.js";
import {
	createInjectAuthenticated,
	setupAuthInjection,
} from "../../../routes/__tests__/test-helpers.js";
import { registerInsightsRoutes } from "../../../routes/library/insights-routes.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	recordScopedWriteEvidence,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { PlexAuthorityService } from "../../plex/plex-authority-service.js";
import { SeerrClient } from "../../seerr/seerr-client.js";
import { withIsolatedRuntimePrismaBulkReadClient } from "../restore-runtime-client.js";

afterEach(closeScopedWriteFixtures);

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, timeout: number, label: string) {
	const controller = new AbortController();
	try {
		return await Promise.race([
			promise,
			delay(timeout, undefined, { signal: controller.signal }).then(() => {
				throw new Error(label);
			}),
		]);
	} finally {
		controller.abort();
	}
}

describe("Insights route phase admission", { timeout: 20_000 }, () => {
	it.each(["disk-waste", "watched-monitored", "requested-unwatched"] as const)(
		"releases both bulk lanes between native reads and %s evidence projection",
		async (route) => {
			const f = await createScopedWriteFixture();
			await f.plain.serviceInstance.update({
				where: { id: "synthetic-jellyfin" },
				data: { enabled: false },
			});
			await f.plain.serviceInstance.createMany({
				data: [
					{ id: "synthetic-arr", service: "RADARR" as const },
					{ id: "synthetic-seerr", service: "SEERR" as const },
				].map((instance) => ({
					...instance,
					userId: "synthetic-user",
					label: "Synthetic",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				})),
			});
			await f.plain.libraryCache.create({
				data: {
					id: "synthetic-insight",
					instanceId: "synthetic-arr",
					arrItemId: 42,
					itemType: "movie",
					title: "Synthetic",
					hasFile: true,
					monitored: true,
					sizeOnDisk: 2147483648n,
					arrAddedAt: new Date("2026-01-01T00:00:00.000Z"),
					data: '{"remoteIds":{"tmdbId":42}}',
				},
			});
			const entered = signal(),
				release = signal();
			let paused = 0;
			vi.spyOn(PlexAuthorityService.prototype, "readUserSelectedDisplay").mockImplementation(
				async (input) => {
					expect(input.userId).toBe("synthetic-user");
					expect(input.selection).toEqual({
						kind: "targets",
						targets: [{ mediaType: "movie", tmdbId: 42 }],
					});
					if (++paused === 2) entered.resolve();
					await release.promise;
					// The real owned candidate reads precede this bounded evidence barrier.
					// Positive-only watch evidence cannot establish unwatched/zero plays.
					return [
						{
							available: true,
							instanceId: "synthetic-plex",
							rows:
								route === "watched-monitored"
									? [
											{
												tmdbId: 42,
												mediaType: "movie",
												watchCount: 3,
												lastWatchedAt: null,
												watchedByUsers: "[]",
											},
										]
									: [],
							providerStatus: {
								availability: "current",
								evidence: "positive-only",
								observedAt: "2026-11-09T00:00:00.000Z",
								ageSeconds: 0,
								latestAttempt: "successful",
								reasonCodes: ["positive-only"],
								domains: [
									{
										domain: "watch-count",
										availability: "current",
										evidence: "positive-only",
										valueSemantics: "lower-bound",
										reasonCodes: ["positive-only"],
									},
								],
							},
							evidence: {
								availability: "current",
								authority: "unavailable",
								attemptState: "idle",
								publicationLevel: "positive-only",
								completeness: "partial",
								reasonCodes: [],
							},
						},
					] as unknown as Awaited<ReturnType<PlexAuthorityService["readUserSelectedDisplay"]>>;
				},
			);
			vi.spyOn(SeerrClient.prototype, "getRequests").mockResolvedValue({
				results: [
					{
						media: { tmdbId: 42 },
						type: "movie",
						requestedBy: { displayName: "Synthetic" },
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
			} as Awaited<ReturnType<SeerrClient["getRequests"]>>);
			const native = new Set<Database.Database>();
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql,
			) {
				if (this.name === f.path && this !== f.writer) native.add(this);
				return prepare.call(this, sql);
			});
			const app = Fastify({ logger: false });
			app.decorate("restoreRuntime", f.runtime);
			app.decorate("prisma", f.client.prisma);
			setupAuthInjection(app, { id: "synthetic-user", username: "Synthetic" });
			await app.register(lifecyclePlugin);
			await app.register(registerInsightsRoutes, { prefix: "/api" });
			await app.ready();
			const inject = createInjectAuthenticated(app);
			const requests = [0, 1].map(() => inject("GET", `/api/library/insights/${route}`));
			let probe: Promise<number> | undefined;
			try {
				await bounded(entered.promise, 5000, "routes did not reach native-read/evidence barriers");
				expect(paused).toBe(2);
				expect(native.size).toBeGreaterThanOrEqual(2);
				expect([...native].every((db) => !db.inTransaction)).toBe(true);
				probe = f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaBulkReadClient(
						f.client.prisma,
						(reader) => reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
						{ lease: "phase" },
					),
				);
				expect(await bounded(probe, 1000, "Insights callbacks retained both bulk slots")).toBe(4);
				release.resolve();
				for (const response of await Promise.all(requests)) {
					expect(response.statusCode).toBe(200);
					const data = response.json().data;
					if (route === "watched-monitored")
						expect(data).toMatchObject({
							items: [{ arrItemId: 42, watchCount: 3, watchCountSemantics: "lower-bound" }],
							hasWatchData: true,
						});
					else {
						expect(data).toMatchObject({
							items: [],
							unknownItems: [{ arrItemId: 42, watchState: "unknown" }],
							watchStatus: "partial",
						});
						if (route === "disk-waste") expect(data.totalWastedBytes).toBeNull();
						else expect(data).toMatchObject({ hasSeerrData: true, requestStatus: "complete" });
					}
				}
				recordScopedWriteEvidence(`insights-phase-${route}`, {
					pausedRoutes: 2,
					nativeTransactionsAtBarrier: 0,
					nativeBulkProgressBeforeRelease: true,
					providerIo: 0,
				});
			} finally {
				release.resolve();
				await Promise.allSettled([...requests, ...(probe ? [probe] : [])]);
				await app.close();
				await f.client.close();
				expect([...native].every((db) => !db.open)).toBe(true);
				recordScopedWriteEvidence(`insights-phase-${route}-closure`, {
					nativeHandles: native.size,
					nativeHandlesClosedBeforeRemoval: [...native].every((db) => !db.open),
					requestsJoined: true,
					probeJoined: true,
					appClosed: true,
					losses: f.losses,
				});
			}
			expect(f.losses).toEqual([]);
		},
	);
});
