import { SonarrClient } from "arr-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueRoutes } from "../queue-routes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("registered queue GET with real instance execution and projection", () => {
	it.each([
		{ reads: [false, false], populated: false },
		{ reads: [true, false], populated: true },
		{ reads: [true, false], populated: false },
		{ reads: [true, true], populated: false },
		{ reads: [], populated: false },
	])("preserves read evidence and successful data %#", async ({ reads, populated }) => {
		const clients = reads.map((success, index) => {
			const client = new SonarrClient({ baseUrl: "http://synthetic.invalid", apiKey: "synthetic" });
			vi.spyOn(client.queue, "get").mockImplementation(async () => {
				if (!success) throw new Error("private upstream URL credential diagnostic");
				return {
					records:
						populated && index === 0
							? [{ id: 31, title: "Synthetic returned item", status: "downloading" }]
							: [],
				} as Awaited<ReturnType<typeof client.queue.get>>;
			});
			return client;
		});
		const app = Fastify({ logger: false });
		apps.push(app);
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: "fixture-owner" } as typeof request.currentUser;
		});
		app.decorate("prisma", {
			serviceInstance: {
				findMany: async ({ where }: { where: unknown }) => {
					expect(where).toEqual({
						userId: "fixture-owner",
						enabled: true,
						service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
					});
					return reads.map((_, index) => ({
						id: String(index),
						label: "Synthetic",
						service: "SONARR",
						enabled: true,
						userId: "fixture-owner",
					}));
				},
			},
		} as unknown as FastifyInstance["prisma"]);
		app.decorate("arrClientFactory", {
			create: ({ id }: { id: string }) => clients[Number(id)],
		} as unknown as FastifyInstance["arrClientFactory"]);
		app.register(queueRoutes, { prefix: "/api" });
		const response = await app.inject({ method: "GET", url: "/api/dashboard/queue" });
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.instances.map((instance: { success?: boolean }) => instance.success)).toEqual(
			reads,
		);
		expect(body.aggregated).toHaveLength(populated ? 1 : 0);
		expect(body.totalCount).toBe(populated ? 1 : 0);
		if (populated)
			expect(body.aggregated[0]).toMatchObject({
				id: 31,
				instanceId: "0",
				title: "Synthetic returned item",
			});
		for (const [index, success] of reads.entries()) {
			expect(body.instances[index].data).toHaveLength(success && populated && index === 0 ? 1 : 0);
			expect(body.instances[index]).not.toHaveProperty("error");
		}
		expect(response.body).not.toContain("private upstream");
		for (const client of clients)
			expect(client.queue.get).toHaveBeenCalledWith({
				pageSize: 1000,
				includeUnknownSeriesItems: true,
			});
	});
});
