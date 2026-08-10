import { describe, expect, it } from "vitest";
import {
	acquireCleanupOperationGuard,
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
} from "../cleanup-maintenance-gate.js";

describe.sequential("cleanup maintenance gate", () => {
	it("rejects restore while a cleanup-sensitive operation is active", async () => {
		let releaseOperation!: () => void;
		const operationBlocked = new Promise<void>((resolve) => {
			releaseOperation = resolve;
		});
		const operation = withCleanupOperationGuard(() => operationBlocked);

		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		releaseOperation();
		await operation;
		await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
	});

	it("rejects cleanup and topology writes throughout restore", async () => {
		let releaseRestore!: () => void;
		const restoreBlocked = new Promise<void>((resolve) => {
			releaseRestore = resolve;
		});
		const restore = withCleanupMaintenanceGuard(() => restoreBlocked);

		await expect(withCleanupOperationGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		releaseRestore();
		await restore;
		await expect(withCleanupOperationGuard(async () => "changed")).resolves.toBe("changed");
	});

	it("releases the exclusive guard after restore fails", async () => {
		await expect(
			withCleanupMaintenanceGuard(async () => {
				throw new Error("restore failed");
			}),
		).rejects.toThrow("restore failed");

		await expect(withCleanupOperationGuard(async () => "available")).resolves.toBe("available");
	});

	it("holds an explicitly acquired operation guard until its idempotent release", async () => {
		const release = acquireCleanupOperationGuard();

		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		release();
		release();
		await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
	});
});
