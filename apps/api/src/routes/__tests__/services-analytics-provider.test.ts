import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schedulerRegistryPlugin from "../../plugins/scheduler-registry.js";
import { registerServiceRoutes } from "../services.js";
import { registerSystemRoutes } from "../system.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

type ProviderService = "TRACEARR" | "TAUTULLI";
type InstanceRow = {
	id: string;
	userId: string;
	service: ProviderService;
	enabled: boolean;
	label: string;
	baseUrl: string;
	externalUrl: null;
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials: null;
	httpAuthEncryptionIv: null;
	isDefault: boolean;
	storageGroupId: null;
	hasLocalFilesystemAccess: boolean;
	pathPrefix: null;
	createdAt: Date;
	updatedAt: Date;
	connectionGeneration: number;
};

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let instances: InstanceRow[];
let settings: { analyticsProvider: "tracearr" | "tautulli"; analyticsProviderSource: "explicit" };

function makeInstance(id: string, service: ProviderService, enabled = true): InstanceRow {
	return {
		id,
		userId: "user-1",
		service,
		enabled,
		label: `${service} private label`,
		baseUrl: `https://${service.toLowerCase()}.example.test`,
		externalUrl: null,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		isDefault: false,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		createdAt: new Date("2026-08-12T00:00:00.000Z"),
		updatedAt: new Date("2026-08-12T00:00:00.000Z"),
		connectionGeneration: 0,
	};
}

function createPrisma() {
	const serviceInstance = {
		count: vi.fn(
			async ({ where }: any) =>
				instances.filter(
					(instance) =>
						instance.userId === where.userId &&
						instance.service === where.service &&
						(where.enabled === undefined || instance.enabled === where.enabled),
				).length,
		),
		findFirst: vi.fn(async ({ where }: any) => {
			const instance = instances.find((row) => row.id === where.id && row.userId === where.userId);
			return instance ? { ...instance, tags: [] } : null;
		}),
		updateMany: vi.fn(async ({ where, data }: any) => {
			let count = 0;
			for (const instance of instances) {
				if (where.id && instance.id !== where.id) continue;
				if (where.userId && instance.userId !== where.userId) continue;
				if (where.service && instance.service !== where.service) continue;
				if (where.NOT?.id && instance.id === where.NOT.id) continue;
				Object.assign(instance, data);
				if (data.connectionGeneration?.increment) {
					instance.connectionGeneration += data.connectionGeneration.increment;
				}
				count++;
			}
			return { count };
		}),
		delete: vi.fn(async ({ where }: any) => {
			const index = instances.findIndex(
				(instance) => instance.id === where.id && instance.userId === where.userId,
			);
			if (index === -1) throw new Error("not found");
			return instances.splice(index, 1)[0];
		}),
		findMany: vi.fn(async () => instances.map((instance) => ({ ...instance, tags: [] }))),
	};
	const prisma = {
		serviceInstance,
		systemSettings: {
			findUnique: vi.fn(async () => ({ ...settings })),
			upsert: vi.fn(async ({ create, update }: any) => {
				settings = {
					analyticsProvider: update.analyticsProvider ?? create.analyticsProvider,
					analyticsProviderSource: update.analyticsProviderSource ?? create.analyticsProviderSource,
				};
				return { ...settings };
			}),
		},
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-user-1" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		plexCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		plexEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		jellyfinCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		jellyfinEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		tautulliCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		cacheRefreshStatus: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			upsert: vi.fn().mockResolvedValue({}),
		},
		serviceTag: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn() },
		serviceInstanceTag: {
			findFirst: vi.fn().mockResolvedValue(null),
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
	};
	return {
		...prisma,
		$transaction: vi.fn(async (callback: (transaction: typeof prisma) => unknown) =>
			callback(prisma),
		),
	};
}

