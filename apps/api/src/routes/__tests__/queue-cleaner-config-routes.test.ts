import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInstance: vi.fn(),
}));

vi.mock("../../lib/arr/instance-helpers.js", () => ({
	requireInstance: mocks.requireInstance,
}));

vi.mock("../../lib/queue-cleaner/scheduler.js", () => ({
	getQueueCleanerScheduler: vi.fn(),
}));

import { registerQueueCleanerRoutes } from "../queue-cleaner.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const instance = {
	id: "arr-1",
	userId: "user-1",
	service: "SONARR",
	label: "Sonarr",
};

function makeConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "config-1",
		instanceId: instance.id,
		fileExtensionAllowlistEnabled: false,
		allowedFileExtensions: null,
		removeFromClient: true,
		addToBlocklist: true,
		changeCategoryEnabled: false,
		lastRunAt: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

describe("Queue Cleaner config routes", () => {
	let app: ReturnType<typeof Fastify>;
	let prisma: {
		queueCleanerConfig: {
			update: ReturnType<typeof vi.fn>;
		};
	};
	let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

	beforeEach(async () => {
		vi.clearAllMocks();
		const existingConfig = makeConfig();
		mocks.requireInstance.mockResolvedValue({
			...instance,
			queueCleanerConfig: existingConfig,
		});

		prisma = {
			queueCleanerConfig: {
				update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
					...existingConfig,
					...data,
					instance,
					updatedAt: new Date("2026-01-02T00:00:00Z"),
				})),
			},
		};

		app = Fastify();
		app.decorate("prisma", prisma as never);
		app.decorate("queueCleanerEnabled", true);
		app.decorate("queueCleanerInitError", null);
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		await app.register(registerQueueCleanerRoutes);
		await app.ready();
		injectAuthenticated = createInjectAuthenticated(app);
	});

	afterEach(async () => {
		await app.close();
	});

	it("canonicalizes an allowlist while enabling the policy", async () => {
		const response = await injectAuthenticated("PATCH", "/queue-cleaner/configs/arr-1", {
			body: {
				fileExtensionAllowlistEnabled: true,
				allowedFileExtensions: '[".MKV","srt","mkv"]',
			},
		});

		expect(response.statusCode).toBe(200);
		expect(mocks.requireInstance).toHaveBeenCalledWith(expect.anything(), "user-1", "arr-1", {
			queueCleanerConfig: true,
		});
		expect(prisma.queueCleanerConfig.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { instanceId: "arr-1" },
				data: {
					fileExtensionAllowlistEnabled: true,
					allowedFileExtensions: '["mkv","srt"]',
				},
			}),
		);
	});

	it("rejects enabling the policy without any allowed extension", async () => {
		const response = await injectAuthenticated("PATCH", "/queue-cleaner/configs/arr-1", {
			body: {
				fileExtensionAllowlistEnabled: true,
				allowedFileExtensions: null,
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error).toContain("at least one");
		expect(prisma.queueCleanerConfig.update).not.toHaveBeenCalled();
	});

	it("rejects path, glob, and compound-extension syntax", async () => {
		for (const allowedFileExtensions of ['["../mkv"]', '["m*"]', '["mkv.exe"]']) {
			const response = await injectAuthenticated("PATCH", "/queue-cleaner/configs/arr-1", {
				body: { allowedFileExtensions },
			});
			expect(response.statusCode).toBe(400);
		}
		expect(prisma.queueCleanerConfig.update).not.toHaveBeenCalled();
	});

	it("allows a corrupted legacy policy to be disabled without parsing its old value", async () => {
		const existingConfig = makeConfig({
			fileExtensionAllowlistEnabled: true,
			allowedFileExtensions: "not-json",
		});
		mocks.requireInstance.mockResolvedValue({
			...instance,
			queueCleanerConfig: existingConfig,
		});

		const response = await injectAuthenticated("PATCH", "/queue-cleaner/configs/arr-1", {
			body: { fileExtensionAllowlistEnabled: false },
		});

		expect(response.statusCode).toBe(200);
		expect(prisma.queueCleanerConfig.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { fileExtensionAllowlistEnabled: false },
			}),
		);
	});

	it("rejects retaining and recategorizing torrents without blocklisting", async () => {
		const response = await injectAuthenticated("PATCH", "/queue-cleaner/configs/arr-1", {
			body: {
				removeFromClient: false,
				addToBlocklist: false,
				changeCategoryEnabled: true,
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error).toContain("blocklist");
		expect(prisma.queueCleanerConfig.update).not.toHaveBeenCalled();
	});

	it("rejects a partial update that makes an existing retained-torrent policy unsafe", async () => {
		const existingConfig = makeConfig({
			removeFromClient: false,
			addToBlocklist: false,
			changeCategoryEnabled: false,
		});
		mocks.requireInstance.mockResolvedValue({
			...instance,
			queueCleanerConfig: existingConfig,
		});

		const response = await injectAuthenticated("PATCH", "/queue-cleaner/configs/arr-1", {
			body: { changeCategoryEnabled: true },
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error).toContain("blocklist");
		expect(prisma.queueCleanerConfig.update).not.toHaveBeenCalled();
	});

	it("allows retaining and recategorizing torrents when blocklisting is enabled", async () => {
		const response = await injectAuthenticated("PATCH", "/queue-cleaner/configs/arr-1", {
			body: {
				removeFromClient: false,
				addToBlocklist: true,
				changeCategoryEnabled: true,
			},
		});

		expect(response.statusCode).toBe(200);
		expect(prisma.queueCleanerConfig.update).toHaveBeenCalled();
	});
});
