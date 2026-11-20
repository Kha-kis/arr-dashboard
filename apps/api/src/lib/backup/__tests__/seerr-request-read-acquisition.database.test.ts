import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRequestRoutes } from "../../../routes/seerr/request-routes.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { ArrClientFactory } from "../../arr/client-factory.js";
import { Encryptor } from "../../auth/encryption.js";
import { withIsolatedRuntimePrismaReadClient } from "../restore-runtime-client.js";

afterEach(async () => {
	vi.unstubAllGlobals();
	await closeScopedWriteFixtures();
});

describe("Seerr request GET instance selection", { timeout: 20_000 }, () => {
	// Break caught: GET selection must use committed ownership/service data while
	// an ordinary transaction is held, and release its lane before provider I/O.
	it("serves all four reads and rejects foreign/wrong-service instances without retaining provider lanes", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		const encryptor = new Encryptor("9".repeat(64));
		const encrypted = encryptor.encrypt("synthetic-only-seerr-token");
		const instanceData = {
			userId: "synthetic-user",
			service: "SEERR" as const,
			label: "Committed Seerr",
			baseUrl: "http://synthetic.invalid",
			encryptedApiKey: encrypted.value,
			encryptionIv: encrypted.iv,
		};
		await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
		await f.plain.serviceInstance.createMany({
			data: [
				{ ...instanceData, id: "owned-seerr", enabled: false },
				{ ...instanceData, id: "foreign-seerr", userId: "foreign-user" },
				{ ...instanceData, id: "wrong-service", service: "RADARR" },
			],
		});
		const timestamp = "2026-01-01T00:00:00.000Z";
		const providerRequest = {
			id: 7,
			status: 4,
			type: "movie",
			is4k: false,
			createdAt: timestamp,
			updatedAt: timestamp,
			media: {
				id: 1,
				tmdbId: 123,
				mediaType: "movie",
				status: 1,
				createdAt: timestamp,
				updatedAt: timestamp,
			},
			requestedBy: {
				id: 1,
				displayName: "Synthetic",
				createdAt: timestamp,
				updatedAt: timestamp,
				permissions: 0,
				requestCount: 1,
				userType: 1,
			},
		};
		const counts = {
			total: 27,
			movie: 27,
			tv: 0,
			pending: 0,
			approved: 0,
			declined: 0,
			processing: 0,
			available: 0,
		};
		let releaseProvider = () => {};
		const heldProvider = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		let providerEntered!: () => void;
		const allProvidersEntered = new Promise<void>((resolve) => {
			providerEntered = resolve;
		});
		const providerPaths: string[] = [];
		const app = Fastify({ logger: false });
		app.decorate("prisma", f.client.prisma);
		const factory = new ArrClientFactory(encryptor);
		app.decorate("arrClientFactory", factory);
		vi.spyOn(factory, "rawRequest").mockImplementation(async (instance, path, options) => {
			// Only the external transport is synthetic; selection, client parsing,
			// route response construction and database guards remain real.
			expect(instance).toMatchObject({
				id: "owned-seerr",
				userId: "synthetic-user",
				service: "SEERR",
				label: "Committed Seerr",
				enabled: false,
			});
			expect(options?.method).toBe("GET");
			providerPaths.push(path);
			if (providerPaths.length === 4) providerEntered();
			await heldProvider;
			if (path === "/api/v1/request/count") return Response.json(counts);
			if (path === "/api/v1/request/7") return Response.json(providerRequest);
			if (path === "/api/v1/movie/123") {
				return Response.json({ title: "Synthetic title", posterPath: "/synthetic.jpg" });
			}
			if (path.startsWith("/api/v1/request?")) {
				return Response.json({
					pageInfo: { pages: 3, pageSize: 10, results: 27, page: 1 },
					results: [providerRequest],
				});
			}
			throw new Error("Unexpected synthetic provider path");
		});
		vi.stubGlobal("fetch", () => {
			throw new Error("Unexpected provider network request");
		});
		app.addHook("onRequest", async (request) => {
			request.currentUser = { id: "synthetic-user" } as typeof request.currentUser;
		});
		await app.register(registerRequestRoutes, { prefix: "/requests" });
		await app.ready();
		const read = (instanceId: string, suffix: string) =>
			f.runtime.runOperation(() => app.inject(`/requests/${instanceId}${suffix}`));
		let releaseTransaction = () => {};
		let releaseProbes = () => {};
		let publication: Promise<unknown> | undefined;
		let responses: Promise<Awaited<ReturnType<typeof read>>[]> | undefined;
		let probes: Promise<number[]> | undefined;
		try {
			let entered!: () => void;
			const transactionEntered = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const heldTransaction = new Promise<void>((resolve) => {
				releaseTransaction = resolve;
			});
			const rollback = new Error("synthetic-seerr-selection-rollback");
			publication = f.runtime
				.runOperation(() =>
					f.client.prisma.$transaction(
						async (tx) => {
							await tx.serviceInstance.update({
								where: { id: "owned-seerr" },
								data: { userId: "foreign-user", service: "RADARR", label: "Uncommitted" },
							});
							await tx.serviceInstance.update({
								where: { id: "foreign-seerr" },
								data: { userId: "synthetic-user" },
							});
							await tx.serviceInstance.update({
								where: { id: "wrong-service" },
								data: { service: "SEERR" },
							});
							entered();
							await heldTransaction;
							throw rollback;
						},
						{ timeout: 15_000 },
					),
				)
				.then(
					() => null,
					(error: unknown) => error,
				);
			await transactionEntered;
			const suffixes = ["", "/count", "/attention", "/7"];
			responses = Promise.all(suffixes.map((suffix) => read("owned-seerr", suffix)));
			const enteredProviderWork = await Promise.race([
				allProvidersEntered.then(() => true),
				responses.then((results) => results.map((response) => response.statusCode)),
			]);
			expect(enteredProviderWork).toBe(true);
			// All four GETs still await their provider responses. Acquire and hold
			// all four lanes concurrently so even one retained GET lease fails.
			let enteredProbes = 0;
			let probesEntered!: () => void;
			const allProbesEntered = new Promise<void>((resolve) => {
				probesEntered = resolve;
			});
			const heldProbes = new Promise<void>((resolve) => {
				releaseProbes = resolve;
			});
			probes = Promise.all(
				Array.from({ length: 4 }, () =>
					f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(f.client.prisma, async (reader) => {
							const count = await reader.serviceInstance.count({
								where: { id: "owned-seerr", userId: "synthetic-user" },
							});
							if (++enteredProbes === 4) probesEntered();
							await heldProbes;
							return count;
						}),
					),
				),
			);
			await Promise.race([allProbesEntered, probes]);
			releaseProbes();
			expect(await probes).toEqual([1, 1, 1, 1]);
			for (const suffix of suffixes) {
				expect((await read("foreign-seerr", suffix)).statusCode).toBe(404);
				expect((await read("wrong-service", suffix)).statusCode).toBe(400);
			}
			releaseProvider();
			const completed = await responses;
			expect(completed.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
			expect(completed[0]!.json()).toMatchObject({
				pageInfo: { results: 27 },
				results: [{ id: 7, media: { title: "Synthetic title", posterPath: "/synthetic.jpg" } }],
			});
			expect(completed[1]!.json()).toEqual(counts);
			expect(completed[2]!.json()).toMatchObject({
				total: 27,
				items: [{ reason: "failed", request: { id: 7, media: { title: "Synthetic title" } } }],
			});
			expect(completed[2]!.json().items[0].ageMs).toBeGreaterThan(0);
			expect(completed[3]!.json()).toMatchObject({ id: 7, media: { title: "Synthetic title" } });
			expect(providerPaths).toHaveLength(7);
			expect(providerPaths).toContain("/api/v1/request?take=20&skip=0&filter=all&sort=added");
			expect(providerPaths).toContain("/api/v1/request?filter=failed&take=10&sort=modified");
			releaseTransaction();
			expect(await publication).toBe(rollback);
			expect(f.losses).toEqual([]);
		} finally {
			releaseProbes();
			releaseProvider();
			releaseTransaction();
			await probes?.catch(() => {});
			await responses;
			await publication;
			await app.close();
		}
	});
});
