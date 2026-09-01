import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeOnInstances } from "../../lib/arr/client-helpers.js";
import { HISTORY_UNAVAILABLE_MESSAGE, historyRoutes } from "./history-routes.js";

vi.mock("../../lib/arr/client-helpers.js", () => ({
	executeOnInstances: vi.fn(),
	isSonarrClient: vi.fn(),
	isRadarrClient: vi.fn(),
	isProwlarrClient: vi.fn(),
	isLidarrClient: vi.fn(),
	isReadarrClient: vi.fn(),
}));

describe("History route containment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("fails closed before discovering or calling providers", async () => {
		const app = Fastify();
		app.decorateRequest("currentUser", null);
		app.decorateRequest("sessionToken", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = {
				id: "history-user",
				username: "history",
				mustChangePassword: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			};
		});
		await app.register(historyRoutes);

		try {
			const response = await app.inject({
				method: "GET",
				url: "/dashboard/history",
			});

			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({ error: HISTORY_UNAVAILABLE_MESSAGE });
			expect(executeOnInstances).not.toHaveBeenCalled();
		} finally {
			await app.close();
		}
	});
});
