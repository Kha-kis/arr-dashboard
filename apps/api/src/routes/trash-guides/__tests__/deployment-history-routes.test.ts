import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deploymentHistoryRoutes } from "../deployment-history-routes.js";

const USER_ID = "user-1";
const HISTORY_ID = "history-1";

function deploymentHistory(overrides: Record<string, unknown> = {}) {
	return {
		id: HISTORY_ID,
		userId: USER_ID,
		status: "SUCCESS",
		rolledBack: false,
		undeployStatus: null,
		template: { userId: USER_ID },
		...overrides,
	};
}

describe("DELETE /history/:historyId", () => {
	let app: ReturnType<typeof Fastify>;
	let findFirst: ReturnType<typeof vi.fn>;
	let deleteHistory: ReturnType<typeof vi.fn>;
	let deleteManyHistory: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		findFirst = vi.fn().mockResolvedValue(deploymentHistory());
		deleteHistory = vi.fn().mockResolvedValue({});
		deleteManyHistory = vi.fn().mockResolvedValue({ count: 1 });
		app = Fastify();
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request: FastifyRequest) => {
			request.currentUser = { id: USER_ID } as never;
		});
		app.decorate("prisma", {
			templateDeploymentHistory: {
				findFirst,
				delete: deleteHistory,
				deleteMany: deleteManyHistory,
			},
		} as never);

		await app.register(deploymentHistoryRoutes, {
			prefix: "/api/trash-guides/deployment",
		});
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it.each(["IN_PROGRESS", "PARTIAL", "UNKNOWN"])(
		"rejects explicit non-COMPLETED undeploy status %s",
		async (undeployStatus) => {
			findFirst.mockResolvedValueOnce(deploymentHistory({ undeployStatus }));

			const response = await app.inject({
				method: "DELETE",
				url: `/api/trash-guides/deployment/history/${HISTORY_ID}`,
			});

			expect(response.statusCode).toBe(409);
			expect(response.json()).toEqual({
				statusCode: 409,
				error: "Conflict",
				message:
					"Complete or explicitly resolve the undeploy before deleting its deployment history.",
			});
			expect(deleteManyHistory).not.toHaveBeenCalled();
			expect(deleteHistory).not.toHaveBeenCalled();
		},
	);

	it("rejects legacy PARTIAL_UNDEPLOY history without terminal evidence", async () => {
		findFirst.mockResolvedValueOnce(
			deploymentHistory({ status: "PARTIAL_UNDEPLOY", undeployStatus: null }),
		);

		const response = await app.inject({
			method: "DELETE",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}`,
		});

		expect(response.statusCode).toBe(409);
		expect(deleteManyHistory).not.toHaveBeenCalled();
		expect(deleteHistory).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "ordinary deployment history",
			history: deploymentHistory(),
		},
		{
			name: "an explicitly completed undeploy",
			history: deploymentHistory({
				status: "PARTIAL_UNDEPLOY",
				undeployStatus: "COMPLETED",
			}),
		},
		{
			name: "legacy history already marked rolled back",
			history: deploymentHistory({ status: "PARTIAL_UNDEPLOY", rolledBack: true }),
		},
	])("deletes $name", async ({ history }) => {
		findFirst.mockResolvedValueOnce(history);

		const response = await app.inject({
			method: "DELETE",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}`,
		});

		expect(response.statusCode).toBe(200);
		expect(deleteManyHistory).toHaveBeenCalledTimes(1);
		expect(deleteHistory).not.toHaveBeenCalled();
	});

	it("rejects deletion when a concurrent undeploy claim wins the terminal-state CAS", async () => {
		deleteManyHistory.mockResolvedValueOnce({ count: 0 });

		const response = await app.inject({
			method: "DELETE",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}`,
		});

		expect(response.statusCode).toBe(409);
		expect(deleteManyHistory).toHaveBeenCalledWith({
			where: {
				id: HISTORY_ID,
				userId: USER_ID,
				OR: [
					{ rolledBack: true },
					{ undeployStatus: "COMPLETED" },
					{
						undeployStatus: null,
						NOT: { status: "PARTIAL_UNDEPLOY" },
					},
				],
			},
		});
		expect(deleteHistory).not.toHaveBeenCalled();
	});

	it("keeps ownership in the lookup and hides non-owned history", async () => {
		findFirst.mockResolvedValueOnce(null);

		const response = await app.inject({
			method: "DELETE",
			url: `/api/trash-guides/deployment/history/${HISTORY_ID}`,
		});

		expect(response.statusCode).toBe(404);
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: HISTORY_ID, userId: USER_ID } }),
		);
		expect(deleteManyHistory).not.toHaveBeenCalled();
		expect(deleteHistory).not.toHaveBeenCalled();
	});
});
