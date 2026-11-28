import { once } from "node:events";
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { describe, expect, it } from "vitest";
import { getRestoreRuntimeClientContext } from "../../lib/backup/restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import notifications from "../notification-service.js";
import registry from "../scheduler-registry.js";
import snapshots from "../session-snapshot-scheduler.js";

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

describe("session snapshot shutdown cancels real native HTTP reads", () => {
	for (const service of ["PLEX", "JELLYFIN", "EMBY"] as const) {
		for (const phase of ["headers", "body"] as const) {
			// Removing scheduler/factory cancellation leaves both close and the held
			// provider socket pending beyond 2500ms, without any responder release.
			it(`${service} cancels held ${phase} without persisting false idle/failure or reading the next instance`, async () => {
				const native = await createNotificationOutboxNativeFixture();
				const file = fileURLToPath(getRestoreRuntimeClientContext(native.runtime).databaseUrl);
				const directory = dirname(file);
				if (
					basename(file) !== "owned.db" ||
					dirname(directory) !== realpathSync(tmpdir()) ||
					!/^arr-outbox-worker-[A-Za-z0-9]+$/.test(basename(directory)) ||
					lstatSync(directory).isSymbolicLink() ||
					realpathSync(directory) !== directory
				)
					throw Error("Owned synthetic SQLite fixture required");
				const app = Fastify({ logger: false });
				const sockets = new Set<Socket>();
				const paths: string[] = [];
				let response: ServerResponse | undefined;
				let heldClosed = false;
				let heldSocketClosed = false;
				let clientClosed = false;
				let invalid = 0;
				let admitted!: () => void;
				let socketClosed!: () => void;
				const accepted = new Promise<void>((resolve) => {
					admitted = resolve;
				});
				const physicalClose = new Promise<void>((resolve) => {
					socketClosed = resolve;
				});
				const sessionPath = service === "PLEX" ? "/status/sessions" : "/Sessions";
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
					if (path === `/first${sessionPath}` && !response) {
						response = reply;
						request.socket.once("close", () => {
							heldSocketClosed = true;
							socketClosed();
						});
						reply.once("close", () => {
							heldClosed = true;
						});
						if (phase === "body") {
							reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
							reply.write(service === "PLEX" ? '{"MediaContainer":{"Metadata":[' : "[");
						}
						admitted();
					} else {
						invalid++;
						reply.writeHead(503, { Connection: "close" });
						reply.end("{}");
					}
				});
				server.on("connection", (socket) => {
					sockets.add(socket);
					socket.once("close", () => sockets.delete(socket));
				});
				const realTimeout = globalThis.setTimeout;
				let closing: Promise<void> | undefined;
				let client: ReturnType<typeof createRuntimePrismaClient> | undefined;
				try {
					server.listen(0, "127.0.0.1");
					await once(server, "listening");
					const address = server.address();
					if (!address || typeof address === "string") throw Error("Missing loopback address");
					await native.run(async () => {
						const key = native.encryptor.encrypt("synthetic-token");
						for (const id of ["first", "later"])
							await native.prisma.serviceInstance.create({
								data: {
									id,
									userId: native.userId,
									service,
									label: "Same synthetic label",
									baseUrl: `http://127.0.0.1:${address.port}/${id}`,
									enabled: true,
									encryptedApiKey: key.value,
									encryptionIv: key.iv,
									connectionGeneration: 7,
									identityGeneration: 3,
									identityStatus: "VERIFIED",
								},
							});
					});
					await native.restart(false);
					client = createRuntimePrismaClient(native.runtime);
					const ownedClient = client;
					app.decorate("restoreRuntime", native.runtime);
					app.decorate("prisma", ownedClient.prisma);
					app.decorate("encryptor", native.encryptor);
					app.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
					await app.register(
						fp(
							async (instance) => {
								instance.addHook("onClose", async () => {
									expect(app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot)?.state).toBe(
										"idle",
									);
									await ownedClient.close();
									clientClosed = true;
								});
							},
							{ name: "prisma" },
						),
					);
					await app.register(fp(async () => {}, { name: "security" }));
					registerRestoreBootstrapPlugin(app, notifications);
					registerRestoreBootstrapPlugin(app, registry);
					registerRestoreBootstrapPlugin(app, snapshots);
					registerRestoreRuntimeActivation(app);
					let startupSelected = 0;
					globalThis.setTimeout = ((
						callback: (...args: unknown[]) => void,
						ms?: number,
						...args: unknown[]
					) => {
						if (ms === 60_000 && startupSelected === 0) {
							startupSelected++;
							return realTimeout(callback, 1, ...args);
						}
						return realTimeout(callback, ms, ...args);
					}) as typeof setTimeout;
					await app.ready();
					globalThis.setTimeout = realTimeout;
					expect(await within(accepted, 4000), "actual provider GET admission").not.toBe("expired");
					expect(startupSelected).toBe(1);
					expect(invalid).toBe(0);
					const started = performance.now();
					closing = app.close();
					const result = await within(Promise.all([closing, physicalClose]), 2500);
					process.stdout.write(
						`${JSON.stringify({
							service,
							phase,
							elapsedMs: performance.now() - started,
							closeResolved: result !== "expired",
							heldClosed,
							heldSocketClosed,
						})}\n`,
					);
					expect
						.soft(result, "close and socket must settle without responder release")
						.not.toBe("expired");
					expect.soft(heldClosed, "held provider response physically closes").toBe(true);
					expect
						.soft(heldSocketClosed, "the socket carrying the held GET physically closes")
						.toBe(true);
					expect.soft(clientClosed, "accepted capture joins before database teardown").toBe(true);
				} finally {
					globalThis.setTimeout = realTimeout;
					try {
						if (response && !response.destroyed && !response.writableEnded) {
							if (phase === "headers") {
								response.writeHead(200, {
									"Content-Type": "application/json",
									Connection: "close",
								});
								response.end(service === "PLEX" ? '{"MediaContainer":{"Metadata":[]}}' : "[]");
							} else response.end(service === "PLEX" ? "]}}" : "]");
						}
						await (closing ?? app.close());
						const rows = await native.run(() => native.prisma.sessionSnapshot.findMany());
						const logs = await native.run(() => native.prisma.notificationLog.count());
						expect
							.soft(rows, "intentional cancellation produces neither idle nor failed telemetry")
							.toEqual([]);
						expect.soft(logs, "no notification sequence starts after abort").toBe(0);
						expect
							.soft(paths, "no later instance or retry admitted after abort")
							.toEqual([`/first${sessionPath}`]);
						expect
							.soft(app.schedulerRegistry.getStatus(JOB_ID.sessionSnapshot))
							.toMatchObject({ totalFailures: 0 });
					} finally {
						const socketJoins = [...sockets].map(
							(socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
						);
						for (const socket of sockets) socket.destroy();
						if (server.listening)
							await new Promise<void>((resolve, reject) =>
								server.close((error) => (error ? reject(error) : resolve())),
							);
						await Promise.all(socketJoins);
						if (response) await physicalClose;
						await client?.close();
						await native.close();
						rmSync(directory, { recursive: true });
						expect(sockets.size, "every synthetic socket is joined").toBe(0);
					}
				}
			}, 15_000);
		}
	}
});
