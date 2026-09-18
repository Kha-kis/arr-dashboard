import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeOnTautulliInstances: vi.fn() }));

vi.mock("../../../lib/tautulli/tautulli-helpers.js", () => ({
	executeOnTautulliInstances: mocks.executeOnTautulliInstances,
}));

import { registerActivityRoutes } from "../activity-routes.js";

describe("Tautulli activity authority", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		mocks.executeOnTautulliInstances.mockReset();
		app = Fastify({ logger: false });
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([{ id: "tautulli-1" }]),
			},
		} as never);
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: "user-1" } as never;
		});
		await app.register(registerActivityRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("does not retain counters from an operation rejected by the post-call authority check", async () => {
		mocks.executeOnTautulliInstances.mockImplementation(
			async (
				_app,
				_userId,
				operation: (client: unknown, instance: unknown) => Promise<unknown>,
			) => {
				await operation(
					{
						getActivity: vi.fn().mockResolvedValue({
							stream_count: "3",
							total_bandwidth: 3000,
							lan_bandwidth: 2000,
							wan_bandwidth: 1000,
							sessions: [],
						}),
					},
					{ id: "tautulli-1", label: "Tautulli" },
				);
				return { instances: [], aggregated: [], totalCount: 0, errorCount: 0 };
			},
		);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			error: "Tautulli activity is unavailable",
			availability: {
				status: "unavailable",
				configuredSources: 1,
				availableSources: 0,
			},
		});
	});
});
