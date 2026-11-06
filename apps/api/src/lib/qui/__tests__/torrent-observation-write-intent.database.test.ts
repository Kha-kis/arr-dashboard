import { afterEach, describe, expect, it } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import {
	beginQuiObservationPublication,
	captureQuiObservationTopology,
	invalidateQuiObservationPublication,
	withQuiObservationGenerationWrite,
} from "../torrent-observation-repository.js";

afterEach(closeScopedWriteFixtures);

const hash = "a".repeat(40);

async function fixture() {
	const f = await createScopedWriteFixture();
	await f.plain.serviceInstance.create({
		data: {
			id: "synthetic-qui",
			userId: "synthetic-user",
			service: "QUI",
			label: "Synthetic",
			baseUrl: "http://synthetic.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		},
	});
	await f.plain.user.create({ data: { id: "other-user", username: "other-user" } });
	for (const userId of ["synthetic-user", "other-user"]) {
		await f.plain.quiObservationPublication.create({
			data: {
				userId,
				generation: "previous",
				topologyDigest: "previous-topology",
				rowCount: 1,
				complete: false,
			},
		});
		await f.plain.quiTorrentObservation.create({
			data: { userId, generation: "previous", infoHash: hash, state: "paused", ratio: 0 },
		});
	}
	const topology = await captureQuiObservationTopology(f.plain, "synthetic-user");
	return {
		...f,
		topology,
		protectedQuiRows: async () => ({
			head: await f.plain.quiObservationPublication.findUnique({ where: { userId: "other-user" } }),
			rows: await f.plain.quiTorrentObservation.findMany({ where: { userId: "other-user" } }),
		}),
	};
}

describe("qUI observation guarded SQLite write admission", { timeout: 30_000 }, () => {
	// Break caught: a committed writer between runtime guard reads and the first
	// publication write must not turn a valid fenced update into BUSY_SNAPSHOT.
	it.each(["begin", "generation-write", "invalidate-new"] as const)(
		"reserves the writer before guarded reads for %s without replaying work",
		async (phase) => {
			const f = await fixture();
			if (phase === "invalidate-new") {
				await f.plain.quiObservationPublication.delete({ where: { userId: "synthetic-user" } });
			}
			const protectedRows = snapshotProtectedRows(f);
			const protectedQuiRows = await f.protectedQuiRows();
			const competition = interceptScopedWriteCompetition(f, { compete: true });
			let callbacks = 0;
			let failure: unknown;
			let result: unknown;
			try {
				result = await f.runtime.runOperation(async () => {
					const prisma = f.client.prisma;
					if (phase === "begin") {
						return beginQuiObservationPublication(
							prisma,
							"synthetic-user",
							f.topology.digest,
							1,
							"previous",
						);
					}
					if (phase === "invalidate-new") {
						return invalidateQuiObservationPublication(prisma, "synthetic-user", null);
					}
					return withQuiObservationGenerationWrite(
						prisma,
						"synthetic-user",
						"previous",
						async (tx) => {
							callbacks++;
							return (
								await tx.quiTorrentObservation.updateMany({
									where: { userId: "synthetic-user", generation: "previous", infoHash: hash },
									data: { state: "seeding", ratio: 2 },
								})
							).count;
						},
					);
				});
			} catch (error) {
				failure = error;
			}
			recordScopedWriteEvidence(`qui-${phase}-competing-commit`, {
				competition,
				failed: failure !== undefined,
				callbacks,
			});
			expect(failure).toBeUndefined();
			expect(competition).toMatchObject({
				reservations: 1,
				commits: 0,
				blocked: 1,
				nativeErrors: [],
			});
			const head = await f.plain.quiObservationPublication.findUniqueOrThrow({
				where: { userId: "synthetic-user" },
			});
			expect(head.complete).toBe(false);
			expect(head.observedAt).toBeNull();
			if (phase === "generation-write") {
				expect(result).toBe(1);
				expect(callbacks).toBe(1);
				expect(head.generation).toBe("previous");
				expect(
					await f.plain.quiTorrentObservation.findFirstOrThrow({
						where: { userId: "synthetic-user" },
					}),
				).toMatchObject({ state: "seeding", ratio: 2 });
			} else {
				expect(callbacks).toBe(0);
				expect(typeof result).toBe("string");
				expect(head.generation).toBe(result);
				expect(head.generation).not.toBe("previous");
				expect(head.rowCount).toBe(phase === "begin" ? 1 : 0);
			}
			expect(snapshotProtectedRows(f)).toEqual(protectedRows);
			expect(await f.protectedQuiRows()).toEqual(protectedQuiRows);
			expect(f.losses).toEqual([]);
		},
	);

	// Break caught: admission must not bypass a superseded generation fence.
	it("refuses a superseded generation without entering the write callback", async () => {
		const f = await fixture();
		const before = await f.plain.quiObservationPublication.findMany();
		const rows = await f.plain.quiTorrentObservation.findMany();
		let callbacks = 0;
		await expect(
			f.runtime.runOperation(() =>
				withQuiObservationGenerationWrite(
					f.client.prisma,
					"synthetic-user",
					"obsolete",
					async () => {
						callbacks++;
					},
				),
			),
		).rejects.toThrow("qUI observation generation or source changed");
		expect(callbacks).toBe(0);
		expect(await f.plain.quiObservationPublication.findMany()).toEqual(before);
		expect(await f.plain.quiTorrentObservation.findMany()).toEqual(rows);
		expect(f.losses).toEqual([]);
	});

	// Break caught: entered publication work is rolled back, not replayed, when
	// the callback fails after updating a projection.
	it("rolls back an entered write and propagates the same rejection once", async () => {
		const f = await fixture();
		const before = await f.plain.quiTorrentObservation.findMany();
		const rejection = new Error("Synthetic publication refusal");
		let callbacks = 0;
		await expect(
			f.runtime.runOperation(() =>
				withQuiObservationGenerationWrite(
					f.client.prisma,
					"synthetic-user",
					"previous",
					async (tx) => {
						callbacks++;
						await tx.quiTorrentObservation.updateMany({
							where: { userId: "synthetic-user" },
							data: { state: "seeding" },
						});
						throw rejection;
					},
				),
			),
		).rejects.toBe(rejection);
		expect(callbacks).toBe(1);
		expect(await f.plain.quiTorrentObservation.findMany()).toEqual(before);
		expect(f.losses).toEqual([]);
	});
});
