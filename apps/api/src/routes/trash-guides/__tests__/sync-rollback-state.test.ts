import type { FastifyRequest } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSyncRoutes } from "../sync-routes.js";

const USER_ID = "user-1";
const SYNC_ID = "sync-1";

function syncHistory(overrides: Record<string, unknown> = {}) {
	return {
		id: SYNC_ID,
		userId: USER_ID,
		backupId: "backup-1",
		backup: {
			backupData: JSON.stringify({ customFormats: [], qualityProfile: null }),
		},
		instance: {
			id: "instance-1",
			userId: USER_ID,
			service: "RADARR",
		},
		template: null,
		appliedConfigs: "[]",
		rolledBack: false,
		rollbackStatus: null,
		rollbackAttemptedAt: null,
		rollbackProgress: null,
		...overrides,
	};
}

describe("POST /sync/:syncId/rollback state coordination", () => {
	let app: ReturnType<typeof Fastify>;
	let findFirst: ReturnType<typeof vi.fn>;
	let update: ReturnType<typeof vi.fn>;
	let updateMany: ReturnType<typeof vi.fn>;
	let createClient: ReturnType<typeof vi.fn>;
	let getAll: ReturnType<typeof vi.fn>;
	let updateFormat: ReturnType<typeof vi.fn>;
	let deleteFormat: ReturnType<typeof vi.fn>;
	let events: string[];

	beforeEach(async () => {
		events = [];
		findFirst = vi.fn().mockResolvedValue(syncHistory());
		update = vi.fn().mockImplementation(async () => {
			events.push("db:legacy-complete");
			return {};
		});
		updateMany = vi.fn().mockImplementation(async ({ data }) => {
			events.push(`db:${data.rollbackStatus}`);
			return { count: 1 };
		});
		getAll = vi.fn().mockImplementation(async () => {
			events.push("arr:getAll");
			return [];
		});
		deleteFormat = vi.fn();
		updateFormat = vi.fn().mockImplementation(async () => {
			events.push("arr:update");
		});
		createClient = vi.fn().mockImplementation(() => {
			events.push("arr:createClient");
			return {
				customFormat: {
					getAll,
					create: vi.fn(),
					update: updateFormat,
					delete: deleteFormat,
				},
				qualityProfile: { update: vi.fn() },
			};
		});

		app = Fastify({ logger: false });
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request: FastifyRequest) => {
			request.currentUser = { id: USER_ID } as never;
		});
		app.decorate("prisma", {
			trashSyncHistory: { findFirst, update, updateMany },
		} as never);
		app.decorate("arrClientFactory", { create: createClient } as never);
		app.decorate("deploymentExecutor", {} as never);

		await app.register(registerSyncRoutes, { prefix: "/api/trash-guides/sync" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("claims the rollback for the current user before creating or reading from ARR", async () => {
		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/sync/${SYNC_ID}/rollback`,
		});

		expect(response.statusCode).toBe(200);
		expect(updateMany).toHaveBeenCalled();
		const claim = updateMany.mock.calls[0]?.[0];
		expect(claim).toEqual({
			where: {
				id: SYNC_ID,
				userId: USER_ID,
				rolledBack: false,
				OR: [{ rollbackStatus: null }, { rollbackStatus: "PARTIAL" }],
			},
			data: {
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt: expect.any(Date),
				rollbackProgress: expect.any(String),
			},
		});
		expect(events.indexOf("db:IN_PROGRESS")).toBeLessThan(events.indexOf("arr:createClient"));
		expect(events.indexOf("db:IN_PROGRESS")).toBeLessThan(events.indexOf("arr:getAll"));
	});

	it("persists retryable PARTIAL progress when an upstream rollback action fails", async () => {
		findFirst.mockResolvedValueOnce(
			syncHistory({
				appliedConfigs: JSON.stringify([{ name: "Created CF", action: "created" }]),
			}),
		);
		getAll.mockResolvedValueOnce([{ id: 42, name: "Created CF" }]);
		deleteFormat.mockRejectedValueOnce(new Error("ARR delete failed"));

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/sync/${SYNC_ID}/rollback`,
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(expect.objectContaining({ success: false, failedCount: 1 }));
		const attemptedAt = updateMany.mock.calls[0]?.[0].data.rollbackAttemptedAt;
		const partialWrite = updateMany.mock.calls.find(
			([args]) => args.data.rollbackStatus === "PARTIAL",
		)?.[0];
		expect(partialWrite).toEqual({
			where: {
				id: SYNC_ID,
				userId: USER_ID,
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt: attemptedAt,
			},
			data: {
				rollbackStatus: "PARTIAL",
				rollbackProgress: expect.any(String),
			},
		});
		expect(JSON.parse(partialWrite.data.rollbackProgress)).toEqual([
			expect.objectContaining({
				step: "rollback",
				status: "PARTIAL",
				failedCount: 1,
				errors: ['Failed to delete "Created CF": ARR delete failed'],
			}),
		]);
		expect(update).not.toHaveBeenCalled();
	});

	it("persists retryable PARTIAL progress when rollback fails unexpectedly", async () => {
		getAll.mockRejectedValueOnce(new Error("ARR read failed"));

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/sync/${SYNC_ID}/rollback`,
		});

		expect(response.statusCode).toBe(500);
		expect(response.json()).toEqual({
			error: "ROLLBACK_FAILED",
			message: "ARR read failed",
		});
		const attemptedAt = updateMany.mock.calls[0]?.[0].data.rollbackAttemptedAt;
		const partialWrite = updateMany.mock.calls.find(
			([args]) => args.data.rollbackStatus === "PARTIAL",
		)?.[0];
		expect(partialWrite).toEqual({
			where: {
				id: SYNC_ID,
				userId: USER_ID,
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt: attemptedAt,
			},
			data: {
				rollbackStatus: "PARTIAL",
				rollbackProgress: expect.any(String),
			},
		});
		expect(JSON.parse(partialWrite.data.rollbackProgress)).toEqual([
			expect.objectContaining({
				step: "rollback",
				status: "PARTIAL",
				errors: ["ARR read failed"],
			}),
		]);
		expect(updateMany.mock.calls.some(([args]) => args.data.rollbackStatus === "COMPLETED")).toBe(
			false,
		);
	});

	it("releases an invalid backup claim into retryable PARTIAL state", async () => {
		findFirst.mockResolvedValueOnce(syncHistory({ backup: { backupData: "not-json" } }));

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/sync/${SYNC_ID}/rollback`,
		});

		expect(response.statusCode).toBe(400);
		expect(getAll).not.toHaveBeenCalled();
		const partialWrite = updateMany.mock.calls.find(
			([args]) => args.data.rollbackStatus === "PARTIAL",
		)?.[0];
		expect(JSON.parse(partialWrite.data.rollbackProgress)).toEqual([
			expect.objectContaining({
				status: "PARTIAL",
				step: "parse-backup",
				errors: ["Backup data is corrupted or invalid"],
			}),
		]);
	});

	it("never completes when created-format ownership evidence is malformed", async () => {
		findFirst.mockResolvedValueOnce(syncHistory({ appliedConfigs: "not-json" }));

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/sync/${SYNC_ID}/rollback`,
		});

		expect(response.statusCode).toBe(500);
		expect(response.json().message).toContain("ownership evidence is invalid");
		expect(getAll).not.toHaveBeenCalled();
		expect(updateMany.mock.calls.some(([args]) => args.data.rollbackStatus === "COMPLETED")).toBe(
			false,
		);
		expect(updateMany.mock.calls.some(([args]) => args.data.rollbackStatus === "PARTIAL")).toBe(
			true,
		);
	});

	it("persists COMPLETED only after all upstream work succeeds", async () => {
		findFirst.mockResolvedValueOnce(
			syncHistory({
				backup: {
					backupData: JSON.stringify({
						customFormats: [{ id: 7, name: "Existing CF", specifications: [] }],
						qualityProfile: null,
					}),
				},
			}),
		);
		getAll.mockResolvedValueOnce([{ id: 7, name: "Existing CF", specifications: [] }]);

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/sync/${SYNC_ID}/rollback`,
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(expect.objectContaining({ success: true, restoredCount: 1 }));
		const attemptedAt = updateMany.mock.calls[0]?.[0].data.rollbackAttemptedAt;
		const completedWrite = updateMany.mock.calls.find(
			([args]) => args.data.rollbackStatus === "COMPLETED",
		)?.[0];
		expect(completedWrite).toEqual({
			where: {
				id: SYNC_ID,
				userId: USER_ID,
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt: attemptedAt,
			},
			data: {
				rolledBack: true,
				rolledBackAt: expect.any(Date),
				rollbackStatus: "COMPLETED",
				rollbackProgress: expect.any(String),
			},
		});
		expect(JSON.parse(completedWrite.data.rollbackProgress)).toEqual([
			expect.objectContaining({
				step: "rollback",
				status: "COMPLETED",
				restoredCount: 1,
				deletedCount: 0,
				failedCount: 0,
			}),
		]);
		expect(events.indexOf("arr:update")).toBeLessThan(events.indexOf("db:COMPLETED"));
		expect(update).not.toHaveBeenCalled();
	});

	it("fails closed without ARR access when another rollback owns the claim", async () => {
		updateMany.mockResolvedValueOnce({ count: 0 });

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/sync/${SYNC_ID}/rollback`,
		});

		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({
			error: "ROLLBACK_IN_PROGRESS",
			message: "A rollback is already in progress for this sync operation",
		});
		expect(createClient).not.toHaveBeenCalled();
		expect(getAll).not.toHaveBeenCalled();
		expect(updateMany).toHaveBeenCalledTimes(1);
	});

	it("falls back to PARTIAL when terminal database persistence fails", async () => {
		updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockRejectedValueOnce(new Error("terminal DB failed"))
			.mockResolvedValueOnce({ count: 1 });

		const response = await app.inject({
			method: "POST",
			url: `/api/trash-guides/sync/${SYNC_ID}/rollback`,
		});

		expect(response.statusCode).toBe(500);
		expect(response.json()).toEqual({
			error: "ROLLBACK_FAILED",
			message: "terminal DB failed",
		});
		const attemptedAt = updateMany.mock.calls[0]?.[0].data.rollbackAttemptedAt;
		expect(updateMany.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				where: {
					id: SYNC_ID,
					userId: USER_ID,
					rollbackStatus: "IN_PROGRESS",
					rollbackAttemptedAt: attemptedAt,
				},
				data: expect.objectContaining({ rollbackStatus: "COMPLETED" }),
			}),
		);
		expect(updateMany.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({
				where: {
					id: SYNC_ID,
					userId: USER_ID,
					rollbackStatus: "IN_PROGRESS",
					rollbackAttemptedAt: attemptedAt,
				},
				data: expect.objectContaining({ rollbackStatus: "PARTIAL" }),
			}),
		);
	});
});
