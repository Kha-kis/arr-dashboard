import { setTimeout as delay, setImmediate as turn } from "node:timers/promises";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerHealthRoutes } from "../../../routes/health.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { withCurrentProviderPublicationAuthority } from "../provider-identity-guard.js";

afterEach(closeScopedWriteFixtures);

describe("provider publication foreground read isolation", () => {
	// Lending the HTTP client's native handle to publication blocks both the
	// real health handler and ordinary cache reads until the publisher commits.
	it("serves committed cache and health while atomic publication remains held", async () => {
		const f = await createScopedWriteFixture();
		const app = Fastify({ logger: false });
		app.decorate("prisma", f.client.prisma);
		app.register(registerHealthRoutes, { prefix: "/health" });
		await app.ready();
		let entered!: () => void;
		let release!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const publication = f.runtime.runOperation(() =>
			withCurrentProviderPublicationAuthority(f.client.prisma, f.authority, async (tx) => {
				await tx.plexCache.updateMany({
					where: { id: "synthetic-cache", instanceId: f.authority.id },
					data: { watchCount: 7 },
				});
				entered();
				await held;
				return "committed";
			}),
		);
		let foreground: Promise<unknown> | undefined;
		try {
			await enteredPromise;
			foreground = f.runtime.runOperation(async () => {
				const [cache, health] = await Promise.all([
					f.client.prisma.plexCache.findUnique({
						where: { id: "synthetic-cache" },
						select: { watchCount: true },
					}),
					app.inject({ method: "GET", url: "/health" }),
				]);
				return { cache, status: health.statusCode };
			});
			const observed = await Promise.race([
				foreground.then((value) => ({ completed: true, value })),
				delay(500).then(() => ({ completed: false, value: null })),
			]);
			expect(observed).toEqual({
				completed: true,
				value: { cache: { watchCount: 0 }, status: 200 },
			});
		} finally {
			release();
			await publication;
			await foreground;
			await app.close();
		}
		expect(
			f.writer.prepare("SELECT watchCount FROM plex_cache WHERE id='synthetic-cache'").get(),
		).toEqual({ watchCount: 7 });
		expect(f.losses).toEqual([]);
	});

	// Publication gets one companion, not an unbounded connection per attempt.
	// Physical cleanup belongs to parent/runtime close, not post-COMMIT outcome handling.
	it("reuses one publication companion and physically closes it with the parent", async () => {
		const f = await createScopedWriteFixture();
		interceptScopedWriteCompetition(f);
		const result = await f.runtime.runOperation(() =>
			withCurrentProviderPublicationAuthority(f.client.prisma, f.authority, async (tx) => {
				await tx.plexCache.updateMany({
					where: { id: "synthetic-cache" },
					data: { watchCount: 3 },
				});
				return 3;
			}),
		);
		expect(result).toEqual({ matched: true, value: 3 });
		expect(f.applications.size).toBe(1);
		expect(
			await f.runtime.runOperation(() =>
				f.client.prisma.plexCache.findUnique({
					where: { id: "synthetic-cache" },
					select: { watchCount: true },
				}),
			),
		).toEqual({ watchCount: 3 });
		await f.runtime.runOperation(() =>
			withCurrentProviderPublicationAuthority(f.client.prisma, f.authority, async (tx) =>
				tx.plexCache.updateMany({ where: { id: "synthetic-cache" }, data: { watchCount: 4 } }),
			),
		);
		expect(f.applications.size).toBe(1);
		await f.client.close();
		expect([...f.applications].every((db) => !db.open)).toBe(true);
		let callbacks = 0;
		await expect(
			f.runtime.runOperation(() =>
				withCurrentProviderPublicationAuthority(
					f.client.prisma,
					f.authority,
					async () => ++callbacks,
				),
			),
		).rejects.toMatchObject({ statusCode: 503 });
		expect(callbacks).toBe(0);
		expect(f.losses).toEqual([]);
	});

	// Moving the writer must not weaken rollback or leave its companion unusable.
	it("rolls back a failed publication and reuses its companion for the next attempt", async () => {
		const f = await createScopedWriteFixture();
		interceptScopedWriteCompetition(f);
		const sentinel = new Error("Synthetic publication rejected");
		await expect(
			f.runtime.runOperation(() =>
				withCurrentProviderPublicationAuthority(f.client.prisma, f.authority, async (tx) => {
					await tx.plexCache.updateMany({
						where: { id: "synthetic-cache" },
						data: { watchCount: 9 },
					});
					throw sentinel;
				}),
			),
		).rejects.toBe(sentinel);
		expect(
			await f.runtime.runOperation(() =>
				f.client.prisma.plexCache.findUnique({
					where: { id: "synthetic-cache" },
					select: { watchCount: true },
				}),
			),
		).toEqual({ watchCount: 0 });
		await f.runtime.runOperation(() =>
			withCurrentProviderPublicationAuthority(f.client.prisma, f.authority, async (tx) =>
				tx.plexCache.updateMany({ where: { id: "synthetic-cache" }, data: { watchCount: 2 } }),
			),
		);
		expect(
			f.writer.prepare("SELECT watchCount FROM plex_cache WHERE id='synthetic-cache'").get(),
		).toEqual({ watchCount: 2 });
		expect(f.applications.size).toBe(1);
		expect(f.losses).toEqual([]);
	});

	// Restore/shutdown must still join the real accepted publisher before native
	// clients or the owner can be released; a second connection is not a bypass.
	it("joins admitted publication during shutdown and closes the companion", async () => {
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
		const publication = f.runtime.runOperation(() =>
			withCurrentProviderPublicationAuthority(f.client.prisma, f.authority, async (tx) => {
				await tx.plexCache.updateMany({
					where: { id: "synthetic-cache" },
					data: { watchCount: 5 },
				});
				entered();
				await held;
				return 5;
			}),
		);
		let closing: Promise<void> | undefined;
		try {
			await enteredPromise;
			let closed = false;
			closing = f.runtime.close().then(() => {
				closed = true;
			});
			await turn();
			expect(closed).toBe(false);
			await expect(
				f.runtime.runOperation(() => f.client.prisma.$queryRaw`SELECT 1`),
			).rejects.toMatchObject({ statusCode: 503 });
		} finally {
			release();
			await publication;
			await closing;
		}
		expect(
			f.writer.prepare("SELECT watchCount FROM plex_cache WHERE id='synthetic-cache'").get(),
		).toEqual({ watchCount: 5 });
		expect([...f.applications].every((db) => !db.open)).toBe(true);
		expect(f.losses).toEqual([]);
	});

	// An accepted collection may reach its first publication only after shutdown
	// closes new admission. Isolation must not require minting a new client then.
	it("permits an already admitted operation to reach its first publication during drain", async () => {
		const f = await createScopedWriteFixture();
		let entered!: () => void;
		let release!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const work = f.runtime.runOperation(async () => {
			entered();
			await held;
			return withCurrentProviderPublicationAuthority(f.client.prisma, f.authority, async (tx) => {
				await tx.plexCache.updateMany({
					where: { id: "synthetic-cache" },
					data: { watchCount: 6 },
				});
				return 6;
			});
		});
		const outcome = work.then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		await enteredPromise;
		const closing = f.runtime.close();
		release();
		const observed = await outcome;
		await closing;
		expect(observed).toEqual({ value: { matched: true, value: 6 } });
		expect(
			f.writer.prepare("SELECT watchCount FROM plex_cache WHERE id='synthetic-cache'").get(),
		).toEqual({ watchCount: 6 });
		expect(f.losses).toEqual([]);
	});
});
