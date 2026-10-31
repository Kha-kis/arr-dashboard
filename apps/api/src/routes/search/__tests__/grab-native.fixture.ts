import { randomUUID } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyRequest } from "fastify";
import { ArrClientFactory } from "../../../lib/arr/client-factory.js";
import { createArrServiceFingerprint } from "../../../lib/arr/service-fingerprint.js";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import type { ServiceInstance, User } from "../../../lib/prisma.js";
import { issueSearchGrabSelector } from "../../../lib/search/grab-selector.js";
import lifecyclePlugin from "../../../plugins/lifecycle.js";
import { registerSearchRoutes } from "../../search.js";

/** Real native storage/lifecycle/plugin/SDK; only upstream replies are synthetic. */
export async function createNativeGrabFixture(options: { services?: boolean } = {}) {
	const engine = process.env.GRAB_ROUTES_TEST_ENGINE ?? "sqlite";
	if (engine !== "sqlite" && engine !== "postgresql")
		throw new Error("Owned Grab route engine required");
	let url: string;
	if (engine === "postgresql") {
		const supplied = process.env.GRAB_ROUTES_TEST_URL;
		if (!supplied) throw new Error("Owned PostgreSQL Grab route fixture required");
		const parsed = new URL(supplied);
		if (
			parsed.protocol !== "postgresql:" ||
			parsed.hostname !== "127.0.0.1" ||
			!parsed.port ||
			!/^arr_grab_[a-f0-9]{32}_test$/.test(parsed.username) ||
			parsed.pathname !== `/${parsed.username}` ||
			!parsed.password ||
			parsed.search ||
			parsed.hash
		)
			throw new Error("Owned loopback PostgreSQL fixture required");
		url = supplied;
	} else {
		const directory = await mkdtemp(join(tmpdir(), "arr-grab-routes-"));
		await chmod(directory, 0o700);
		const file = join(directory, "owned.db");
		new Database(file).close();
		await chmod(file, 0o600);
		url = `file:${file}`;
	}
	await synchronizeRuntimeSchema(url);
	const runtime = await openRestoreRuntime({ databaseUrl: url });
	try {
		// The owned PostgreSQL database is shared with the native service suite.
		await runtime.bindDestination("synthetic-grab-service");
		await runtime.activate();
	} catch (error) {
		await runtime.close();
		throw error;
	}
	const native = createRuntimePrismaClient(runtime),
		encryptor = new Encryptor("77".repeat(32));
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	let app: ReturnType<typeof Fastify>,
		user: User,
		instance: ServiceInstance,
		authenticated = true;
	let posts: unknown[] = [],
		markers: boolean[] = [],
		reads = 0;
	let reply = {
		status: 200,
		body: undefined as unknown,
		contentType: "application/json",
		lost: false,
	};
	let delay: { entered: () => void; resume: Promise<void> } | undefined;
	const guid = "synthetic:opaque/東京?exact=1",
		release = {
			guid,
			id: guid,
			title: "Synthetic result",
			indexer: "Synthetic",
			indexerId: 7,
			protocol: "torrent",
		};
	const provider = createServer((request, response) => {
		if (new URL(request.url ?? "/", "http://synthetic.invalid").pathname !== "/api/v1/search") {
			response.writeHead(404).end();
			return;
		}
		if (request.method === "GET") {
			reads++;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify([release]));
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		let body = "";
		request.on("data", (chunk) => {
			body += String(chunk);
		});
		request.on("end", () => {
			void (async () => {
				posts.push(JSON.parse(body));
				const attempt = await run(() =>
					native.prisma.searchGrabAttempt.findFirst({
						where: { userId: user.id, state: "submitting", dispatchedAt: { not: null } },
					}),
				);
				markers.push(
					Boolean(attempt) &&
						(await run(() =>
							native.prisma.searchGrabClaim.count({ where: { userId: user.id } }),
						)) === 1,
				);
				if (delay) {
					delay.entered();
					await delay.resume;
				}
				if (reply.lost) {
					request.socket.destroy();
					return;
				}
				response.writeHead(reply.status, { "content-type": reply.contentType });
				response.end(
					reply.status === 204
						? undefined
						: reply.contentType === "application/json"
							? JSON.stringify(reply.body)
							: String(reply.body),
				);
			})().catch(() => {
				response.writeHead(500).end();
			});
		});
	});
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const address = provider.address();
	if (!address || typeof address === "string") throw new Error("Owned loopback provider required");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const target = () => ({
		userId: user.id,
		serviceInstanceId: instance.id,
		connectionFingerprint: createArrServiceFingerprint(instance),
		guid,
		indexerId: 7,
	});
	return {
		engine,
		runtime,
		native,
		encryptor,
		run,
		guid,
		release,
		target,
		get app() {
			return app;
		},
		get user() {
			return user;
		},
		get instance() {
			return instance;
		},
		get posts() {
			return posts;
		},
		get markers() {
			return markers;
		},
		get reads() {
			return reads;
		},
		set authenticated(value: boolean) {
			authenticated = value;
		},
		set reply(value: typeof reply) {
			reply = value;
		},
		request: (intentId = randomUUID(), issuedAt = Date.now()) => ({
			instanceId: instance.id,
			intentId,
			selector: issueSearchGrabSelector(encryptor, target(), issuedAt),
		}),
		holdNextReply() {
			let entered!: () => void, release!: () => void;
			const arrived = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const resume = new Promise<void>((resolve) => {
				release = resolve;
			});
			delay = { entered, resume };
			return { arrived, release };
		},
		async reset() {
			delay = undefined;
			authenticated = true;
			posts = [];
			markers = [];
			reads = 0;
			reply = {
				status: 200,
				body: { guid, indexerId: 7 },
				contentType: "application/json",
				lost: false,
			};
			await run(async () => {
				user = await native.prisma.user.create({ data: { username: `synthetic-${randomUUID()}` } });
				const key = encryptor.encrypt("synthetic-provider-key");
				instance = await native.prisma.serviceInstance.create({
					data: {
						userId: user.id,
						service: "PROWLARR",
						label: "Synthetic",
						baseUrl,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				});
			});
			app = Fastify({ logger: false });
			app.decorate("prisma", native.prisma);
			app.decorate("restoreRuntime", runtime);
			app.decorate("encryptor", encryptor);
			app.decorate(
				"arrClientFactory",
				new ArrClientFactory(encryptor, options.services ? 5000 : 1000),
			);
			app.decorateRequest("currentUser", null);
			app.addHook("preHandler", async (request: FastifyRequest) => {
				request.currentUser = authenticated ? user : null;
			});
			await app.register(lifecyclePlugin);
			await app.register(registerSearchRoutes, { prefix: "/api" });
			if (options.services) {
				const { registerServiceRoutes } = await import("../../services.js");
				await app.register(registerServiceRoutes, { prefix: "/api" });
			}
			await app.ready();
		},
		async attempts() {
			return run(() => native.prisma.searchGrabAttempt.findMany({ where: { userId: user.id } }));
		},
		async holds() {
			return run(() => native.prisma.searchGrabClaim.count({ where: { userId: user.id } }));
		},
		async closeCase() {
			await app?.close();
		},
		async close() {
			await app?.close();
			provider.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				provider.close((error) => (error ? reject(error) : resolve())),
			);
			await native.close();
			await runtime.close();
		},
	};
}
