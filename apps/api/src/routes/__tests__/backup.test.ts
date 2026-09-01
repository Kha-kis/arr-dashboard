import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupPasswordConfigurationError } from "../../lib/backup/backup-service.js";
import { BackupCompatibilityError } from "../../lib/errors.js";
import {
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
} from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { registerBackupRoutes } from "../backup.js";
import { registerTestErrorHandler } from "./test-helpers.js";

const { mockCreateBackup, mockRestoreBackup } = vi.hoisted(() => ({
	mockCreateBackup: vi.fn(),
	mockRestoreBackup: vi.fn(),
}));

vi.mock("../../lib/backup/backup-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/backup/backup-service.js")>();
	return {
		...actual,
		BackupService: class {
			createBackup(...args: unknown[]) {
				return mockCreateBackup(...args);
			}
			restoreBackup(...args: unknown[]) {
				return mockRestoreBackup(...args);
			}
		},
	};
});

const successfulBackup = {
	id: "backup-1",
	filename: "backup-2024-01-01T00-00-00-000Z.json",
	type: "manual" as const,
	timestamp: "2024-01-01T00:00:00.000Z",
	size: 123,
};

function createPrismaStub() {
	return {
		backupSettings: {
			findFirst: vi.fn().mockResolvedValue({ includeTrashBackups: false }),
		},
	};
}

async function buildApp(prisma: ReturnType<typeof createPrismaStub>): Promise<FastifyInstance> {
	const app = Fastify();
	app.decorate("prisma", prisma as never);
	app.decorate("config", { DATABASE_URL: "file:./dev.db" } as never);
	app.decorate("encryptor", {
		encrypt: vi.fn().mockReturnValue({ value: "encrypted", iv: "iv" }),
		decrypt: vi.fn().mockReturnValue("decrypted"),
	} as never);
	app.decorate("secretsSynchronized", true);
	app.decorateRequest("currentUser", null);

	app.addHook("preHandler", async (request) => {
		if (request.headers["x-test-auth"]) {
			(request as { currentUser: { id: string; username: string } | null }).currentUser = {
				id: "user-1",
				username: "admin",
			};
		}
	});
	registerTestErrorHandler(app);

	await app.register(async (protectedApp) => {
		protectedApp.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser?.id) {
				return reply.status(401).send({ error: "Authentication required" });
			}
		});
		await protectedApp.register(registerBackupRoutes, { prefix: "/api/backup" });
	});

	await app.ready();
	return app;
}

async function createBackup(app: FastifyInstance) {
	return app.inject({
		method: "POST",
		url: "/api/backup/create",
		headers: { "x-test-auth": "1" },
		payload: {},
	});
}

describe("POST /api/backup/create", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockCreateBackup.mockResolvedValue(successfulBackup);
		app = await buildApp(createPrismaStub());
	});

	afterEach(async () => {
		await app.close();
	});

	it("returns 409 without mutating while maintenance is active, then succeeds on retry", async () => {
		let releaseCleanup!: () => void;
		const cleanup = withCleanupOperationGuard(
			() =>
				new Promise<void>((resolve) => {
					releaseCleanup = resolve;
				}),
		);
		const performBackupMutation = vi.fn(() => successfulBackup);
		mockCreateBackup.mockImplementation(() =>
			withCleanupMaintenanceGuard(async () => performBackupMutation()),
		);

		const blocked = await createBackup(app);
		expect(performBackupMutation).not.toHaveBeenCalled();

		releaseCleanup();
		await cleanup;

		const retry = await createBackup(app);

		expect(blocked.statusCode).toBe(409);
		expect(JSON.parse(blocked.payload)).toEqual({
			error: "Database maintenance cannot overlap a library cleanup operation",
		});
		expect(retry.statusCode).toBe(200);
		expect(JSON.parse(retry.payload)).toEqual(successfulBackup);
		expect(performBackupMutation).toHaveBeenCalledTimes(1);
	});

	it("preserves the invalid stored-password mapping from #820", async () => {
		mockCreateBackup.mockRejectedValue(new BackupPasswordConfigurationError());

		const response = await createBackup(app);

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.payload)).toEqual({
			error: "Backup password is invalid",
			details:
				"The stored backup password cannot be used. Reset it in Settings > Backup or set the BACKUP_PASSWORD environment variable.",
		});
	});

	it("preserves the missing password mapping from #820", async () => {
		mockCreateBackup.mockRejectedValue(new Error("BACKUP_PASSWORD is required"));

		const response = await createBackup(app);

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.payload)).toEqual({
			error: "Backup password not configured",
			details:
				"Set a password in Settings > Backup or set the BACKUP_PASSWORD environment variable to enable encrypted backups in production.",
		});
	});

	it("preserves the generic error mapping", async () => {
		mockCreateBackup.mockRejectedValue(new Error("disk unavailable"));

		const response = await createBackup(app);

		expect(response.statusCode).toBe(500);
		expect(JSON.parse(response.payload)).toEqual({ error: "Failed to create backup" });
	});

	it("returns the backup file info on success", async () => {
		const response = await createBackup(app);

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toEqual(successfulBackup);
	});

	it("rejects unauthenticated requests before invoking backup creation", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/api/backup/create",
			payload: {},
		});

		expect(response.statusCode).toBe(401);
		expect(JSON.parse(response.payload)).toEqual({ error: "Authentication required" });
		expect(mockCreateBackup).not.toHaveBeenCalled();
	});

	it("returns bounded 409 for an incomplete legacy restore", async () => {
		mockRestoreBackup.mockRejectedValue(new BackupCompatibilityError());

		const response = await app.inject({
			method: "POST",
			url: "/api/backup/restore",
			headers: { "x-test-auth": "1" },
			payload: { backupData: Buffer.from("legacy-backup").toString("base64") },
		});

		expect(response.statusCode).toBe(409);
		expect(JSON.parse(response.payload)).toEqual({
			error:
				"This legacy backup does not contain complete configuration coverage and cannot safely replace the current installation. Restore it to a clean installation or create a new backup with the current version.",
		});
	});
});
