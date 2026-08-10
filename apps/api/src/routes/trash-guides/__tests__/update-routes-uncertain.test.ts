import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	processAutoUpdates: vi.fn(),
}));

vi.mock("../../../lib/trash-guides/cache-manager.js", () => ({
	createCacheManager: vi.fn(() => ({})),
}));
vi.mock("../../../lib/trash-guides/github-fetcher.js", () => ({
	createTrashFetcher: vi.fn(() => ({})),
}));
vi.mock("../../../lib/trash-guides/repo-config.js", () => ({
	getRepoConfig: vi.fn(async () => ({})),
}));
vi.mock("../../../lib/trash-guides/version-tracker.js", () => ({
	createVersionTracker: vi.fn(() => ({})),
}));
vi.mock("../../../lib/trash-guides/template-updater.js", () => ({
	createTemplateUpdater: vi.fn(() => ({ processAutoUpdates: mocks.processAutoUpdates })),
}));

import { registerUpdateRoutes } from "../update-routes.js";

describe("manual automatic-update uncertainty", () => {
	let app: FastifyInstance | undefined;
	const notify = vi.fn();

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.processAutoUpdates.mockResolvedValue({
			processed: 1,
			successful: 0,
			failed: 0,
			uncertain: 1,
			uncertainDeployments: [
				{
					endpointKey: "user-1:RADARR:credential-1",
					instanceId: "instance-1",
					instanceLabel: "Radarr",
					errors: ["ARR write could not be verified"],
				},
			],
			results: [{ templateId: "template-1", success: false }],
		});
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {} as never);
		app.decorate("deploymentExecutor", {} as never);
		app.decorate("notificationService", { notify } as never);
		await app.register(registerUpdateRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app?.close();
		app = undefined;
	});

	it("returns the uncertain automation result when notification delivery fails", async () => {
		notify.mockRejectedValue(new Error("notification database unavailable"));

		const response = await createInjectAuthenticated(app!)("POST", "/process-auto");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			data: { summary: { processed: 1, failed: 0, uncertain: 1 } },
		});
		expect(notify).toHaveBeenCalledOnce();
	});
});
