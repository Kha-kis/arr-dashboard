import { chmod, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { ArrClientFactory } from "../../../../lib/arr/client-factory.js";
import { Encryptor } from "../../../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../../../lib/backup/runtime-schema-startup.js";
import lifecyclePlugin from "../../../../plugins/lifecycle.js";
import cachePlugin from "../../../../plugins/seerr-cache.js";
import breakerPlugin from "../../../../plugins/seerr-circuit-breaker.js";
import { registerSeerrRoutes } from "../../index.js";

const createdAt = "2026-01-02T03:04:05.000Z";
const seerrUser = {
	id: 41,
	displayName: "Synthetic user",
	createdAt,
	updatedAt: createdAt,
	permissions: 2,
	requestCount: 0,
	userType: 1,
};
const media = {
	id: 41,
	tmdbId: 1041,
	mediaType: "tv",
	status: 2,
	createdAt,
	updatedAt: createdAt,
};
const requestResource = (id: number) => ({
	id,
	status: 1,
	type: "tv",
	media,
	createdAt,
	updatedAt: createdAt,
	requestedBy: seerrUser,
	is4k: false,
});
const issueResource = () => ({
	id: 41,
	issueType: 1,
	status: 1,
	problemSeason: 1,
	problemEpisode: 1,
	createdAt,
	updatedAt: createdAt,
	createdBy: seerrUser,
	comments: [],
	media,
});

interface ProviderEvent {
	instance: string;
	method: string;
	path: string;
}
interface FixtureLog {
	msg?: string;
	err?: { name?: string; message?: string };
	entry?: { targetId?: string };
}
interface ReplyFault {
	method: string;
	path: string;
	reject?: number;
	loseAcceptedReply?: boolean;
}

/** Real SQL/lifecycle/HTTP composition; only provider data and auth identity are synthetic. */
export async function createSeerrMutationFixture() {
	const directory = await mkdtemp(join(tmpdir(), "arr-seerr-mutation-"));
	await chmod(directory, 0o700);
	const file = join(directory, "fixture.db");
	new Database(file).close();
	await chmod(file, 0o600);
	await synchronizeRuntimeSchema(`file:${file}`);
	const runtime = await openRestoreRuntime({ databaseUrl: `file:${file}` });
	await runtime.bindDestination("synthetic-seerr-mutation");
	await runtime.activate();
	const native = createRuntimePrismaClient(runtime);
	const prisma = native.prisma;
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	const events: ProviderEvent[] = [];
	const accepted: ProviderEvent[] = [];
	const logs: FixtureLog[] = [];
	const requests = new Map<string, ReturnType<typeof requestResource>>();
	const issues = new Map<string, ReturnType<typeof issueResource>>();
	const notifications = new Map<string, boolean>();
	const notificationReadFailures = new Map<string, number | "malformed">();
	let fault: ReplyFault | undefined;
	const send = (reply: ServerResponse, status: number, body?: unknown) => {
		reply.writeHead(status, { "content-type": "application/json" });
		reply.end(body === undefined ? undefined : JSON.stringify(body));
	};
	async function handle(request: IncomingMessage, reply: ServerResponse) {
		const url = new URL(request.url ?? "/", "http://synthetic.invalid");
		const match = /^\/(seerr-[ab])\/(api\/v1\/.*)$/.exec(url.pathname);
		if (!match) return send(reply, 404, {});
		const instance = match[1]!;
		const path = `/${match[2]}`;
		let text = "";
		for await (const chunk of request) {
			text += String(chunk);
			if (text.length > 65536) throw new Error("Synthetic body limit exceeded");
		}
		const body = text ? JSON.parse(text) : undefined;
		const event = { instance, method: request.method!, path };
		events.push(event);
		if (request.headers["x-api-key"] !== "synthetic-seerr-key") return send(reply, 401, {});
		if (event.method === "GET" && path === "/api/v1/status") {
			reply.setHeader("set-cookie", ["_csrf=synthetic-secret", "XSRF-TOKEN=synthetic-token"]);
			return send(reply, 200, {
				version: "synthetic",
				commitTag: "test",
				updateAvailable: false,
				commitsBehind: 0,
			});
		}
		if (event.method !== "GET" && request.headers["x-xsrf-token"] !== "synthetic-token") {
			return send(reply, 403, {});
		}
		const selectedFault = fault?.method === event.method && fault.path === path ? fault : undefined;
		if (selectedFault?.reject) return send(reply, selectedFault.reject, {});
		if (event.method === "GET") {
			if (path.startsWith("/api/v1/settings/notifications/")) {
				const agent = path.split("/").at(-1)!;
				const failure =
					notificationReadFailures.get(`${instance}:${agent}`) ??
					notificationReadFailures.get(`${instance}:*`);
				if (typeof failure === "number")
					return send(reply, failure, { message: "Synthetic private provider detail" });
				if (failure === "malformed") return send(reply, 200, { enabled: "unknown", options: {} });
				return send(reply, 200, { enabled: notifications.get(instance), types: 0, options: {} });
			}
			if (path === "/api/v1/tv/1041") return send(reply, 200, { voteAverage: 8 });
			if (path === "/api/v1/issue") {
				const issue = issues.get(instance)!;
				const results =
					url.searchParams.get("filter") === "open" && issue.status !== 1 ? [] : [issue];
				return send(reply, 200, {
					pageInfo: { pages: 1, pageSize: 100, results: results.length, page: 1 },
					results,
				});
			}
			return send(reply, 404, {});
		}
		let result: unknown;
		let status = 200;
		const action = /^\/api\/v1\/request\/(\d+)(?:\/(approve|decline|retry))?$/.exec(path);
		if (action) {
			const key = `${instance}:${action[1]}`;
			const resource = requests.get(key);
			if (!resource) return send(reply, 404, {});
			if (event.method === "DELETE") {
				requests.delete(key);
				status = 204;
			} else if (event.method === "POST" && action[2]) {
				resource.status = action[2] === "approve" ? 2 : action[2] === "decline" ? 3 : 1;
				result = resource;
			} else return send(reply, 405, {});
		} else if (event.method === "POST" && path === "/api/v1/settings/notifications/discord") {
			notifications.set(instance, body.enabled);
			result = { enabled: body.enabled, types: 0, options: {} };
		} else if (event.method === "POST" && /^\/api\/v1\/issue\/41\/(open|resolved)$/.test(path)) {
			const issue = issues.get(instance)!;
			issue.status = path.endsWith("/resolved") ? 2 : 1;
			result = issue;
		} else return send(reply, 405, {});
		accepted.push(event);
		if (selectedFault?.loseAcceptedReply) return request.socket.destroy();
		send(reply, status, result);
	}
	const provider = createServer((request, reply) => {
		void handle(request, reply).catch(() => reply.destroy());
	});
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const address = provider.address();
	if (!address || typeof address === "string") throw new Error("Synthetic provider absent");
	const app = Fastify({
		logger: { level: "warn", stream: { write: (line: string) => logs.push(JSON.parse(line)) } },
	});
	const encryptor = new Encryptor("76".repeat(32));
	app.decorate("prisma", prisma);
	app.decorate("restoreRuntime", runtime);
	app.decorate("encryptor", encryptor);
	app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
	app.decorateRequest("currentUser", null);
	const owner = await run(() =>
		prisma.user.create({ data: { username: "synthetic-seerr-owner" } }),
	);
	// Authentication seam only: session/cookie validation is outside these native action regressions.
	app.addHook("preHandler", async (request) => {
		request.currentUser = owner;
	});
	await app.register(lifecyclePlugin);
	await app.register(cachePlugin);
	await app.register(breakerPlugin);
	await app.register(registerSeerrRoutes, { prefix: "/api/seerr" });
	await app.ready();
	for (const id of ["seerr-a", "seerr-b"]) {
		const encrypted = encryptor.encrypt("synthetic-seerr-key");
		await run(() =>
			prisma.serviceInstance.create({
				data: {
					id,
					userId: owner.id,
					service: "SEERR",
					label: "Synthetic same title",
					baseUrl: `http://127.0.0.1:${address.port}/${id}`,
					encryptedApiKey: encrypted.value,
					encryptionIv: encrypted.iv,
				},
			}),
		);
	}
	return {
		app,
		prisma,
		run,
		events,
		accepted,
		logs,
		requests,
		issues,
		notifications,
		fail(value: ReplyFault) {
			fault = value;
		},
		clearFailure() {
			fault = undefined;
		},
		failNotificationRead(agent: string, failure: number | "malformed", instance = "seerr-a") {
			notificationReadFailures.set(`${instance}:${agent}`, failure);
		},
		clearNotificationReadFailures() {
			notificationReadFailures.clear();
		},
		async reset() {
			fault = undefined;
			notificationReadFailures.clear();
			events.length = 0;
			accepted.length = 0;
			logs.length = 0;
			app.seerrCache.destroy();
			app.seerrCircuitBreaker.destroy();
			await run(async () => {
				await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "SyntheticSeerrAuditFailure"');
				await prisma.seerrActionLog.deleteMany({});
				await prisma.cacheRefreshStatus.deleteMany({});
				await prisma.serviceInstance.updateMany({
					data: { enabled: true, userId: owner.id, service: "SEERR" },
				});
			});
			for (const id of ["seerr-a", "seerr-b"]) {
				for (const requestId of [41, 42])
					requests.set(`${id}:${requestId}`, requestResource(requestId));
				issues.set(id, issueResource());
				notifications.set(id, false);
			}
		},
		audit() {
			return run(() => prisma.seerrActionLog.findMany({ orderBy: { targetId: "asc" } }));
		},
		async failFinalAudit() {
			await run(() =>
				prisma.$executeRawUnsafe(`
				CREATE TRIGGER "SyntheticSeerrAuditFailure" BEFORE INSERT ON "seerr_action_logs"
				WHEN NEW."targetId" = '42'
				BEGIN SELECT RAISE(FAIL, 'synthetic audit rejection'); END
			`),
			);
		},
		async close() {
			await app.close();
			provider.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				provider.close((error) => (error ? reject(error) : resolve())),
			);
			await native.close();
			await runtime.close();
			const database = new Database(file, { readonly: true, fileMustExist: true });
			const integrity = database.pragma("quick_check", { simple: true });
			database.close();
			await rm(directory, { recursive: true });
			return { integrity, removed: !existsSync(directory), providerClosed: !provider.listening };
		},
	};
}
