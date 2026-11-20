import { once } from "node:events";
import { createServer } from "node:http";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import {
	createProviderPublicationAuthority,
	withGuardedProviderPublication,
} from "../provider-identity-guard.js";

const log = pino({ enabled: false });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function setup() {
	const native = await createNotificationOutboxNativeFixture();
	let requests = 0;
	const server = createServer((_request, reply) => {
		requests++;
		reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
		reply.end(JSON.stringify({ Id: "synthetic", ServerName: "Synthetic", Version: "1" }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw Error("loopback required");
	const row = await native.run(async () => {
		const encrypted = native.encryptor.encrypt("synthetic");
		const row = await native.prisma.serviceInstance.create({
			data: {
				userId: native.userId,
				service: "JELLYFIN",
				label: "Synthetic",
				baseUrl: `http://127.0.0.1:${address.port}`,
				encryptedApiKey: encrypted.value,
				encryptionIv: encrypted.iv,
				expectedIdentity: "synthetic",
				identityStatus: "VERIFIED",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await native.prisma.cacheRefreshStatus.create({
			data: {
				instanceId: row.id,
				cacheType: "jellyfin",
				lastRefreshedAt: new Date("2026-10-10T00:00:00Z"),
				lastResult: "success",
				generationId: "old",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		return row;
	});
	return {
		native,
		row,
		snapshot: { ...createProviderPublicationAuthority(row), apiKey: "synthetic" },
		requests: () => requests,
		status: () =>
			native.run(() =>
				native.prisma.cacheRefreshStatus.findUniqueOrThrow({
					where: { instanceId_cacheType: { instanceId: row.id, cacheType: "jellyfin" } },
				}),
			),
		async close() {
			await native.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
describe("publication cancellation preserves native authority and transaction joins", () => {
	for (const phase of ["before-identity", "after-collection", "transaction-admission"] as const) {
		it(`blocks publisher at ${phase}`, async () => {
			const f = await setup(),
				controller = new AbortController(),
				admission = deferred(),
				release = deferred();
			let enteredPublisher = false;
			const prisma =
				phase === "transaction-admission"
					? new Proxy(f.native.prisma, {
							get(target, property, receiver) {
								if (property === "$transaction")
									return async (...args: unknown[]) => {
										admission.resolve();
										await release.promise;
										return Reflect.apply(target.$transaction, target, args);
									};
								return Reflect.get(target, property, receiver);
							},
						})
					: f.native.prisma;
			if (phase === "before-identity") controller.abort(new Error("private reason"));
			const running = f.native.run(() =>
				withGuardedProviderPublication(
					prisma,
					f.snapshot,
					log,
					async () => {
						if (phase === "after-collection") controller.abort(new Error("private reason"));
						return "snapshot";
					},
					async (tx) => {
						enteredPublisher = true;
						await tx.cacheRefreshStatus.updateMany({
							where: { instanceId: f.row.id, cacheType: "jellyfin" },
							data: { generationId: "new" },
						});
						return "published";
					},
					{ signal: controller.signal },
				),
			);
			const rejected = expect(running).rejects.toMatchObject({
				code: "PUBLICATION_CANCELLED",
				message: "Provider cache publication cancelled.",
			});
			try {
				if (phase === "transaction-admission") {
					await admission.promise;
					controller.abort(new Error("private reason"));
					release.resolve();
				}
				await rejected;
				expect(enteredPublisher).toBe(false);
				expect((await f.status()).generationId).toBe("old");
				expect(f.requests()).toBe(
					phase === "before-identity" ? 0 : phase === "after-collection" ? 1 : 2,
				);
			} finally {
				release.resolve();
				await running.catch(() => {});
				await f.close();
			}
		});
	}
	it("joins a publisher already started and preserves its real committed success", async () => {
		const f = await setup(),
			controller = new AbortController(),
			entered = deferred(),
			release = deferred();
		let completed = false;
		const running = f.native
			.run(() =>
				withGuardedProviderPublication(
					f.native.prisma,
					f.snapshot,
					log,
					async () => "snapshot",
					async (tx) => {
						entered.resolve();
						await release.promise;
						await tx.cacheRefreshStatus.updateMany({
							where: { instanceId: f.row.id, cacheType: "jellyfin" },
							data: { generationId: "committed" },
						});
						return "published";
					},
					{ signal: controller.signal },
				),
			)
			.then((value) => {
				completed = true;
				return value;
			});
		try {
			await entered.promise;
			controller.abort(new Error("private reason"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(completed).toBe(false);
			release.resolve();
			await expect(running).resolves.toBe("published");
			expect((await f.status()).generationId).toBe("committed");
			expect(f.requests()).toBe(2);
		} finally {
			release.resolve();
			await running.catch(() => {});
			await f.close();
		}
	});
	it("keeps an ordinary signal-omitted publication successful", async () => {
		const f = await setup();
		try {
			await expect(
				f.native.run(() =>
					withGuardedProviderPublication(
						f.native.prisma,
						f.snapshot,
						log,
						async () => "snapshot",
						async (tx) => {
							await tx.cacheRefreshStatus.updateMany({
								where: { instanceId: f.row.id, cacheType: "jellyfin" },
								data: { generationId: "ordinary" },
							});
							return "published";
						},
					),
				),
			).resolves.toBe("published");
			expect((await f.status()).generationId).toBe("ordinary");
		} finally {
			await f.close();
		}
	});
	it("cancels one real instance while another concurrently publishes", async () => {
		const a = await setup(),
			b = await setup(),
			controller = new AbortController(),
			entered = deferred(),
			release = deferred();
		const canceled = a.native.run(() =>
			withGuardedProviderPublication(
				a.native.prisma,
				a.snapshot,
				log,
				async () => {
					entered.resolve();
					await release.promise;
					return "a";
				},
				async () => "wrong",
				{ signal: controller.signal },
			),
		);
		const rejection = expect(canceled).rejects.toMatchObject({ code: "PUBLICATION_CANCELLED" });
		try {
			await entered.promise;
			const other = b.native.run(() =>
				withGuardedProviderPublication(
					b.native.prisma,
					b.snapshot,
					log,
					async () => "b",
					async (tx) => {
						await tx.cacheRefreshStatus.updateMany({
							where: { instanceId: b.row.id, cacheType: "jellyfin" },
							data: { generationId: "independent" },
						});
						return "b-published";
					},
				),
			);
			controller.abort();
			release.resolve();
			await rejection;
			await expect(other).resolves.toBe("b-published");
			expect((await a.status()).generationId).toBe("old");
			expect((await b.status()).generationId).toBe("independent");
		} finally {
			release.resolve();
			await canceled.catch(() => {});
			await a.close();
			await b.close();
		}
	});
});
