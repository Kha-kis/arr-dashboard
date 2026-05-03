/**
 * Unit tests for the auto-install Connect webhook helper (issue #422).
 *
 * Mocks the *arr-sdk client's notification accessor; verifies:
 *   - Probe correctly detects existing arr-dashboard webhook by name match
 *   - Install creates new notification when none exists
 *   - Install updates existing notification when found (idempotent re-install)
 *   - Install failures are surfaced per-instance without throwing
 *   - Listing scopes to enabled SONARR/RADARR instances only
 */

import { describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";
import {
	ARR_DASHBOARD_NOTIFICATION_NAME,
	installOnInstance,
	listEligibleInstances,
	probeInstallStatus,
} from "../webhook-installer.js";

const radarrInstance = (over: Partial<ServiceInstance> = {}): ServiceInstance =>
	({
		id: "inst-1",
		userId: "u1",
		service: "RADARR",
		label: "Primary Radarr",
		baseUrl: "http://radarr",
		externalUrl: null,
		encryptedApiKey: "enc",
		encryptionIv: "iv",
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	}) as ServiceInstance;

interface MockClient {
	notification: {
		getAll: ReturnType<typeof vi.fn>;
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
}

const buildClient = (existing: Array<{ id: number; name: string }> = []): MockClient => ({
	notification: {
		getAll: vi.fn().mockResolvedValue(existing),
		create: vi.fn(async (n) => ({ ...n, id: 99 })),
		update: vi.fn(async (id, n) => ({ ...n, id })),
	},
});

const factory = (client: MockClient) =>
	({
		create: vi.fn().mockReturnValue(client),
	}) as never;

describe("probeInstallStatus", () => {
	it("returns installed=false when no arr-dashboard notification exists", async () => {
		const client = buildClient([{ id: 1, name: "Discord" }]);
		const result = await probeInstallStatus(
			{ prisma: {} as never, arrClientFactory: factory(client) },
			radarrInstance(),
		);
		expect(result.installed).toBe(false);
		expect(result.notificationId).toBeNull();
		expect(result.error).toBeNull();
	});

	it("returns installed=true with notificationId when matching name found", async () => {
		const client = buildClient([
			{ id: 1, name: "Discord" },
			{ id: 7, name: ARR_DASHBOARD_NOTIFICATION_NAME },
		]);
		const result = await probeInstallStatus(
			{ prisma: {} as never, arrClientFactory: factory(client) },
			radarrInstance(),
		);
		expect(result.installed).toBe(true);
		expect(result.notificationId).toBe(7);
	});

	it("captures the error message and reports installed=false on probe failure", async () => {
		const factoryErr = {
			create: vi.fn().mockImplementation(() => {
				throw new Error("api key invalid");
			}),
		} as never;
		const result = await probeInstallStatus(
			{ prisma: {} as never, arrClientFactory: factoryErr },
			radarrInstance(),
		);
		expect(result.installed).toBe(false);
		expect(result.error).toBe("api key invalid");
	});
});

describe("installOnInstance", () => {
	const args = {
		webhookUrl: "https://arr-dash.example/api/auto-tag/webhook/inst-1",
		bearerSecret: "test-secret-32-chars-or-more-here",
		events: { onDownload: true, onUpgrade: true, onGrab: false },
	};

	it("creates a new notification when none exists with the canonical name", async () => {
		const client = buildClient([{ id: 1, name: "Discord" }]);
		const result = await installOnInstance(
			{ prisma: {} as never, arrClientFactory: factory(client) },
			radarrInstance(),
			args,
		);
		expect(result.status).toBe("installed");
		expect(client.notification.create).toHaveBeenCalledOnce();
		expect(client.notification.update).not.toHaveBeenCalled();

		const payload = client.notification.create.mock.calls[0]?.[0];
		expect(payload.name).toBe(ARR_DASHBOARD_NOTIFICATION_NAME);
		expect(payload.implementation).toBe("Webhook");
		expect(payload.onDownload).toBe(true);
		expect(payload.onUpgrade).toBe(true);
		expect(payload.onGrab).toBe(false);

		// URL + Bearer secret threaded through fields
		const fields = payload.fields as Array<{ name: string; value: unknown }>;
		expect(fields.find((f) => f.name === "url")?.value).toBe(args.webhookUrl);
		const headers = fields.find((f) => f.name === "headers")?.value as Array<{
			key: string;
			value: string;
		}>;
		expect(headers[0]?.value).toBe(`Bearer ${args.bearerSecret}`);
	});

	it("updates the existing notification (idempotent re-install)", async () => {
		const client = buildClient([{ id: 7, name: ARR_DASHBOARD_NOTIFICATION_NAME }]);
		const result = await installOnInstance(
			{ prisma: {} as never, arrClientFactory: factory(client) },
			radarrInstance(),
			args,
		);
		expect(result.status).toBe("updated");
		expect(result.notificationId).toBe(7);
		expect(client.notification.update).toHaveBeenCalledOnce();
		expect(client.notification.create).not.toHaveBeenCalled();
		const [id, payload] = client.notification.update.mock.calls[0] ?? [];
		expect(id).toBe(7);
		expect((payload as { id: number }).id).toBe(7);
	});

	it("returns status=failed with error message on SDK exception", async () => {
		const client = {
			notification: {
				getAll: vi.fn().mockRejectedValue(new Error("503 Service Unavailable")),
				create: vi.fn(),
				update: vi.fn(),
			},
		};
		const result = await installOnInstance(
			{ prisma: {} as never, arrClientFactory: factory(client) },
			radarrInstance(),
			args,
		);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("Service Unavailable");
		expect(client.notification.create).not.toHaveBeenCalled();
		expect(client.notification.update).not.toHaveBeenCalled();
	});
});

describe("listEligibleInstances", () => {
	it("scopes to enabled SONARR/RADARR for the given user", async () => {
		const findMany = vi.fn().mockResolvedValue([radarrInstance()]);
		const prisma = { serviceInstance: { findMany } } as never;
		await listEligibleInstances(prisma, "u1");
		expect(findMany).toHaveBeenCalledOnce();
		const where = findMany.mock.calls[0]?.[0]?.where;
		expect(where.userId).toBe("u1");
		expect(where.service).toEqual({ in: ["SONARR", "RADARR"] });
		expect(where.enabled).toBe(true);
	});
});