beforeEach(async () => {
	instances = [makeInstance("tautulli-1", "TAUTULLI"), makeInstance("tracearr-1", "TRACEARR")];
	settings = { analyticsProvider: "tautulli", analyticsProviderSource: "explicit" };
	app = Fastify();
	app.decorate("prisma", createPrisma() as never);
	app.decorate("encryptor", { encrypt: vi.fn(() => ({ value: "encrypted", iv: "iv" })) } as never);
	app.decorate("notificationService", { notify: vi.fn() } as never);
	app.decorate("config", {
		TRUST_PROXY: false,
		COOKIE_SECURE: false,
		DATABASE_URL: "file:./test.db",
	} as never);
	app.decorate("dbProvider", "sqlite" as never);
	app.decorate("lifecycle", { getRestartMessage: () => "ok", restart: vi.fn() } as never);
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	await app.register(schedulerRegistryPlugin);
	await app.register(registerServiceRoutes);
	await app.register(registerSystemRoutes, { prefix: "/system" });
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

describe("selected analytics-provider lifecycle guard", () => {
	it.each([
		["disabling", "PUT", "/services/tautulli-1", { enabled: false }],
		["changing type", "PUT", "/services/tautulli-1", { service: "tracearr" }],
		["deleting", "DELETE", "/services/tautulli-1", undefined],
	] as const)(
		"requires confirmation before %s the last enabled selected-family instance",
		async (_operation, method, url, body) => {
			const blocked = await injectAuthenticated(method, url, body === undefined ? {} : { body });

			expect(blocked.statusCode).toBe(409);
			expect(blocked.json()).toEqual({
				code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
				selected: "tautulli",
				alternativeEnabled: true,
			});
			expect((app as any).prisma.serviceInstance.delete).not.toHaveBeenCalled();
			expect(blocked.payload).not.toContain("private label");
			expect(blocked.payload).not.toContain("example.test");
		},
	);

	it("permits a confirmed deletion without silently switching the selected family", async () => {
		const deleted = await app.inject({
			method: "DELETE",
			url: "/services/tautulli-1?confirmAnalyticsUnavailable=true",
			headers: { "x-test-auth": "1" },
		});

		expect(deleted.statusCode).toBe(204);
		expect((app as any).prisma.serviceInstance.delete).toHaveBeenCalledTimes(1);
		const selection = await injectAuthenticated("GET", "/system/analytics-provider");
		expect(selection.statusCode).toBe(200);
		expect(selection.json()).toMatchObject({
			selected: "tautulli",
			source: "explicit",
			status: "unconfigured",
		});
	});

	it("rejects a malformed deletion confirmation without deleting the service", async () => {
		const response = await app.inject({
			method: "DELETE",
			url: "/services/tautulli-1?confirmAnalyticsUnavailable=invalid",
			headers: { "x-test-auth": "1" },
		});

		expect(response.statusCode).toBe(400);
		expect((app as any).prisma.serviceInstance.delete).not.toHaveBeenCalled();
		expect(instances.find((instance) => instance.id === "tautulli-1")).toBeDefined();
	});

	it("permits a confirmed selected-family update without persisting metadata or switching selection", async () => {
		const response = await injectAuthenticated("PUT", "/services/tautulli-1", {
			body: { enabled: false, confirmAnalyticsUnavailable: true },
		});

		expect(response.statusCode).toBe(200);
		expect(instances.find((instance) => instance.id === "tautulli-1")).toMatchObject({
			enabled: false,
		});
		expect(instances.find((instance) => instance.id === "tautulli-1")).not.toHaveProperty(
			"confirmAnalyticsUnavailable",
		);
		const selection = await injectAuthenticated("GET", "/system/analytics-provider");
		expect(selection.statusCode).toBe(200);
		expect(selection.json()).toMatchObject({ selected: "tautulli", status: "disabled" });
	});

	it("rejects confirmation metadata without a lifecycle update", async () => {
		const response = await injectAuthenticated("PUT", "/services/tautulli-1", {
			body: { confirmAnalyticsUnavailable: true },
		});

		expect(response.statusCode).toBe(400);
		expect(instances.find((instance) => instance.id === "tautulli-1")).toMatchObject({
			enabled: true,
			service: "TAUTULLI",
		});
		expect((app as any).prisma.serviceInstance.updateMany).not.toHaveBeenCalled();
	});

	it("does not require confirmation for an unselected-family lifecycle mutation", async () => {
		const response = await injectAuthenticated("PUT", "/services/tracearr-1", {
			body: { enabled: false },
		});

		expect(response.statusCode).toBe(200);
		expect(instances.find((instance) => instance.id === "tracearr-1")).toMatchObject({
			enabled: false,
		});
	});
});
