import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { withIsolatedRuntimePrismaReadClient } from "../restore-runtime-client.js";

afterEach(closeScopedWriteFixtures);

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("cached-read workload admission", { timeout: 20_000 }, () => {
	it("keeps two ordinary lanes available while bulk waiters retain FIFO without borrowing lanes", async () => {
		const f = await createScopedWriteFixture();
		const gates = Array.from({ length: 4 }, signal);
		const twoEntered = signal(),
			thirdEntered = signal(),
			fourthEntered = signal();
		const order: number[] = [];
		let active = 0,
			maxBulk = 0;
		const holders = gates.map((gate, index) =>
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(
					f.client.prisma,
					async (reader) => {
						order.push(index);
						active++;
						maxBulk = Math.max(maxBulk, active);
						if (order.length === 2) twoEntered.resolve();
						if (order.length === 3) thirdEntered.resolve();
						if (order.length === 4) fourthEntered.resolve();
						try {
							await reader.serviceInstance.count({ where: { userId: "synthetic-user" } });
							await gate.promise;
						} finally {
							active--;
						}
					},
					{ workload: "bulk-cache" },
				),
			),
		);
		const ordinaryGates = [signal(), signal()];
		const ordinaryReady = signal();
		const ordinaryHolders: Promise<unknown>[] = [];
		let ordinaryCount = 0;
		let probe: Promise<number> | undefined;
		try {
			await twoEntered.promise;
			probe = f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
					reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
				),
			);
			expect(
				await Promise.race([
					probe.then(() => "ordinary"),
					thirdEntered.promise.then(() => "third-bulk"),
				]),
			).toBe("ordinary");
			expect(await probe).toBe(2);
			expect(order).toEqual([0, 1]);
			for (const gate of ordinaryGates)
				ordinaryHolders.push(
					f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(f.client.prisma, async (reader) => {
							await reader.serviceInstance.count({ where: { userId: "synthetic-user" } });
							if (++ordinaryCount === 2) ordinaryReady.resolve();
							await gate.promise;
						}),
					),
				);
			await ordinaryReady.promise;
			let fifthEntered = false;
			await expect(
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(
						f.client.prisma,
						async () => {
							fifthEntered = true;
						},
						{ maxWait: 20 },
					),
				),
			).rejects.toMatchObject({ statusCode: 503 });
			expect(fifthEntered).toBe(false);
			gates[0]!.resolve();
			await thirdEntered.promise;
			expect(order).toEqual([0, 1, 2]);
			gates[1]!.resolve();
			await fourthEntered.promise;
			expect(order).toEqual([0, 1, 2, 3]);
			expect(maxBulk).toBe(2);
			expect(f.losses).toEqual([]);
		} finally {
			for (const gate of [...gates, ...ordinaryGates]) gate.resolve();
			await Promise.allSettled([...holders, ...ordinaryHolders]);
			await probe;
		}
	});

	it("releases bulk eligibility after callback failure without retrying that callback", async () => {
		const f = await createScopedWriteFixture();
		const gate = signal(),
			twoEntered = signal();
		let entered = 0,
			failures = 0;
		const held = [0, 1].map(() =>
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(
					f.client.prisma,
					async () => {
						if (++entered === 2) twoEntered.resolve();
						await gate.promise;
					},
					{ workload: "bulk-cache" },
				),
			),
		);
		try {
			await twoEntered.promise;
			const sentinel = new Error("synthetic-bulk-rejection");
			const rejected = f.runtime
				.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(
						f.client.prisma,
						async () => {
							failures++;
							throw sentinel;
						},
						{ workload: "bulk-cache" },
					),
				)
				.catch((error) => error);
			gate.resolve();
			await Promise.all(held);
			expect(await rejected).toBe(sentinel);
			const result = await f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(
					f.client.prisma,
					(reader) => reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
					{ workload: "bulk-cache" },
				),
			);
			expect(result).toBe(2);
			expect(failures).toBe(1);
			expect(f.losses).toEqual([]);
		} finally {
			gate.resolve();
			await Promise.allSettled(held);
		}
	});

	it("expires an ineligible bulk waiter without invoking it after capacity returns", async () => {
		const f = await createScopedWriteFixture();
		const gate = signal(),
			twoEntered = signal();
		let entered = 0,
			lateCalls = 0;
		const held = [0, 1].map(() =>
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(
					f.client.prisma,
					async () => {
						if (++entered === 2) twoEntered.resolve();
						await gate.promise;
					},
					{ workload: "bulk-cache" },
				),
			),
		);
		try {
			await twoEntered.promise;
			await expect(
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(
						f.client.prisma,
						async () => {
							lateCalls++;
						},
						{ workload: "bulk-cache", maxWait: 20 },
					),
				),
			).rejects.toMatchObject({ statusCode: 503 });
			gate.resolve();
			await Promise.all(held);
			await f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(
					f.client.prisma,
					(reader) => reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
					{ workload: "bulk-cache" },
				),
			);
			expect(lateCalls).toBe(0);
			expect(f.losses).toEqual([]);
		} finally {
			gate.resolve();
			await Promise.allSettled(held);
		}
	});

	it("rejects queued and new bulk work when the registered client closes", async () => {
		const f = await createScopedWriteFixture();
		const gate = signal(),
			twoEntered = signal();
		let entered = 0,
			queuedCalls = 0;
		const held = [0, 1].map(() =>
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(
					f.client.prisma,
					async () => {
						if (++entered === 2) twoEntered.resolve();
						await gate.promise;
					},
					{ workload: "bulk-cache" },
				),
			),
		);
		let close: Promise<void> | undefined;
		try {
			await twoEntered.promise;
			const queued = f.runtime
				.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(
						f.client.prisma,
						async () => {
							queuedCalls++;
						},
						{ workload: "bulk-cache" },
					),
				)
				.catch((error) => error);
			close = f.client.close();
			expect(await queued).toMatchObject({ statusCode: 503 });
			await expect(
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(
						f.client.prisma,
						async () => {
							queuedCalls++;
						},
						{ workload: "bulk-cache" },
					),
				),
			).rejects.toMatchObject({ statusCode: 503 });
			expect(queuedCalls).toBe(0);
		} finally {
			gate.resolve();
			await Promise.allSettled(held);
			await close;
		}
	});

	it("preserves direct reads for an unregistered client", async () => {
		const f = await createScopedWriteFixture();
		const result = await withIsolatedRuntimePrismaReadClient(
			f.plain,
			async (reader) => {
				expect(reader).toBe(f.plain);
				return reader.serviceInstance.count({ where: { userId: "synthetic-user" } });
			},
			{ workload: "bulk-cache" },
		);
		expect(result).toBe(2);
	});
});
