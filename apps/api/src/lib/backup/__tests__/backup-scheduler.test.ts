import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../lib/prisma.js";
import { BackupScheduler } from "../backup-scheduler.js";

describe("BackupScheduler secret synchronization", () => {
	it("rejects the scheduled backup path when active secrets are unsynchronized", async () => {
		const logger = {
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		} as unknown as FastifyBaseLogger;
		const scheduler = new BackupScheduler(
			{} as PrismaClient,
			logger,
			"/unused/secrets.json",
			undefined,
			{ secretsSynchronized: false },
		);
		const runScheduledBackup = (
			scheduler as unknown as {
				runScheduledBackup(retentionCount: number): Promise<void>;
			}
		).runScheduledBackup.bind(scheduler);

		await expect(runScheduledBackup(3)).rejects.toThrow(
			"active environment secrets could not be synchronized",
		);
	});
});
