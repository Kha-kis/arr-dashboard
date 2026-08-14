import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schedulerRegistryPlugin from "../../plugins/scheduler-registry.js";
import { registerSystemRoutes } from "../system.js";
import {
	AUTH_HEADER,
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

type ProviderService = "TRACEARR" | "TAUTULLI";
type InstanceRow = { userId: string; service: ProviderService; enabled: boolean };

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let instances: InstanceRow[];
let settings: { analyticsProvider: string | null; analyticsProviderSource: string | null };

function createPrisma() {
	const systemSettings = {
		findUnique: vi.fn(async () => ({ ...settings })),
		upsert: vi.fn(async ({ create, update }: any) => {
			settings = {
				analyticsProvider: update.analyticsProvider ?? create.analyticsProvider ?? null,
				analyticsProviderSource:
					update.analyticsProviderSource ?? create.analyticsProviderSource ?? null,
			};
			return { ...settings };
		}),
	};
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
	};
	const prisma = {
		systemSettings,
		serviceInstance,
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-user-1" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
	instances = [];
	settings = { analyticsProvider: null, analyticsProviderSource: null };
	app = Fastify();
	app.decorate("prisma", createPrisma() as never);
	app.decorate("config", {
		TRUST_PROXY: false,
		COOKIE_SECURE: false,
		DATABASE_URL: "file:./test.db",
	} as never);
	app.decorate("dbProvider", "sqlite" as never);
	app.decorate("lifecycle", { getRestartMessage: () => "ok", restart: vi.fn() } as never);
	setupAuthInjection(app);
	app.addHook("preHandler", async (request: any) => {
		if (request.headers[AUTH_HEADER] && request.headers["x-test-user"] === "user-2") {
			request.currentUser = { id: "user-2", username: "other-admin" };
		}
	});
	registerTestErrorHandler(app);
	await app.register(schedulerRegistryPlugin);
	await app.register(registerSystemRoutes, { prefix: "/system" });
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

describe("GET /system/analytics-provider", () => {
	it("materializes the user-scoped migration default with count-only family state", async () => {
		instances = [
			{ userId: "user-1", service: "TAUTULLI", enabled: true },
			{ userId: "user-2", service: "TRACEARR", enabled: true },
		];

		const response = await injectAuthenticated("GET", "/system/analytics-provider");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			selected: "tautulli",
			source: "migration-default",
			families: {
				tracearr: { configuredCount: 0, enabledCount: 0 },
				tautulli: { configuredCount: 1, enabledCount: 1 },
			},
			status: "configured",
		});
		expect(settings).toEqual({
			analyticsProvider: "tautulli",
			analyticsProviderSource: "migration-default",
		});
	});
});

describe("PUT /system/analytics-provider", () => {
	it("rejects an unknown provider without changing the stored selection", async () => {
		settings = { analyticsProvider: "tautulli", analyticsProviderSource: "explicit" };

		const response = await injectAuthenticated("PUT", "/system/analytics-provider", {
			body: { provider: "other" },
		});

		expect(response.statusCode).toBe(400);
		expect(settings).toEqual({
			analyticsProvider: "tautulli",
			analyticsProviderSource: "explicit",
		});
	});

	it("is idempotent and keeps explicit selection scoped to the caller's service counts", async () => {
		instances = [
			{ userId: "user-1", service: "TRACEARR", enabled: true },
			{ userId: "user-2", service: "TAUTULLI", enabled: true },
		];

		const first = await injectAuthenticated("PUT", "/system/analytics-provider", {
			body: { provider: "tracearr" },
		});
		const second = await injectAuthenticated("PUT", "/system/analytics-provider", {
			body: { provider: "tracearr" },
		});

		expect(first.statusCode).toBe(200);
		expect(second.statusCode).toBe(200);
		expect(first.json()).toEqual(second.json());
		expect(second.json()).toMatchObject({
			selected: "tracearr",
			source: "explicit",
			families: {
				tracearr: { configuredCount: 1, enabledCount: 1 },
				tautulli: { configuredCount: 0, enabledCount: 0 },
			},
		});
	});
});
