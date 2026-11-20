import { randomUUID } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	ArrClientFactory,
	type ClientFactoryOptions,
	type ClientInstanceData,
} from "../../arr/client-factory.js";
import { createArrServiceFingerprint } from "../../arr/service-fingerprint.js";
import { Encryptor } from "../../auth/encryption.js";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
} from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import type { ServiceInstance } from "../../prisma.js";
import { issueSearchGrabSelector } from "../grab-selector.js";

const engine = process.env.GRAB_SERVICE_TEST_ENGINE ?? "sqlite";
if (engine !== "sqlite" && engine !== "postgresql")
	throw new Error("Owned Grab service engine required");

// Keep the real SDK/HTTP path; insert only a controlled actor at its awaited hook.
class HookedFactory extends ArrClientFactory {
	constructor(
		encryptor: Encryptor,
		private readonly beforeHook: () => Promise<void>,
	) {
		super(encryptor, 1000);
	}
	override createProwlarrClient(instance: ClientInstanceData, options?: ClientFactoryOptions) {
		return super.createProwlarrClient(instance, {
			...options,
			onRequest: async (request) => {
				await this.beforeHook();
				await options?.onRequest?.(request);
			},
		});
	}
}

describe(`durable manual Grab service on actual native ${engine} and SDK HTTP`, () => {
	let runtime: RestoreRuntime;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	let provider: Server;
	let baseUrl: string;
	let userId: string;
	let instance: ServiceInstance;
	let url: string;
	let clock: number;
	let posts: Array<unknown>;
	let markerObservations: boolean[];
	let replyMode: "ack" | "mismatch" | "reject" | "unavailable" | "lost";
	let delay: { entered: () => void; resume: Promise<void> } | undefined;
	const encryptor = new Encryptor("66".repeat(32));
	const guid = "opaque:provider/東京😀?exact=1";
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	const target = () => ({
		userId,
		serviceInstanceId: instance.id,
		connectionFingerprint: createArrServiceFingerprint(instance),
		guid,
		indexerId: 7,
	});
	const input = (intentId = randomUUID(), extra: Record<string, unknown> = {}) => ({
		instanceId: instance.id,
		intentId,
		selector: issueSearchGrabSelector(encryptor, target(), clock),
		...extra,
	});
	async function service(owner = userId, factory = new ArrClientFactory(encryptor, 1000)) {
		const { createSearchGrabService } = await import("../grab-service.js");
		return createSearchGrabService({
			prisma: native.prisma,
			runtime,
			encryptor,
			arrClientFactory: factory,
			userId: owner,
			now: () => clock,
		});
	}
	const attempts = () => run(() => native.prisma.searchGrabAttempt.findMany({ where: { userId } }));
	const holds = () => run(() => native.prisma.searchGrabClaim.count({ where: { userId } }));
	beforeAll(async () => {
		if (engine === "postgresql") {
			const supplied = process.env.GRAB_SERVICE_TEST_URL;
			if (!supplied) throw new Error("Owned PostgreSQL Grab service fixture required");
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
			const directory = await mkdtemp(join(tmpdir(), "arr-grab-service-"));
			await chmod(directory, 0o700);
			const path = join(directory, "owned.db");
			new Database(path).close();
			await chmod(path, 0o600);
			url = `file:${path}`;
		}
		await synchronizeRuntimeSchema(url);
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination("synthetic-grab-service");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		provider = createServer((request, response) => {
			if (request.method !== "POST" || request.url !== "/api/v1/search") {
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
					const rows = await attempts();
					const marked = rows.find(
						(row) => row.state === "submitting" && row.dispatchedAt !== null,
					);
					markerObservations.push(Boolean(marked) && (await holds()) === 1);
					if (delay) {
						delay.entered();
						await delay.resume;
					}
					if (replyMode === "lost") {
						request.socket.destroy();
						return;
					}
					const status = replyMode === "reject" ? 409 : replyMode === "unavailable" ? 503 : 200;
					response.writeHead(status, { "content-type": "application/json" });
					response.end(
						JSON.stringify(
							replyMode === "ack"
								? { guid, indexerId: 7 }
								: replyMode === "mismatch"
									? { guid: "other-release", indexerId: 7 }
									: { message: "Synthetic provider failure" },
						),
					);
				})().catch(() => {
					response.writeHead(500).end();
				});
			});
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		if (!address || typeof address === "string")
			throw new Error("Owned loopback provider required");
		baseUrl = `http://127.0.0.1:${address.port}`;
	}, 30000);
	beforeEach(async () => {
		clock = 1_790_000_000_000;
		posts = [];
		markerObservations = [];
		replyMode = "ack";
		delay = undefined;
		userId = randomUUID();
		await run(async () => {
			await native.prisma.user.create({ data: { id: userId, username: `synthetic-${userId}` } });
			const key = encryptor.encrypt("synthetic-provider-key");
			instance = await native.prisma.serviceInstance.create({
				data: {
					userId,
					service: "PROWLARR",
					label: "Synthetic",
					baseUrl,
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
		});
	});
	afterAll(async () => {
		provider?.closeAllConnections();
		if (provider)
			await new Promise<void>((resolve, reject) =>
				provider.close((error) => (error ? reject(error) : resolve())),
			);
		await native?.close();
		await runtime?.close();
	});
	it("commits the marker and claim before one actual SDK POST, then persists exact ACK", async () => {
		const svc = await service(),
			request = input();
		const status = await run(() => svc.submit(request));
		expect(status.state).toBe("acknowledged");
		expect(status.intentId).toBe(request.intentId);
		expect(posts).toEqual([{ guid, indexerId: 7 }]);
		expect(markerObservations).toEqual([true]);
		expect((await attempts())[0]?.state).toBe("acknowledged");
		expect(await holds()).toBe(0);
		expect(JSON.stringify(status)).not.toContain(guid);
		expect(JSON.stringify(status)).not.toContain(instance.id);
		expect(JSON.stringify(status)).not.toContain("connectionFingerprint");
	});
	it("uses the SDK's canonical URL without rejecting an equivalent stored URL spelling", async () => {
		instance = await run(() =>
			native.prisma.serviceInstance.update({
				where: { id: instance.id, userId },
				data: { baseUrl: `${baseUrl.replace(/^http:/, "HTTP:")}/` },
			}),
		);
		const svc = await service();
		expect((await run(() => svc.submit(input()))).state).toBe("acknowledged");
		expect(posts).toEqual([{ guid, indexerId: 7 }]);
		expect(markerObservations).toEqual([true]);
	});
	it("refuses invalid stored credentials without exposing a private instance label or making a record", async () => {
		instance = await run(() =>
			native.prisma.serviceInstance.update({
				where: { id: instance.id, userId },
				data: { label: "synthetic-private-label", encryptedApiKey: "invalid-ciphertext" },
			}),
		);
		const svc = await service();
		const result = await run(() => svc.submit(input())).then(
			(value) => ({ value, error: undefined }),
			(error: Error) => ({ value: undefined, error }),
		);
		expect(result.value).toBeUndefined();
		expect(result.error?.message).not.toContain("synthetic-private-label");
		expect(result.error?.message).not.toContain("invalid-ciphertext");
		expect(posts).toEqual([]);
		expect(await attempts()).toEqual([]);
		expect(await holds()).toBe(0);
	});
	it("observes the original intent after selector expiry and connection disable without a new send", async () => {
		const svc = await service(),
			request = input();
		const first = await run(() => svc.submit(request));
		clock += 86_400_000;
		await run(() =>
			native.prisma.serviceInstance.updateMany({
				where: { userId, id: instance.id },
				data: { enabled: false },
			}),
		);
		const replay = await run(() => svc.submit(request));
		expect(replay.attemptId).toBe(first.attemptId);
		expect(replay.state).toBe("acknowledged");
		expect(posts).toHaveLength(1);
		expect(await attempts()).toHaveLength(1);
	});
	it("refuses an expired selector for a new intent without records or provider POST", async () => {
		const svc = await service(),
			request = input();
		clock += 1_800_000;
		await expect(run(() => svc.submit(request))).rejects.toThrow();
		expect(posts).toEqual([]);
		expect(await attempts()).toEqual([]);
		expect(await holds()).toBe(0);
	});
	it.each(["forged", "foreign", "disabled", "changed", "other-service"])(
		"refuses %s new authority before any provider POST",
		async (kind) => {
			const svc = await service(kind === "foreign" ? randomUUID() : userId),
				request = input();
			if (kind === "forged") request.selector = "sg1.invalid.forged";
			if (["disabled", "changed", "other-service"].includes(kind))
				await run(() =>
					native.prisma.serviceInstance.updateMany({
						where: { userId, id: instance.id },
						data:
							kind === "disabled"
								? { enabled: false }
								: kind === "changed"
									? { baseUrl: `${baseUrl}/changed` }
									: { service: "RADARR" },
					}),
				);
			await expect(run(() => svc.submit(request))).rejects.toThrow();
			expect(posts).toEqual([]);
			expect(await attempts()).toEqual([]);
			expect(await holds()).toBe(0);
		},
	);
	it.each(["target", "instance", "confirmation"])(
		"rejects a changed %s on replay with no extra send",
		async (kind) => {
			const svc = await service(),
				request = input();
			await run(() => svc.submit(request));
			const replay = {
				...request,
				...(kind === "target"
					? {
							selector: issueSearchGrabSelector(
								encryptor,
								{ ...target(), guid: "other-release" },
								clock,
							),
						}
					: {}),
				...(kind === "instance" ? { instanceId: "other-instance" } : {}),
				...(kind === "confirmation"
					? { retry: { predecessorId: randomUUID(), duplicateRiskConfirmed: true as const } }
					: {}),
			};
			await expect(run(() => svc.submit(replay))).rejects.toMatchObject({ statusCode: 409 });
			expect(posts).toHaveLength(1);
			expect(await attempts()).toHaveLength(1);
		},
	);
	it.each(["mismatch", "unavailable", "lost"] as const)(
		"keeps %s outcome uncertain and held with no automatic replay",
		async (mode) => {
			replyMode = mode;
			const svc = await service(),
				request = input();
			const outcome = await run(() => svc.submit(request));
			expect(outcome.state).toBe("uncertain");
			expect(await holds()).toBe(1);
			expect((await run(() => svc.submit(request))).state).toBe("uncertain");
			expect(posts).toHaveLength(1);
			expect(markerObservations).toEqual([true]);
		},
	);
	it("records positive provider rejection separately and releases only its own hold", async () => {
		replyMode = "reject";
		const svc = await service();
		const outcome = await run(() => svc.submit(input()));
		expect(outcome.state).toBe("rejected");
		expect(outcome.outcomeCategory).toBe("provider-rejected");
		expect(await holds()).toBe(0);
		expect(posts).toHaveLength(1);
	});
	it("never reports success when provider ACK cannot be durably persisted", async () => {
		await run(async () => {
			if (engine === "postgresql") {
				await native.prisma.$executeRawUnsafe(
					`CREATE FUNCTION synthetic_grab_ack_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."state" = 'acknowledged' THEN RAISE EXCEPTION 'synthetic ACK persistence fault'; END IF; RETURN NEW; END $$`,
				);
				await native.prisma.$executeRawUnsafe(
					`CREATE TRIGGER synthetic_grab_ack_fault BEFORE UPDATE ON "SearchGrabAttempt" FOR EACH ROW EXECUTE FUNCTION synthetic_grab_ack_fault()`,
				);
			} else
				await native.prisma.$executeRawUnsafe(
					`CREATE TRIGGER synthetic_grab_ack_fault BEFORE UPDATE ON "SearchGrabAttempt" WHEN NEW."state" = 'acknowledged' BEGIN SELECT RAISE(ABORT, 'synthetic ACK persistence fault'); END`,
				);
		});
		try {
			const svc = await service(),
				request = input();
			await expect(run(() => svc.submit(request))).rejects.toMatchObject({ statusCode: 502 });
			expect((await attempts())[0]?.state).toBe("submitting");
			expect(await holds()).toBe(1);
			const observed = await run(() => svc.submit(request));
			expect(observed.state).toBe("submitting");
			expect(posts).toHaveLength(1);
		} finally {
			await run(async () => {
				await native.prisma.$executeRawUnsafe(
					engine === "postgresql"
						? 'DROP TRIGGER "synthetic_grab_ack_fault" ON "SearchGrabAttempt"'
						: 'DROP TRIGGER "synthetic_grab_ack_fault"',
				);
				if (engine === "postgresql")
					await native.prisma.$executeRawUnsafe("DROP FUNCTION synthetic_grab_ack_fault()");
			});
		}
	});
	it("observes an in-flight same intent without dispatching again or stealing its claim", async () => {
		let entered!: () => void, resume!: () => void;
		const received = new Promise<void>((resolve) => {
			entered = resolve;
		});
		delay = {
			entered,
			resume: new Promise<void>((resolve) => {
				resume = resolve;
			}),
		};
		const svc = await service(),
			request = input();
		const pending = run(() => svc.submit(request));
		await received;
		try {
			expect((await run(() => svc.submit(request))).state).toBe("submitting");
			await expect(run(() => svc.submit(input()))).rejects.toMatchObject({ statusCode: 409 });
			expect(posts).toHaveLength(1);
			expect(await holds()).toBe(1);
		} finally {
			resume();
		}
		expect((await pending).state).toBe("acknowledged");
	});
	it("requires fresh explicit confirmation before one successor send and preserves original uncertainty", async () => {
		const svc = await service();
		replyMode = "mismatch";
		const first = await run(() => svc.submit(input()));
		await expect(run(() => svc.submit(input()))).rejects.toMatchObject({ statusCode: 409 });
		replyMode = "ack";
		const retry = input(randomUUID(), {
			retry: { predecessorId: first.attemptId, duplicateRiskConfirmed: true },
		});
		const second = await run(() => svc.submit(retry));
		expect(second.state).toBe("acknowledged");
		expect((await attempts()).find((row) => row.id === first.attemptId)?.state).toBe("uncertain");
		expect(posts).toHaveLength(2);
		expect(await holds()).toBe(0);
		expect((await run(() => svc.submit(retry))).attemptId).toBe(second.attemptId);
		expect(posts).toHaveLength(2);
	});
	it("returns owner-scoped safe status without requiring a selector or permitting writes", async () => {
		const svc = await service(),
			request = input();
		const first = await run(() => svc.submit(request));
		clock += 86_400_000;
		const status = await run(() => svc.status(request.intentId));
		expect(status).toEqual(first);
		expect(
			await run(async () => (await service(randomUUID())).status(request.intentId)),
		).toBeNull();
		expect(posts).toHaveLength(1);
		expect(await attempts()).toHaveLength(1);
	});
	it("refuses to expose an unrecognized stored outcome category", async () => {
		const svc = await service(),
			request = input();
		await run(() => svc.submit(request));
		await run(() =>
			native.prisma.searchGrabAttempt.updateMany({
				where: { userId, intentId: request.intentId },
				data: { outcomeCategory: "synthetic-private-diagnostic" },
			}),
		);
		const result = await run(() => svc.status(request.intentId)).then(
			(value) => ({ value, error: undefined }),
			(error: Error) => ({ value: undefined, error }),
		);
		expect(result.value).toBeUndefined();
		expect(result.error?.message).not.toContain("synthetic-private-diagnostic");
		expect(posts).toHaveLength(1);
	});
	it("refuses a connection change after the marker at the real SDK pre-fetch hook", async () => {
		const factory = new HookedFactory(encryptor, async () => {
			expect((await attempts())[0]?.state).toBe("submitting");
			await run(() =>
				native.prisma.serviceInstance.updateMany({
					where: { userId, id: instance.id },
					data: { baseUrl: `${baseUrl}/changed` },
				}),
			);
		});
		const svc = await service(userId, factory);
		expect((await run(() => svc.submit(input()))).state).toBe("uncertain");
		expect(posts).toEqual([]);
		expect(await holds()).toBe(1);
	});
	it("loses runtime admission before SDK fetch without a POST and recovers the marker as uncertainty", async () => {
		const request = input();
		const factory = new HookedFactory(encryptor, async () => {
			expect((await attempts())[0]?.state).toBe("submitting");
			getRestoreRuntimeClientContext(runtime).unavailable();
		});
		const svc = await service(userId, factory);
		await expect(run(() => svc.submit(request))).rejects.toMatchObject({ statusCode: 502 });
		expect(posts).toEqual([]);
		await native.close();
		await runtime.close();
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination("synthetic-grab-service");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		const recovered = await run(async () => (await service()).submit(request));
		expect(recovered.state).toBe("uncertain");
		expect(recovered.outcomeCategory).toBe("interrupted-after-marker");
		expect(await holds()).toBe(1);
		expect(posts).toEqual([]);
	});
});
