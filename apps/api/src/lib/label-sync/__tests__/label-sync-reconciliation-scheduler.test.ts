import { afterEach, describe, expect, it, vi } from "vitest";

const reconcile = vi.hoisted(() => vi.fn());
vi.mock("../jellyfin-mutation-executor.js", () => ({
	reconcileJellyfinMutationAttempts: reconcile,
}));
vi.mock("../execute-rule.js", () => ({ executeLabelSyncRule: vi.fn() }));

import { LabelSyncScheduler } from "../label-sync-scheduler.js";
import { registerLabelSyncMutationAdmission } from "../mutation-admission.js";

const unregister: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of unregister.splice(0)) cleanup();
	vi.resetAllMocks();
});

function fixture(open = true) {
	const findMany = vi.fn().mockResolvedValue([]);
	const prisma = { labelSyncRule: { findMany } };
	const log = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
	unregister.push(registerLabelSyncMutationAdmission(prisma, { isOpen: () => open }));
	const scheduler = new LabelSyncScheduler(prisma as never, {} as never, {} as never, log as never);
	return {
		findMany,
		prisma,
		log,
		tick: () => (scheduler as unknown as { tick(): Promise<void> }).tick(),
	};
}

describe("Label Sync scheduled mutation reconciliation", () => {
	it("reconciles before rules and continues on every tick even with no due rules", async () => {
		let release!: () => void;
		reconcile.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const f = fixture();
		const pending = f.tick();
		await Promise.resolve();
		expect(reconcile).toHaveBeenCalledOnce();
		expect(f.findMany).not.toHaveBeenCalled();
		await f.tick();
		expect(reconcile).toHaveBeenCalledOnce();
		release();
		await pending;
		await f.tick();
		expect(reconcile).toHaveBeenCalledTimes(2);
		expect(f.findMany).toHaveBeenCalledTimes(2);
	});

	it("does not reconcile before application recovery opens admission", async () => {
		const f = fixture(false);
		await f.tick();
		expect(reconcile).not.toHaveBeenCalled();
	});

	it("contains a dependency failure and retries read-only reconciliation on a later tick", async () => {
		reconcile.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_ENDPOINT_TOKEN"));
		const f = fixture();
		await f.tick();
		await f.tick();
		expect(reconcile).toHaveBeenCalledTimes(2);
		expect(f.findMany).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain("PRIVATE_PROVIDER_ENDPOINT_TOKEN");
	});
});
