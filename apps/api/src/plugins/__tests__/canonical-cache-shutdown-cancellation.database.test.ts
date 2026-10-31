import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { afterAll, describe, expect, it } from "vitest";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import jellyfin from "../jellyfin-cache-scheduler.js";
import plex from "../plex-cache-scheduler.js";
import notifications from "../notification-service.js";
import registry from "../scheduler-registry.js";

const observations: Record<string, unknown>[] = [];
afterAll(() => {
	if (process.env.CANONICAL_CANCELLATION_REPORT)
		writeFileSync(
			process.env.CANONICAL_CANCELLATION_REPORT,
			JSON.stringify(observations, null, 2) + "\n",
			{ mode: 0o600, flag: "wx" },
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

describe("canonical shutdown cancels actual provider reads and joins native work", () => {
	for (const service of ["JELLYFIN", "EMBY", "PLEX"] as const) {
		for (const phase of ["headers", "body", "prompt"] as const) {
			it(`${service}: ${phase}`, async () => {
				const native = await createNotificationOutboxNativeFixture();
				const sockets = new Set<Socket>(),
					paths: string[] = [];
				let response: ServerResponse | undefined,
					invalid = 0,
					accepted!: () => void;
				const readAccepted = new Promise<void>((resolve) => {
					accepted = resolve;
				});
				let heldClosed = false,
					teardown = false,
					afterTeardown = 0,
					released = false;
				const server = createServer((request, reply) => {
					if (teardown) afterTeardown++;
					paths.push(new URL(request.url!, "http://synthetic.invalid").pathname);
					if (
						request.method !== "GET" ||
						(service === "PLEX"
							? request.headers["x-plex-token"] !== "synthetic-token"
							: !request.headers.authorization?.includes('Token="synthetic-token"'))
					)
						invalid++;
					if (!response) {
						response = reply;
						reply.once("close", () => {
							heldClosed = true;
						});
						if (phase === "body") {
							reply.writeHead(200, { "Content-Type": "application/json" });
							reply.write('{"');
						}
						accepted();
					} else {
						reply.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
						reply.end("{}");
					}
				});
				server.on("connection", (socket) => {
					sockets.add(socket);
					socket.once("close", () => sockets.delete(socket));
				});
				server.listen(0, "127.0.0.1");
				await once(server, "listening");
				const address = server.address();
				if (!address || typeof address === "string") throw Error("missing loopback");
				const cacheType = service === "PLEX" ? "plex" : "jellyfin",
					seededAt = new Date("2026-10-10T12:00:00.000Z");
				const instance = await native.run(async () => {
					const encrypted = native.encryptor.encrypt("synthetic-token");
					const row = await native.prisma.serviceInstance.create({
						data: {
							userId: native.userId,
							service,
							label: "Synthetic",
							baseUrl: `http://127.0.0.1:${address.port}`,
							enabled: true,
							encryptedApiKey: encrypted.value,
							encryptionIv: encrypted.iv,
							connectionGeneration: 7,
							identityGeneration: 3,
							expectedIdentity: "synthetic-id",
							identityStatus: "VERIFIED",
						},
					});
					await native.prisma.cacheRefreshStatus.create({
						data: {
							instanceId: row.id,
							cacheType,
							lastRefreshedAt: seededAt,
							lastResult: "success",
							generationId: "seeded-last-good",
							lastAttemptAt: seededAt,
							lastAttemptResult: "success",
							connectionGeneration: 7,
							identityGeneration: 3,
						},
					});
					return row;
				});
				await native.restart(false);
				const client = createRuntimePrismaClient(native.runtime),
					app = Fastify({ logger: false });
				app.decorate("restoreRuntime", native.runtime);
				app.decorate("prisma", client.prisma);
				app.decorate("encryptor", native.encryptor);
				app.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
				let clientClosed = false;
				await app.register(
					fp(
						async (instance) => {
							instance.addHook("onClose", async () => {
								expect(
									app.schedulerRegistry.getStatus(
										service === "PLEX" ? JOB_ID.plexCache : JOB_ID.jellyfinCache,
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
				let selected = 0;
				globalThis.setTimeout = ((
					callback: (...args: unknown[]) => void,
					ms?: number,
					...args: unknown[]
				) => {
					if (ms === (service === "PLEX" ? 30_000 : 45_000) && selected === 0) {
						selected++;
						return realTimeout(callback, 1, ...args);
					}
					return realTimeout(callback, ms, ...args);
				}) as typeof setTimeout;
				const release = () => {
					if (!response || response.destroyed || response.writableEnded) return;
					released = true;
					if (phase === "body") {
						response.end('unfinished":true}');
						return;
					}
					response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
					response.end(
						JSON.stringify(
							service === "PLEX"
								? { MediaContainer: { machineIdentifier: "synthetic-id", version: "1" } }
								: { Id: "synthetic-id", ServerName: "Synthetic", Version: "1" },
						),
					);
				};
				let closing: Promise<void> | undefined;
				try {
					await app.ready();
					globalThis.setTimeout = realTimeout;
					expect(await within(readAccepted, 4000), "actual provider admission").not.toBe("expired");
					expect(selected).toBe(1);
					expect(invalid).toBe(0);
					expect(paths[0]).toBe(service === "PLEX" ? "/identity" : "/System/Info");
					if (phase === "prompt") release();
					const started = performance.now();
					closing = app.close();
					const result = await within(closing, 2500),
						elapsedMs = performance.now() - started;
					observations.push({
						service,
						phase,
						elapsedMs,
						closeResolved: result !== "expired",
						released,
						heldClosed,
						clientClosed,
						paths: [...paths],
					});
					expect(result, "close must join without releasing the held responder").not.toBe(
						"expired",
					);
					expect(clientClosed).toBe(true);
					if (phase !== "prompt") {
						expect(released).toBe(false);
						for (let i = 0; i < 100 && !heldClosed; i++) await delay(10);
						expect(heldClosed, "actual held socket closes on shutdown").toBe(true);
						expect(paths).toHaveLength(1);
					}
					const status = await native.run(() =>
						native.prisma.cacheRefreshStatus.findUniqueOrThrow({
							where: { instanceId_cacheType: { instanceId: instance.id, cacheType } },
						}),
					);
					expect(status).toMatchObject({
						lastResult: "success",
						generationId: "seeded-last-good",
						lastAttemptResult: "error",
					});
					expect(status.lastRefreshedAt).toEqual(seededAt);
					if (phase !== "prompt")
						expect(status.lastAttemptErrorMessage).toBe(
							service === "PLEX" ? "Provider cache publication cancelled." : "unknown-failure",
						);
					expect(invalid).toBe(0);
					expect(
						await native.run(() =>
							native.prisma.serviceInstance.findUniqueOrThrow({ where: { id: instance.id } }),
						),
					).toMatchObject({ identityStatus: "VERIFIED" });
					const requests = paths.length;
					await new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					);
					await delay(50);
					expect(sockets.size).toBe(0);
					await native.close();
					teardown = true;
					await delay(50);
					expect(paths).toHaveLength(requests);
					expect(afterTeardown).toBe(0);
					Object.assign(observations.at(-1)!, {
						nativeClosed: true,
						providerClosed: !server.listening,
						socketsAtEnd: sockets.size,
						heldClosedAtEnd: heldClosed,
						requestsAfterTeardown: paths.length - requests,
						attempt: status.lastAttemptResult,
						attemptReason: status.lastAttemptErrorMessage,
						lastGoodRetained: true,
					});
				} finally {
					globalThis.setTimeout = realTimeout;
					release();
					await (closing ?? app.close());
					if (server.listening) {
						for (const socket of sockets) socket.destroy();
						await new Promise<void>((resolve) => server.close(() => resolve()));
					}
					await native.close();
				}
			}, 20_000);
		}
	}
});
