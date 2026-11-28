import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuthRoutes } from "../../../routes/auth.js";
import { registerLibraryRoutes } from "../../../routes/qui/library-routes.js";
import { registerServiceRoutes } from "../../../routes/services.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";

// Only the external qui reads are synthetic. Connection selection, SQL, user
// scoping, formatting, runtime tickets and rollback all use production code.
vi.mock("../../qui/client-factory.js", () => ({
	createQuiClient: (_app: unknown, instance: { id: string }) => ({
		getTrackerIcons: async () => ({
			[instance.id === "owned-qui" ? "owned.tracker.invalid" : "foreign.tracker.invalid"]:
				"https://icons.invalid/synthetic.svg",
		}),
		getTrackerCustomizations: async () => [],
	}),
}));

afterEach(closeScopedWriteFixtures);

describe("UI bootstrap committed read acquisition", { timeout: 20_000 }, () => {
	// Break caught: an unrelated ordinary transaction must neither strand these
	// four bootstrap reads on its connection nor expose its uncommitted deletion.
	it("serves setup, account, owned services and tracker metadata while the ordinary writer is held", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		await f.plain.user.update({
			where: { id: "synthetic-user" },
			data: {
				hashedPassword: "synthetic-password-hash",
				encryptedTmdbApiKey: "synthetic-tmdb-cipher",
				encryptedTraktAccessToken: "synthetic-trakt-cipher",
			},
		});
		await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
		for (const [id, userId] of [
			["foreign-qui", "foreign-user"],
			["owned-qui", "synthetic-user"],
		]) {
			await f.plain.serviceInstance.create({
				data: {
					id: id!,
					userId: userId!,
					service: "QUI",
					label: id!,
					baseUrl: "https://qui.invalid",
					encryptedApiKey: "synthetic-provider-cipher",
					encryptionIv: "synthetic-provider-iv",
				},
			});
		}
		const before = snapshotProtectedRows(f);
		const usersBefore = await f.plain.user.findMany({ orderBy: { id: "asc" } });
		const app = Fastify({ logger: false });
		app.decorate("prisma", f.client.prisma);
		app.decorate("config", { PASSWORD_POLICY: "relaxed" } as never);
		app.decorateRequest("currentUser", null);
		app.addHook("onRequest", async (request) => {
			request.currentUser = request.headers["x-test-anonymous"]
				? null
				: ({
						id: "synthetic-user",
						username: "synthetic-user",
						mustChangePassword: false,
						createdAt: new Date("2026-01-01T00:00:00.000Z"),
					} as typeof request.currentUser);
		});
		await app.register(registerAuthRoutes, { prefix: "/auth" });
		await app.register(registerServiceRoutes);
		registerLibraryRoutes(app);
		await app.ready();
		const read = (url: string) => f.runtime.runOperation(() => app.inject({ method: "GET", url }));
		const rollback = new Error("synthetic-ui-bootstrap-rollback");
		let release = () => {};
		let publication: Promise<unknown> | undefined;
		try {
			const anonymous = await f.runtime.runOperation(() =>
				app.inject({ method: "GET", url: "/auth/me", headers: { "x-test-anonymous": "true" } }),
			);
			expect(anonymous.statusCode).toBe(401);
			let entered!: () => void;
			const transactionEntered = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			publication = f.runtime
				.runOperation(() =>
					f.client.prisma.$transaction(
						async (tx) => {
							await tx.user.deleteMany();
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
			await Promise.race([
				transactionEntered,
				publication.then(() => {
					throw new Error("Ordinary transaction ended before holding its write");
				}),
			]);
			const responses = await Promise.all(
				["/auth/setup-required", "/auth/me", "/services", "/qui/tracker-icons"].map(read),
			);
			expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
			expect(responses[0]!.json()).toEqual({ required: false, passwordPolicy: "relaxed" });
			expect(responses[1]!.json().user).toMatchObject({
				id: "synthetic-user",
				hasPassword: true,
				hasTmdbApiKey: true,
				hasTraktAccessToken: true,
			});
			expect(
				responses[2]!
					.json()
					.services.map((service: { id: string }) => service.id)
					.sort(),
			).toEqual(["owned-qui", "synthetic-jellyfin", "synthetic-plex"]);
			expect(responses[3]!.json()).toEqual({
				trackers: { "owned.tracker.invalid": { iconUrl: "https://icons.invalid/synthetic.svg" } },
			});
			for (const response of responses)
				expect(response.body).not.toMatch(/foreign-|synthetic-.*(?:cipher|hash|iv)/);
		} finally {
			release();
			if (publication) expect(await publication).toBe(rollback);
			await app.close();
			expect(f.losses).toEqual([]);
			expect(snapshotProtectedRows(f)).toEqual(before);
			expect(await f.plain.user.findMany({ orderBy: { id: "asc" } })).toEqual(usersBefore);
		}
	});
});
