import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerFetchRoutes } from "../../../routes/library/fetch-routes.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import {
	withIsolatedRuntimePrismaReadClient,
	withIsolatedRuntimePrismaReadTransaction,
} from "../restore-runtime-client.js";
import { type RuntimeReadTiming, withRuntimeReadTiming } from "../restore-runtime-read-timing.js";

afterEach(closeScopedWriteFixtures);

describe("ordinary cached reads during publication", { timeout: 20_000 }, () => {
	it("measures real guarded reads without changing data, tickets or closure", async () => {
		const f = await createScopedWriteFixture();
		let stages!: RuntimeReadTiming;
		const result = await withRuntimeReadTiming(
			() =>
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(f.client.prisma, (client) =>
						client.$transaction((tx) =>
							tx.plexCache.findUnique({
								where: { id: "synthetic-cache", instance: { userId: "synthetic-user" } },
								select: { watchCount: true },
							}),
						),
					),
				),
			(value) => {
				stages = value;
			},
		);
		expect(result).toEqual({ watchCount: 0 });
		for (const stage of [
			"lane-wait",
			"connect",
			"guard",
			"yield",
			"statement-call",
			"owner-proof",
		] as const) {
			expect(stages[stage].count).toBeGreaterThan(0);
			expect(stages[stage].totalMs).toBeGreaterThanOrEqual(stages[stage].maxMs);
		}
		await expect(
			withIsolatedRuntimePrismaReadClient(f.client.prisma, (client) => client.plexCache.count()),
		).rejects.toMatchObject({ statusCode: 503 });
		expect(f.losses).toEqual([]);
	});

	it("preserves outside-snapshot postchecks, releases rejected callbacks, and retains ticket and close fences", async () => {
		const f = await createScopedWriteFixture();
		const selection = {
			where: { id: "synthetic-cache", instance: { userId: "synthetic-user" } },
			select: { watchCount: true },
		};
		await expect(
			withIsolatedRuntimePrismaReadClient(f.client.prisma, (client) =>
				client.plexCache.findUnique(selection),
			),
		).rejects.toMatchObject({ statusCode: 503 });
		const sentinel = new Error("synthetic-display-rejection");
		await expect(
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, async () => {
					throw sentinel;
				}),
			),
		).rejects.toBe(sentinel);
		await f.runtime.runOperation(() =>
			withIsolatedRuntimePrismaReadClient(f.client.prisma, async (client) => {
				const before = await client.$transaction((tx) => tx.plexCache.findUnique(selection));
				expect(before).toEqual({ watchCount: 0 });
				await f.plain.plexCache.update({
					where: { id: "synthetic-cache" },
					data: { watchCount: 1 },
				});
				// This is a fresh committed read, not another view of the first snapshot.
				expect(await client.plexCache.findUnique(selection)).toEqual({ watchCount: 1 });
			}),
		);
		await f.client.close();
		await expect(
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, (client) =>
					client.plexCache.findUnique(selection),
				),
			),
		).rejects.toMatchObject({ statusCode: 503 });
		expect(f.losses).toEqual([]);
	});

	it("refuses to borrow an unrelated transaction while an isolated reader sees committed data", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		let entered!: () => void;
		let release!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const rollback = new Error("synthetic-publication-rollback");
		const publication = f.runtime
			.runOperation(() =>
				f.client.prisma.$transaction(
					async (tx) => {
						await tx.plexCache.update({
							where: { id: "synthetic-cache" },
							data: { watchCount: 99 },
						});
						entered();
						await held;
						throw rollback;
					},
					{ timeout: 15_000 },
				),
			)
			.then(
				() => null,
				(error: unknown) => error,
			);
		try {
			await enteredPromise;
			const selection = {
				where: { id: "synthetic-cache", instance: { userId: "synthetic-user" } },
				select: { watchCount: true },
			};
			const ordinary = await f.runtime
				.runOperation(() => f.client.prisma.plexCache.findUnique(selection))
				.then(
					(value) => ({ status: "success", watchCount: value?.watchCount }),
					(error: { name?: string; statusCode?: number }) => ({
						status: "error",
						name: error.name,
						statusCode: error.statusCode,
					}),
				);
			const isolated = await f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadTransaction(f.client.prisma, (tx) =>
					tx.plexCache.findUnique(selection),
				),
			);
			expect(isolated).toEqual({ watchCount: 0 });
			// Ordinary-client refusal is intentional: bypassing it would expose the
			// other operation's uncommitted watchCount99. Display callers need a lane.
			expect(ordinary).toEqual({
				status: "error",
				name: "RestoreRuntimeAdmissionError",
				statusCode: 503,
			});
		} finally {
			release();
			expect(await publication).toBe(rollback);
		}
		expect(
			await f.plain.plexCache.findUnique({
				where: { id: "synthetic-cache" },
				select: { watchCount: true },
			}),
		).toEqual({ watchCount: 0 });
		expect(f.losses).toEqual([]);
	});

	it("serves the owned cached Library page during a held ordinary publication without leaking its uncommitted row", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
		for (const [id, userId] of [
			["owned-arr", "synthetic-user"],
			["foreign-arr", "foreign-user"],
		]) {
			await f.plain.serviceInstance.create({
				data: {
					id: id!,
					userId: userId!,
					service: "RADARR",
					label: "Synthetic",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				},
			});
			await f.plain.libraryCache.create({
				data: {
					id: `${id}-cache`,
					instanceId: id!,
					arrItemId: 1,
					itemType: "movie",
					title: "Committed",
					data: JSON.stringify({
						id: 1,
						instanceId: id,
						instanceName: "Synthetic",
						service: "radarr",
						type: "movie",
						title: "Committed",
						monitored: true,
					}),
				},
			});
		}
		const app = Fastify({ logger: false });
		app.decorate("prisma", f.client.prisma);
		app.decorate("dbProvider", "sqlite");
		app.addHook("onRequest", async (request) => {
			request.currentUser = { id: "synthetic-user" } as typeof request.currentUser;
		});
		await app.register(registerFetchRoutes);
		await app.ready();
		expect(
			(
				await f.runtime.runOperation(async () =>
					app.inject({ method: "GET", url: "/library?limit=10" }),
				)
			).statusCode,
		).toBe(200);
		let entered!: () => void;
		let release!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const rollback = new Error("synthetic-library-publication-rollback");
		const publication = f.runtime
			.runOperation(() =>
				f.client.prisma.$transaction(
					async (tx) => {
						await tx.libraryCache.update({
							where: { id: "owned-arr-cache" },
							data: {
								data: JSON.stringify({
									id: 1,
									instanceId: "owned-arr",
									instanceName: "Synthetic",
									service: "radarr",
									type: "movie",
									title: "Uncommitted",
									monitored: true,
								}),
							},
						});
						entered();
						await held;
						throw rollback;
					},
					{ timeout: 15_000 },
				),
			)
			.then(
				() => null,
				(error: unknown) => error,
			);
		try {
			await enteredPromise;
			const response = await f.runtime.runOperation(async () =>
				app.inject({ method: "GET", url: "/library?limit=10" }),
			);
			expect(response.statusCode, response.body).toBe(200);
			expect(response.json()).toMatchObject({
				pagination: { totalItems: 1 },
				quiObservationStatus: { status: "not_configured" },
			});
			expect(response.json().items).toEqual([
				expect.objectContaining({ instanceId: "owned-arr", title: "Committed" }),
			]);
		} finally {
			release();
			expect(await publication).toBe(rollback);
			await app.close();
		}
		expect(
			JSON.parse(
				(await f.plain.libraryCache.findUniqueOrThrow({ where: { id: "owned-arr-cache" } })).data,
			).title,
		).toBe("Committed");
		expect(f.losses).toEqual([]);
	});
});
