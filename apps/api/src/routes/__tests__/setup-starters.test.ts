import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSetupRoutes } from "../setup";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers";

const prisma = {
	serviceInstance: { findMany: vi.fn() },
	notificationRule: { findFirst: vi.fn(), create: vi.fn() },
	autoTagRule: { findFirst: vi.fn(), create: vi.fn() },
	labelSyncRule: { findFirst: vi.fn(), create: vi.fn() },
	$transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
};

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();
	prisma.serviceInstance.findMany.mockResolvedValue([
		{
			id: "sonarr-1",
			service: "SONARR",
			label: "Primary Sonarr",
			isDefault: true,
			createdAt: new Date("2026-01-01"),
		},
		{
			id: "plex-1",
			service: "PLEX",
			label: "Primary Plex",
			isDefault: true,
			createdAt: new Date("2026-01-01"),
		},
	]);
	prisma.notificationRule.findFirst.mockResolvedValue(null);
	prisma.autoTagRule.findFirst.mockResolvedValue(null);
	prisma.labelSyncRule.findFirst.mockResolvedValue(null);
	prisma.notificationRule.create.mockResolvedValue({ id: "notification-1" });
	prisma.autoTagRule.create.mockResolvedValue({ id: "auto-tag-1" });
	prisma.labelSyncRule.create.mockResolvedValue({ id: "label-sync-1" });

	app = Fastify({ logger: false });
	setupAuthInjection(app);
	app.decorate("prisma", prisma as any);
	registerTestErrorHandler(app);
	await app.register(registerSetupRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => app.close());

describe("Setup starter configuration", () => {
	it("previews starter availability using only the current user's services and rules", async () => {
		const response = await injectAuthenticated("GET", "/setup/starters");

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			starters: [
				{ id: "notification-throttle", available: true, existing: false },
				{
					id: "auto-tag-recent",
					available: true,
					source: { id: "sonarr-1", service: "sonarr" },
				},
				{
					id: "label-sync-recent",
					available: true,
					destination: { id: "plex-1", service: "plex" },
				},
			],
		});
		expect(prisma.serviceInstance.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ userId: "user-1" }) }),
		);
		expect(prisma.notificationRule.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ userId: "user-1" }) }),
		);
	});

	it("atomically creates only selected starters in a disabled state", async () => {
		const response = await injectAuthenticated("POST", "/setup/starters", {
			body: {
				starterIds: ["notification-throttle", "auto-tag-recent", "label-sync-recent"],
			},
		});

		expect(response.statusCode).toBe(201);
		expect(JSON.parse(response.payload)).toEqual({
			created: ["notification-throttle", "auto-tag-recent", "label-sync-recent"],
			existing: [],
		});
		expect(prisma.notificationRule.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ userId: "user-1", enabled: false }),
			}),
		);
		expect(prisma.autoTagRule.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					userId: "user-1",
					enabled: false,
					instanceFilter: '["sonarr-1"]',
				}),
			}),
		);
		expect(prisma.labelSyncRule.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					userId: "user-1",
					enabled: false,
					sourceInstanceId: "sonarr-1",
					destInstanceId: "plex-1",
				}),
			}),
		);
		expect(prisma.$transaction).toHaveBeenCalledOnce();
	});

	it("treats matching starters as existing instead of duplicating them", async () => {
		prisma.notificationRule.findFirst.mockResolvedValue({ id: "existing-1" });

		const response = await injectAuthenticated("POST", "/setup/starters", {
			body: { starterIds: ["notification-throttle"] },
		});

		expect(response.statusCode).toBe(201);
		expect(JSON.parse(response.payload)).toEqual({
			created: [],
			existing: ["notification-throttle"],
		});
		expect(prisma.notificationRule.create).not.toHaveBeenCalled();
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("rejects topology-dependent starters when their services are unavailable", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([]);

		const response = await injectAuthenticated("POST", "/setup/starters", {
			body: { starterIds: ["label-sync-recent"] },
		});

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.payload)).toMatchObject({ error: "Starter unavailable" });
		expect(prisma.labelSyncRule.create).not.toHaveBeenCalled();
	});
});
