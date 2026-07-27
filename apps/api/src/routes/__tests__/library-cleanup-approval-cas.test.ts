import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executorMocks = vi.hoisted(() => ({
	buildEvalContext: vi.fn(),
	executeApprovedItems: vi.fn().mockResolvedValue({ removed: 1, failed: 0, errors: [] }),
	executeCleanupPreview: vi.fn(),
	executeCleanupRun: vi.fn(),
}));

vi.mock("../../lib/library-cleanup/cleanup-executor.js", () => executorMocks);

import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

describe("library cleanup approval compare-and-set routes", () => {
	let app: ReturnType<typeof Fastify>;
	let status: "pending" | "approved";
	let updateMany: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		status = "pending";
		updateMany = vi.fn(
			async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
				if (where.status !== status) return { count: 0 };
				status = data.status as typeof status;
				return { count: 1 };
			},
		);

		app = Fastify();
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {
			libraryCleanupApproval: { updateMany },
		} as never);
		app.decorate("arrClientFactory", {} as never);
		app.decorate("encryptor", {} as never);
		await app.register(registerLibraryCleanupRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("allows only one concurrent request to transition and execute a pending approval", async () => {
		const inject = createInjectAuthenticated(app);
		const [first, second] = await Promise.all([
			inject("POST", "/library-cleanup/approval-queue/approval-1/approve"),
			inject("POST", "/library-cleanup/approval-queue/approval-1/approve"),
		]);

		expect([first.statusCode, second.statusCode].sort()).toEqual([200, 404]);
		expect(executorMocks.executeApprovedItems).toHaveBeenCalledOnce();
		expect(updateMany).toHaveBeenCalledTimes(2);
	});

	it("does not transition expired approvals during bulk approval", async () => {
		const inject = createInjectAuthenticated(app);

		const response = await inject("POST", "/library-cleanup/approval-queue/bulk", {
			body: { ids: ["approval-1"], action: "approved" },
		});

		expect(response.statusCode).toBe(200);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["approval-1"] },
				config: { userId: "user-1" },
				status: "pending",
				expiresAt: { gt: expect.any(Date) },
			},
			data: { status: "approved", reviewedAt: expect.any(Date) },
		});
	});
});
