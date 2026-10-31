import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { createTestPrismaClient } from "../../../lib/__tests__/test-prisma.js";
import { admitNativeInventoryRun } from "../../../lib/provider-observation/native-inventory-job-repository.js";
import { createProviderPublicationAuthority } from "../../../lib/services/provider-identity-guard.js";
import { JOB_ID } from "../../../lib/scheduler-registry/job-definitions.js";
import scheduler from "../../native-inventory-scheduler.js";
import registry from "../../scheduler-registry.js";
import { installRuntimeFixture } from "../runtime-fixture.js";

const service = process.argv[2],
	phase = process.argv[3];
assert.ok(service === "PLEX" || service === "JELLYFIN" || service === "EMBY");
assert.ok(phase === "identity" || phase === "discovery" || phase === "page");
const directory = mkdtempSync(join(tmpdir(), "native-shutdown-actor-"));
const dbPath = join(directory, "test.db");
execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
	cwd: process.cwd(),
	env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
	stdio: "ignore",
});
const prisma = createTestPrismaClient(dbPath),
	sockets = new Set<Socket>();
let stalledClose: Promise<void> | undefined,
	ready = false;
const paths: string[] = [];
const server = createServer((request, response) => {
	const path = new URL(request.url!, "http://synthetic.invalid").pathname;
	paths.push(path);
	assert.equal(request.method, "GET");
	if (service !== "PLEX")
		assert.ok(request.headers.authorization?.includes('Token="synthetic-token"'));
	else assert.equal(request.headers["x-plex-token"], "synthetic-token");
	const current =
		path === "/identity" || path === "/System/Info"
			? "identity"
			: path === "/activities" || path === "/library/sections" || path === "/Library/MediaFolders"
				? "discovery"
				: "page";
	response.setHeader("Content-Type", "application/json");
	if (current === phase) {
		stalledClose = new Promise<void>((resolve) => request.socket.once("close", resolve));
		response.write('{"unfinished":');
		if (!ready) {
			ready = true;
			process.send?.({ ready: true });
		}
		return;
	}
	response.end(
		JSON.stringify(
			service === "PLEX"
				? {
						MediaContainer:
							path === "/identity"
								? { machineIdentifier: "synthetic-id", version: "1" }
								: path === "/activities"
									? { size: 0, Activity: [] }
									: {
											size: 1,
											Directory: [
												{
													key: "1",
													uuid: "uuid-1",
													title: "Synthetic",
													type: "show",
													refreshing: false,
													scannedAt: 10,
													updatedAt: 10,
												},
											],
										},
					}
				: path === "/System/Info"
					? { Id: "synthetic-id", ServerName: "Synthetic", Version: "1" }
					: {
							TotalRecordCount: 1,
							Items: [
								{ Id: "1", Name: "Synthetic", Type: "CollectionFolder", CollectionType: "tvshows" },
							],
						},
		),
	);
});
server.on("connection", (socket) => {
	sockets.add(socket);
	socket.once("close", () => sockets.delete(socket));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
await prisma.user.create({ data: { id: "owner", username: "synthetic" } });
const instance = await prisma.serviceInstance.create({
	data: {
		id: "instance",
		userId: "owner",
		service,
		label: "Synthetic",
		baseUrl: `http://127.0.0.1:${address.port}`,
		encryptedApiKey: "synthetic",
		encryptionIv: "synthetic",
		connectionGeneration: 1,
		identityGeneration: 1,
		expectedIdentity: "synthetic-id",
		identityStatus: "VERIFIED",
		identityKind:
			service === "PLEX"
				? "PLEX_MACHINE_IDENTIFIER"
				: service === "EMBY"
					? "EMBY_SERVER_ID"
					: "JELLYFIN_SERVER_ID",
		identityVerifiedAt: new Date(),
	},
});
await admitNativeInventoryRun(
	prisma,
	createProviderPublicationAuthority(instance),
	service === "PLEX" ? "paired" : "library",
	new Date(),
);
const app = Fastify({ logger: false });
await installRuntimeFixture(app);
await app.register(
	fp(
		async (fastify) => {
			fastify.decorate("prisma", prisma);
		},
		{ name: "prisma" },
	),
);
await app.register(
	fp(
		async (fastify) => {
			fastify.decorate("encryptor", { decrypt: () => "synthetic-token" } as never);
		},
		{ name: "security" },
	),
);
await app.register(registry);
await app.register(scheduler);
let startup: (() => void) | undefined;
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
	if (delay === 30_000) {
		startup = callback;
		return originalSetTimeout(() => {}, 30_000);
	}
	return originalSetTimeout(callback, delay, ...args);
}) as typeof setTimeout;
let stopping = false;
process.on("SIGTERM", () => {
	if (stopping) return;
	stopping = true;
	void (async () => {
		const startedAt = performance.now();
		assert.equal(app.schedulerRegistry.getStatus(JOB_ID.nativeInventory)?.state, "running");
		await app.close();
		await stalledClose;
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		assert.equal(run.state, "pending");
		assert.equal(run.claimToken, null);
		assert.equal(run.failureCount, 0);
		assert.equal(await prisma.providerNativeInventorySnapshot.count(), 0);
		assert.equal(await prisma.providerNativeInventoryPageReceipt.count(), 0);
		assert.equal(app.schedulerRegistry.getStatus(JOB_ID.nativeInventory)?.state, "idle");
		const before = paths.length;
		startup?.();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(paths.length, before);
		await prisma.$disconnect();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(directory, { recursive: true, force: true });
		process.stdout.write(
			`${JSON.stringify({ service, phase, joined: true, yielded: true, failureCount: 0, snapshots: 0, noNextTick: true, elapsedMs: Math.round(performance.now() - startedAt) })}\n`,
		);
		process.disconnect?.();
	})().catch(() => {
		process.exitCode = 1;
		process.disconnect?.();
	});
});
await app.ready();
globalThis.setTimeout = originalSetTimeout;
assert.ok(startup);
startup();
