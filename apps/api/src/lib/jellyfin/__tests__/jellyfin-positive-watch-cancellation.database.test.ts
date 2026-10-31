import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import type { Prisma } from "../../prisma.js";
import { refreshOwnedJellyfinPositiveWatch } from "../jellyfin-positive-watch-refresher.js";

const log = pino({ enabled: false });
type Phase = "users" | "page" | "second-identity";
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function until(observe: () => boolean, milliseconds = 4000) {
	const deadline = performance.now() + milliseconds;
	while (!observe() && performance.now() < deadline) await delay(10);
	return observe();
}
async function setup(controller: AbortController, hold?: Phase) {
	const native = await createNotificationOutboxNativeFixture();
	const counts = { identity: 0, users: 0, views: 0, pages: 0, unexpected: 0 };
	let held: ServerResponse | undefined;
	let reached = false;
	const server = createServer((request, reply) => {
		const path = new URL(request.url!, "http://fixture.invalid").pathname;
		if (request.method !== "GET") {
			counts.unexpected++;
			reply.writeHead(405).end();
			return;
		}
		const send = (body: unknown) => {
			reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
			reply.end(JSON.stringify(body));
		};
		if (path === "/System/Info") {
			counts.identity++;
			if (hold === "second-identity" && counts.identity === 2) {
				reached = true;
				controller.abort(new Error("private synthetic shutdown reason"));
			}
			send({ Id: "synthetic-server", ServerName: "Synthetic", Version: "1" });
		} else if (path === "/Users") {
			counts.users++;
			if (hold === "users") {
				held = reply;
				reached = true;
				reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
				reply.write("[");
			} else send([{ Id: "synthetic-user", Name: "Synthetic" }]);
		} else if (path === "/Users/synthetic-user/Views") {
			counts.views++;
			send({
				Items: [
					{
						Id: "synthetic-library",
						Name: "Synthetic",
						Type: "CollectionFolder",
						CollectionType: "tvshows",
					},
				],
				TotalRecordCount: 1,
			});
		} else if (path === "/Users/synthetic-user/Items") {
			counts.pages++;
			if (hold === "page") {
				held = reply;
				reached = true;
				reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
				reply.write('{"Items":[');
			} else
				send({
					Items: [
						{
							Id: "synthetic-episode",
							Type: "Episode",
							Name: "Synthetic",
							SeriesId: "synthetic-series",
							ParentIndexNumber: 1,
							IndexNumber: 1,
							UserData: { Played: true, PlayCount: 1 },
						},
					],
					StartIndex: 0,
					TotalRecordCount: 1,
				});
		} else {
			counts.unexpected++;
			reply.writeHead(404).end();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Owned loopback required");
	const instance = await native.run(async () => {
		const key = native.encryptor.encrypt("synthetic-key");
		const row = await native.prisma.serviceInstance.create({
			data: {
				userId: native.userId,
				service: "JELLYFIN",
				label: "Synthetic",
				baseUrl: `http://127.0.0.1:${address.port}`,
				encryptedApiKey: key.value,
				encryptionIv: key.iv,
				expectedIdentity: "synthetic-server",
				identityStatus: "VERIFIED",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await native.prisma.cacheRefreshStatus.create({
			data: {
				instanceId: row.id,
				cacheType: "jellyfin_episode_positive",
				lastResult: "success",
				lastRefreshedAt: new Date("2026-10-01T00:00:00Z"),
				lastAttemptResult: "success",
				lastAttemptAt: new Date("2026-10-01T00:00:00Z"),
				generationId: "last-known",
				itemCount: 1,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await native.prisma.jellyfinPositiveWatchRow.create({
			data: {
				instanceId: row.id,
				generationId: "last-known",
				userKeyDigest: "a".repeat(64),
				libraryId: "synthetic-library",
				jellyfinId: "last-known-episode",
				seriesId: "synthetic-series",
				seasonNumber: 1,
				episodeNumber: 2,
				playCount: 1,
				observedAt: new Date("2026-10-01T00:00:00Z"),
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		return row;
	});
	const releaseRead = () => {
		if (held && !held.destroyed)
			held.end(hold === "users" ? "]" : '],"StartIndex":0,"TotalRecordCount":0}');
	};
	return {
		native,
		instance,
		counts,
		reached: () => reached,
		releaseRead,
		input: () => ({
			prisma: native.prisma,
			encryptor: native.encryptor,
			instance,
			log,
			signal: controller.signal,
		}),
		state: () =>
			native.run(async () => ({
				status: await native.prisma.cacheRefreshStatus.findUniqueOrThrow({
					where: {
						instanceId_cacheType: {
							instanceId: instance.id,
							cacheType: "jellyfin_episode_positive",
						},
					},
				}),
				rows: await native.prisma.jellyfinPositiveWatchRow.findMany({
					where: { instanceId: instance.id },
				}),
			})),
		async close() {
			releaseRead();
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
			await native.close();
		},
	};
}

describe("positive-watch shutdown with real owned reads and native publication", {
	timeout: 15_000,
}, () => {
	for (const phase of ["users", "page", "second-identity"] as const) {
		it(`cancels ${phase} without publishing or erasing the last-known generation`, async () => {
			const controller = new AbortController(),
				f = await setup(controller, phase);
			let settled = false;
			const running = f.native.run(() => refreshOwnedJellyfinPositiveWatch(f.input()));
			void running.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				expect(await until(() => f.reached() || settled)).toBe(true);
				expect(f.reached()).toBe(true);
				controller.abort();
				expect(await until(() => settled, 1500)).toBe(true);
				expect(await running).toEqual({ kind: "skipped", reason: "cancelled" });
				const state = await f.state();
				expect(state.status).toMatchObject({
					generationId: "last-known",
					lastResult: "success",
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "refresh-cancelled",
				});
				expect(state.rows.map((row) => row.jellyfinId)).toEqual(["last-known-episode"]);
				expect(f.counts).toEqual({
					identity: phase === "second-identity" ? 2 : 1,
					users: 1,
					views: phase === "users" ? 0 : 1,
					pages: phase === "users" ? 0 : phase === "page" ? 1 : 2,
					unexpected: 0,
				});
			} finally {
				controller.abort();
				f.releaseRead();
				await running.catch(() => {});
				await f.close();
			}
		});
	}
	for (const outcome of ["commit", "rollback"] as const) {
		it(`joins an entered publication's actual ${outcome} after shutdown`, async () => {
			const controller = new AbortController(),
				f = await setup(controller);
			const release = deferred();
			let publishing = false,
				settled = false;
			const prisma = new Proxy(f.native.prisma, {
				get(target, property, receiver) {
					const value = Reflect.get(target, property, receiver);
					if (property !== "$transaction") return value;
					return (
						callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
						options?: unknown,
					) =>
						Reflect.apply(value, target, [
							(tx: Prisma.TransactionClient) =>
								callback(
									new Proxy(tx, {
										get(transaction, key, txReceiver) {
											const delegate = Reflect.get(transaction, key, txReceiver);
											if (key !== "jellyfinPositiveWatchRow") return delegate;
											return new Proxy(delegate, {
												get(rows, method) {
													const operation = Reflect.get(rows, method);
													if (method !== "deleteMany") return operation;
													return async (...args: unknown[]) => {
														publishing = true;
														await release.promise;
														if (outcome === "rollback")
															throw new Error("Synthetic entered-publication failure");
														return await Reflect.apply(operation, rows, args);
													};
												},
											});
										},
									}),
								),
							options,
						]);
				},
			});
			const running = f.native.run(() =>
				refreshOwnedJellyfinPositiveWatch({ ...f.input(), prisma }),
			);
			void running.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				expect(await until(() => publishing || settled)).toBe(true);
				expect(publishing).toBe(true);
				controller.abort();
				await new Promise<void>((done) => setImmediate(done));
				expect(settled).toBe(false);
				release.resolve();
				const result = await running,
					state = await f.state();
				if (outcome === "commit") {
					expect(result).toMatchObject({ kind: "published", itemCount: 1, scopeCount: 1 });
					expect(state.status.generationId).not.toBe("last-known");
					expect(state.status.lastAttemptResult).toBe("success");
					expect(state.rows.map((row) => row.jellyfinId)).toEqual(["synthetic-episode"]);
				} else {
					expect(result).toEqual({ kind: "failed", reason: "coverage-incomplete" });
					expect(state.status.generationId).toBe("last-known");
					expect(state.status.lastAttemptErrorMessage).toBe("coverage-incomplete");
					expect(state.rows.map((row) => row.jellyfinId)).toEqual(["last-known-episode"]);
				}
				expect(f.counts.unexpected).toBe(0);
			} finally {
				release.resolve();
				controller.abort();
				await running.catch(() => {});
				await f.close();
			}
		});
	}
});
