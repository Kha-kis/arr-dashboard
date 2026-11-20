import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { withIsolatedRuntimePrismaReadClient } from "../restore-runtime-client.js";

afterEach(closeScopedWriteFixtures);

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("cached-read cancellation before callback entry", { timeout: 20_000 }, () => {
	it.each(["native", "unregistered"] as const)(
		"refuses an already-aborted %s read with its exact reason",
		async (kind) => {
			const f = await createScopedWriteFixture();
			const controller = new AbortController();
			const reason = { synthetic: "cancelled" };
			controller.abort(reason);
			let entered = false;
			await expect(
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(
						kind === "native" ? f.client.prisma : f.plain,
						async () => {
							entered = true;
						},
						{ signal: controller.signal },
					),
				),
			).rejects.toBe(reason);
			expect(entered).toBe(false);
			expect(f.losses).toEqual([]);
		},
	);

	it("removes only the aborted waiter while every lane is held and preserves live FIFO", async () => {
		const f = await createScopedWriteFixture();
		const release = deferred(),
			ready = deferred();
		let entered = 0;
		const held = Array.from({ length: 4 }, () =>
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, async () => {
					if (++entered === 4) ready.resolve();
					await release.promise;
				}),
			),
		);
		const controller = new AbortController();
		const reason = new Error("Synthetic abandoned reader");
		const order: number[] = [];
		const pending: Promise<unknown>[] = [];
		try {
			await ready.promise;
			for (const index of [1, 2, 3]) {
				const queued = deferred();
				pending.push(
					f.runtime
						.runOperation(() => {
							const read = withIsolatedRuntimePrismaReadClient(
								f.client.prisma,
								async () => {
									order.push(index);
								},
								{
									maxWait: index === 2 ? 100 : 2000,
									...(index === 2 ? { signal: controller.signal } : {}),
								},
							);
							queued.resolve();
							return read;
						})
						.catch((error: unknown) => error),
				);
				await queued.promise;
			}
			controller.abort(reason);
			// Cancellation must settle without returning any holder's capacity.
			expect(await pending[1]).toBe(reason);
			expect(order).toEqual([]);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			release.resolve();
			await Promise.all([...held, ...pending]);
			expect(order).toEqual([1, 3]);
			expect(
				await f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
						reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
					),
				),
			).toBe(2);
			expect(f.losses).toEqual([]);
		} finally {
			release.resolve();
			await Promise.allSettled([...held, ...pending]);
		}
	});

	it.each(["grant", "timeout", "close"] as const)(
		"removes the queued abort listener after %s without a late abort affecting another reader",
		async (settlement) => {
			const f = await createScopedWriteFixture();
			const release = deferred(),
				ready = deferred(),
				queued = deferred();
			let entered = 0,
				queuedCalls = 0;
			const held = Array.from({ length: 4 }, () =>
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(f.client.prisma, async () => {
						if (++entered === 4) ready.resolve();
						await release.promise;
					}),
				),
			);
			const controller = new AbortController();
			let pending: Promise<unknown> | undefined, close: Promise<void> | undefined;
			try {
				await ready.promise;
				pending = f.runtime
					.runOperation(() => {
						const read = withIsolatedRuntimePrismaReadClient(
							f.client.prisma,
							async () => {
								queuedCalls++;
								return "granted";
							},
							{ signal: controller.signal, maxWait: settlement === "timeout" ? 20 : 2000 },
						);
						queued.resolve();
						return read;
					})
					.catch((error: unknown) => error);
				await queued.promise;
				expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
				if (settlement === "grant") release.resolve();
				if (settlement === "close") close = f.client.close();
				if (settlement === "grant") expect(await pending).toBe("granted");
				else expect(await pending).toMatchObject({ statusCode: 503 });
				expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
				controller.abort(new Error("Synthetic late cancellation"));
				release.resolve();
				await Promise.all(held);
				expect(queuedCalls).toBe(settlement === "grant" ? 1 : 0);
				if (settlement !== "close") {
					expect(
						await f.runtime.runOperation(() =>
							withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
								reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
							),
						),
					).toBe(2);
				}
				expect(f.losses).toEqual([]);
			} finally {
				release.resolve();
				await Promise.allSettled([...held, pending, close]);
			}
		},
	);

	it("releases an immediately granted lane when aborted before its callback continuation", async () => {
		const f = await createScopedWriteFixture();
		let entered = 0;
		for (let index = 0; index < 5; index++) {
			const controller = new AbortController();
			const reason = new Error("Synthetic immediate cancellation");
			await expect(
				f.runtime.runOperation(() => {
					const read = withIsolatedRuntimePrismaReadClient(
						f.client.prisma,
						async () => {
							entered++;
						},
						{ signal: controller.signal, maxWait: 50 },
					);
					controller.abort(reason);
					return read;
				}),
			).rejects.toBe(reason);
		}
		expect(entered).toBe(0);
		expect(
			await f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
					reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
				),
			),
		).toBe(2);
		expect(f.losses).toEqual([]);
	});

	it.each(["read", "transaction"] as const)(
		"keeps an entered %s joined and holds its lane through abort until settlement",
		async (kind) => {
			const f = await createScopedWriteFixture();
			const controller = new AbortController();
			const release = deferred(),
				ready = deferred();
			let entered = 0,
				settled = 0;
			const held = Array.from({ length: 4 }, () =>
				f.runtime
					.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(
							f.client.prisma,
							async (reader) => {
								const work = async (client: Pick<typeof reader, "serviceInstance">) => {
									if (++entered === 4) ready.resolve();
									await release.promise;
									return client.serviceInstance.count({ where: { userId: "synthetic-user" } });
								};
								return kind === "transaction" ? reader.$transaction(work) : work(reader);
							},
							{ signal: controller.signal },
						),
					)
					.finally(() => {
						settled++;
					}),
			);
			try {
				await ready.promise;
				controller.abort(new Error("Synthetic entered cancellation"));
				await expect(
					f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(f.client.prisma, async () => "unexpected", {
							maxWait: 20,
						}),
					),
				).rejects.toMatchObject({ statusCode: 503 });
				expect(settled).toBe(0);
				release.resolve();
				expect(await Promise.all(held)).toEqual([2, 2, 2, 2]);
				expect(
					await f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
							reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
						),
					),
				).toBe(2);
				expect(f.losses).toEqual([]);
			} finally {
				release.resolve();
				await Promise.allSettled(held);
			}
		},
	);
});
