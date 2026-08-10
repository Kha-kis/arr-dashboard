import { describe, expect, it, vi } from "vitest";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
import { TrashSyncScheduler } from "../sync-scheduler.js";
import { TrashBackupCleanupService } from "../trash-backup-cleanup.js";
import { UpdateScheduler } from "../update-scheduler.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
};

describe.sequential("TRaSH scheduler maintenance gate", () => {
	it("blocks every mutating scheduler while backup restore is active", async () => {
		const finish = deferred();
		const restore = withCleanupMaintenanceGuard(() => finish.promise);
		const backupCleanup = new TrashBackupCleanupService({} as never, logger as never);
		const updateScheduler = new UpdateScheduler(
			{ enabled: true, intervalHours: 12 },
			{} as never,
			{} as never,
			{} as never,
			logger,
		);
		const syncScheduler = new TrashSyncScheduler(
			{} as never,
			logger as never,
			{} as never,
			{} as never,
		) as unknown as { checkAndRunSchedules: () => Promise<void> };

		await expect(backupCleanup.runCleanup()).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);
		await expect(updateScheduler.triggerCheck()).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);
		await expect(syncScheduler.checkAndRunSchedules()).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		finish.resolve();
		await restore;
	});
});
