import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSeriesProgressRoutes as jellyfinProgress } from "../../../routes/jellyfin/series-progress-routes.js";
import { registerInsightsRoutes } from "../../../routes/library/insights-routes.js";
import { registerProviderInventoryRoutes } from "../../../routes/library/provider-inventory-routes.js";
import { registerSyncRoutes } from "../../../routes/library/sync-routes.js";
import { registerSeriesProgressRoutes as plexProgress } from "../../../routes/plex/series-progress-routes.js";
import { registerLibraryRoutes as quiLibrary } from "../../../routes/qui/library-routes.js";
import { registerLibraryEnrichmentRoutes as seerrEnrichment } from "../../../routes/seerr/library-enrichment-routes.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";

// Scheduler state is in memory; provider reads and all database guards remain real.
vi.mock("../../library-sync/index.js", () => ({
	getLibrarySyncScheduler: () => ({ isInstanceSyncing: () => false }),
}));

afterEach(closeScopedWriteFixtures);

describe("cached Library supporting GET admission", { timeout: 20_000 }, () => {
	it("serves committed owned display data without borrowing an ordinary publication transaction", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
		for (const [id, userId] of [
			["owned-arr", "synthetic-user"],
			["foreign-arr", "foreign-user"],
		] as const) {
			await f.plain.serviceInstance.create({
				data: {
					id,
					userId,
					service: "RADARR",
					label: id,
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: "synthetic-cipher",
					encryptionIv: "synthetic-iv",
				},
			});
		}
		const app = Fastify({ logger: false });
		app.decorate("prisma", f.client.prisma);
		app.addHook("onRequest", async (request) => {
			// Authentication's real entry point has its own signed-session regression.
			request.currentUser = { id: "synthetic-user" } as typeof request.currentUser;
		});
		await app.register(plexProgress, { prefix: "/plex-progress" });
		await app.register(jellyfinProgress, { prefix: "/jellyfin-progress" });
		await app.register(registerProviderInventoryRoutes);
		await app.register(registerSyncRoutes);
		await app.register(registerInsightsRoutes);
		await app.register(quiLibrary);
		await app.register(seerrEnrichment, { prefix: "/seerr-enrichment" });
		await app.ready();
		const urls = [
			"/plex-progress/?tmdbIds=1",
			"/jellyfin-progress/?tmdbIds=1",
			"/library/provider-inventory?instanceId=synthetic-plex&domain=library",
			"/library/sync/status",
			"/library/insights/disk-waste",
			"/library/insights/watched-monitored",
			"/library/insights/requested-unwatched",
			"/qui/library-seeding-summary",
			"/seerr-enrichment/foreign-arr?tmdbIds=1&types=movie",
		];
		const read = (url: string) =>
			f.runtime.runOperation(() =>
				app.inject(
					url === "/qui/library-seeding-summary"
						? {
								method: "POST",
								url,
								payload: { items: [{ arrInstanceId: "owned-arr", itemId: 1, itemType: "movie" }] },
							}
						: { method: "GET", url },
				),
			);
		let release = () => {};
		let publication: Promise<unknown> | undefined;
		try {
			for (const url of urls)
				expect((await read(url)).statusCode, url).toBe(
					url.startsWith("/seerr-enrichment/") ? 404 : 200,
				);
			let entered!: () => void;
			const enteredPromise = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const rollback = new Error("synthetic-support-read-rollback");
			publication = f.runtime
				.runOperation(() =>
					f.client.prisma.$transaction(
						async (tx) => {
							await tx.serviceInstance.updateMany({
								where: { userId: "synthetic-user" },
								data: { label: "Uncommitted", enabled: false },
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
			await enteredPromise;
			const responses = await Promise.all(urls.map(read));
			expect(responses.map((response, index) => [urls[index], response.statusCode])).toEqual(
				urls.map((url) => [url, url.startsWith("/seerr-enrichment/") ? 404 : 200]),
			);
			expect(responses[0]!.json()).toMatchObject({ configured: true });
			expect(responses[1]!.json()).toMatchObject({ configured: true });
			expect(responses[2]!.json()).toMatchObject({
				status: "unavailable",
				reason: "no-publication",
			});
			expect(responses[3]!.json().instances).toEqual([
				expect.objectContaining({ instanceId: "owned-arr", instanceName: "owned-arr" }),
			]);
			for (const response of responses) {
				expect(response.body).not.toContain("Uncommitted");
				if (response.statusCode === 200) expect(response.body).not.toContain("foreign-arr");
			}
			release();
			expect(await publication).toBe(rollback);
		} finally {
			release();
			await publication;
			await app.close();
		}
		expect(
			await f.plain.serviceInstance.findMany({
				where: { userId: "synthetic-user" },
				select: { enabled: true, label: true },
			}),
		).toEqual(
			expect.arrayContaining([expect.objectContaining({ enabled: true, label: "owned-arr" })]),
		);
		expect(f.losses).toEqual([]);
	});
});
