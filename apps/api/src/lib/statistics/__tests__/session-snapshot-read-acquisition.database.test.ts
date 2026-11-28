import { setImmediate as turn } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { withIsolatedRuntimePrismaReadTransaction } from "../../backup/restore-runtime-client.js";
import {
	readSessionSnapshotMetricsPages,
	readSessionSnapshotPages,
} from "../session-snapshot-pages.js";

afterEach(closeScopedWriteFixtures);

describe("statistics foreground transaction acquisition", { timeout: 20_000 }, () => {
	it("reads owned snapshot pages while another foreground read transaction is held", async () => {
		const f = await createScopedWriteFixture();
		const capturedAt = new Date("2026-11-01T00:00:00Z");
		await f.plain.sessionSnapshot.create({
			data: {
				id: "synthetic-snapshot",
				instanceId: "synthetic-plex",
				capturedAt,
				concurrentStreams: 1,
				totalBandwidth: 0,
				lanBandwidth: 0,
				wanBandwidth: 0,
				directPlayCount: 1,
				transcodeCount: 0,
				directStreamCount: 0,
				sessionsJson: "[]",
			},
		});
		let entered!: () => void;
		let release!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Represents an earlier analytics request still paging a consistent read.
		// It performs no application write and keeps the real guarded connection.
		const first = f.runtime.runOperation(() =>
			f.client.prisma.$transaction(
				async (tx) => {
					await tx.sessionSnapshot.findMany({ take: 1, select: { id: true } });
					entered();
					await held;
				},
				{ timeout: 15_000 },
			),
		);
		try {
			await enteredPromise;
			const ids: string[] = [];
			const result = await f.runtime
				.runOperation(() =>
					readSessionSnapshotPages(f.client.prisma, {
						userId: "synthetic-user",
						services: ["PLEX"],
						cutoff: capturedAt,
						onPage: (page) => ids.push(...page.map((row) => row.id)),
					}),
				)
				.then(
					(value) => ({ status: "success", snapshotCount: value.snapshotCount }),
					(error: { code?: string }) => ({ status: "error", code: error.code }),
				);
			expect(result).toEqual({ status: "success", snapshotCount: 1 });
			expect(ids).toEqual(["synthetic-snapshot"]);
		} finally {
			release();
			await first;
		}
		expect(f.losses).toEqual([]);
	});

	it("bounds concurrent native readers, refuses an exhausted wait budget, and reuses physically owned lanes", async () => {
		const f = await createScopedWriteFixture();
		interceptScopedWriteCompetition(f);
		let release!: () => void;
		let allEntered!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			allEntered = resolve;
		});
		let count = 0;
		const readers = Array.from({ length: 4 }, () =>
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadTransaction(f.client.prisma, async (tx) => {
					const row = await tx.plexCache.findUnique({
						where: { id: "synthetic-cache" },
						select: { watchCount: true },
					});
					if (++count === 4) allEntered();
					await held;
					return row;
				}),
			),
		);
		try {
			await entered;
			await expect(
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadTransaction(f.client.prisma, (tx) => tx.plexCache.count(), {
						maxWait: 25,
					}),
				),
			).rejects.toMatchObject({ statusCode: 503 });
			expect(f.applications.size).toBe(4);
		} finally {
			release();
			await Promise.all(readers);
		}
		const sentinel = new Error("Synthetic read rejected");
		await expect(
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadTransaction(f.client.prisma, async () => {
					throw sentinel;
				}),
			),
		).rejects.toBe(sentinel);
		await expect(
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadTransaction(f.client.prisma, (tx) =>
					tx.plexCache.findUnique({
						where: { id: "synthetic-cache" },
						select: { watchCount: true },
					}),
				),
			),
		).resolves.toEqual({ watchCount: 0 });
		expect(f.applications.size).toBe(4);
		await f.client.close();
		expect([...f.applications].every((native) => !native.open)).toBe(true);
		await expect(
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadTransaction(f.client.prisma, (tx) => tx.plexCache.count()),
			),
		).rejects.toMatchObject({ statusCode: 503 });
		expect(f.losses).toEqual([]);
	});

	it("joins an admitted first statistics read during shutdown without reopening admission", async () => {
		const f = await createScopedWriteFixture();
		interceptScopedWriteCompetition(f);
		let entered!: () => void;
		let release!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reader = f.runtime.runOperation(async () => {
			entered();
			await held;
			return readSessionSnapshotPages(f.client.prisma, {
				userId: "synthetic-user",
				services: ["PLEX"],
				cutoff: new Date(0),
				onPage: () => {},
			});
		});
		await enteredPromise;
		let closed = false;
		const closing = f.runtime.close().then(() => {
			closed = true;
		});
		try {
			await turn();
			expect(closed).toBe(false);
			await expect(f.runtime.runOperation(() => Promise.resolve())).rejects.toMatchObject({
				statusCode: 503,
			});
		} finally {
			release();
			await reader;
			await closing;
		}
		await expect(reader).resolves.toMatchObject({ instanceCount: 1, snapshotCount: 0 });
		expect(f.applications.size).toBe(1);
		expect([...f.applications].every((native) => !native.open)).toBe(true);
		expect(f.losses).toEqual([]);
	});

	it("serves a provider-tab fan-out over a populated multi-page inventory", async () => {
		const f = await createScopedWriteFixture();
		const capturedAt = new Date("2026-11-01T00:00:00Z");
		const count = 17_425;
		for (let offset = 0; offset < count; offset += 500) {
			await f.plain.sessionSnapshot.createMany({
				data: Array.from({ length: Math.min(500, count - offset) }, (_, i) => ({
					id: `synthetic-${String(offset + i).padStart(6, "0")}`,
					instanceId: "synthetic-plex",
					capturedAt,
					concurrentStreams: 0,
					totalBandwidth: 0,
					lanBandwidth: 0,
					wanBandwidth: 0,
					directPlayCount: 0,
					transcodeCount: 0,
					directStreamCount: 0,
					sessionsJson: "[]",
				})),
			});
		}
		const reads = [readSessionSnapshotPages, readSessionSnapshotMetricsPages];
		const results = await Promise.all(
			Array.from({ length: 14 }, (_, i) =>
				f.runtime.runOperation(() =>
					reads[i % 2]!(f.client.prisma, {
						userId: "synthetic-user",
						services: ["PLEX"],
						cutoff: capturedAt,
						onPage: () => {},
					}),
				),
			),
		);
		expect(results.map((r) => r.snapshotCount)).toEqual(Array(14).fill(count));
		expect(f.losses).toEqual([]);
	}, 45_000);
});
