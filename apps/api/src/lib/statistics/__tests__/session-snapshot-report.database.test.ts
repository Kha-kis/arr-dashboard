import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { readSessionSnapshotReportPages } from "../session-snapshot-pages.js";

afterEach(closeScopedWriteFixtures);
const at = new Date("2026-11-01T00:00:00Z");

describe("consistent statistics report native snapshot", { timeout: 20_000 }, () => {
	it("streams both whole-window orders across tied pages without counting coverage twice", async () => {
		const f = await createScopedWriteFixture();
		const rows = Array.from({ length: 1_001 }, (_, i) => ({
			id: `row-${String(i).padStart(4, "0")}`,
			instanceId: "synthetic-plex",
			capturedAt: at,
			concurrentStreams: 1,
			sessionsJson: "[]",
		}));
		for (let i = 0; i < rows.length; i += 500) {
			await f.plain.sessionSnapshot.createMany({ data: rows.slice(i, i + 500).reverse() });
		}
		await f.plain.sessionSnapshot.create({
			data: {
				id: "excluded-provider",
				instanceId: "synthetic-jellyfin",
				capturedAt: at,
				concurrentStreams: 1,
				sessionsJson: "[]",
			},
		});
		const forward: string[][] = [],
			reverse: string[][] = [];
		interceptScopedWriteCompetition(f);
		const read = await f.runtime.runOperation(() =>
			readSessionSnapshotReportPages(f.client.prisma, {
				userId: "synthetic-user",
				services: ["PLEX"],
				cutoff: at,
				onChronologicalPage: (page) => {
					forward.push(page.map((row) => row.id));
				},
				onReverseChronologicalPage: (page) => {
					reverse.push(page.map((row) => row.id));
				},
			}),
		);
		expect(forward.map((page) => page.length)).toEqual([500, 500, 1]);
		expect(reverse.map((page) => page.length)).toEqual([500, 500, 1]);
		expect(forward.flat()).toEqual(rows.map((row) => row.id));
		expect(reverse.flat()).toEqual(rows.map((row) => row.id).reverse());
		expect(read).toEqual({
			instanceCount: 1,
			snapshotCount: 1_001,
			collection: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 1_001,
				invalidSnapshots: 0,
			},
			collectionByDate: {
				"2026-11-01": {
					activeSnapshots: 0,
					idleSnapshots: 0,
					failedSnapshots: 0,
					legacySnapshots: 1_001,
					invalidSnapshots: 0,
				},
			},
		});
		expect(f.applications.size).toBe(1);
		expect(f.losses).toEqual([]);
	});

	it("keeps the same snapshot when another connection commits between traversal orders", async () => {
		const f = await createScopedWriteFixture();
		await f.plain.sessionSnapshot.create({
			data: {
				id: "before",
				instanceId: "synthetic-plex",
				capturedAt: at,
				concurrentStreams: 1,
				sessionsJson: "[]",
			},
		});
		const observed: number[] = [];
		let committed = false;
		await f.runtime.runOperation(() =>
			readSessionSnapshotReportPages(f.client.prisma, {
				userId: "synthetic-user",
				services: ["PLEX"],
				cutoff: at,
				onChronologicalPage: (page) => {
					observed.push(...page.map((row) => row.concurrentStreams));
					if (!committed) {
						f.writer
							.prepare('UPDATE "session_snapshots" SET "concurrentStreams"=9 WHERE "id"=?')
							.run("before");
						committed = true;
					}
				},
				onReverseChronologicalPage: (page) => {
					observed.push(...page.map((row) => row.concurrentStreams));
				},
			}),
		);
		expect(committed).toBe(true);
		expect(observed).toEqual([1, 1]);
		expect(
			await f.plain.sessionSnapshot.findUnique({
				where: { id: "before" },
				select: { concurrentStreams: true },
			}),
		).toEqual({ concurrentStreams: 9 });
	});

	it("rejects a failed second traversal and safely reuses its admitted lane", async () => {
		const f = await createScopedWriteFixture();
		await f.plain.sessionSnapshot.create({
			data: {
				id: "sample",
				instanceId: "synthetic-plex",
				capturedAt: at,
				concurrentStreams: 1,
				sessionsJson: "[]",
			},
		});
		interceptScopedWriteCompetition(f);
		const failure = new Error("synthetic-second-traversal-failure");
		await expect(
			f.runtime.runOperation(() =>
				readSessionSnapshotReportPages(f.client.prisma, {
					userId: "synthetic-user",
					services: ["PLEX"],
					cutoff: at,
					onChronologicalPage: () => {},
					onReverseChronologicalPage: () => {
						throw failure;
					},
				}),
			),
		).rejects.toBe(failure);
		await expect(
			f.runtime.runOperation(() =>
				readSessionSnapshotReportPages(f.client.prisma, {
					userId: "synthetic-user",
					services: ["PLEX"],
					cutoff: at,
					onChronologicalPage: () => {},
					onReverseChronologicalPage: () => {},
				}),
			),
		).resolves.toMatchObject({ instanceCount: 1, snapshotCount: 1 });
		expect(f.applications.size).toBe(1);
		await f.client.close();
		expect([...f.applications].every((native) => !native.open)).toBe(true);
		await expect(
			f.runtime.runOperation(() =>
				readSessionSnapshotReportPages(f.client.prisma, {
					userId: "synthetic-user",
					services: ["PLEX"],
					cutoff: at,
					onChronologicalPage: () => {},
					onReverseChronologicalPage: () => {},
				}),
			),
		).rejects.toMatchObject({ statusCode: 503 });
		expect(f.losses).toEqual([]);
	});
});
