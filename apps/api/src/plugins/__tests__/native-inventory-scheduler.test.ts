import { describe, expect, it, vi } from "vitest";

const orchestration = vi.hoisted(() => ({
	schedule: vi.fn(),
	runDue: vi.fn(),
}));

vi.mock("../../lib/provider-observation/native-inventory-job-orchestration.js", () => ({
	NATIVE_INVENTORY_REFRESH_INTERVAL_MS: 30 * 60_000,
	schedulePeriodicNativeInventoryWork: orchestration.schedule,
	runDueNativeInventoryWork: orchestration.runDue,
}));

import { runNativeInventorySchedulerTick } from "../native-inventory-scheduler.js";

describe("native inventory scheduler tick", () => {
	it("attempts due recovery even if periodic admission fails, logging only aggregate categories", async () => {
		orchestration.schedule.mockReset().mockRejectedValue(new Error("private synthetic detail"));
		orchestration.runDue
			.mockReset()
			.mockResolvedValue({ completed: 1, retryable: 2, superseded: 0, incomplete: 0 });
		const log = { info: vi.fn(), error: vi.fn() };
		const app = { prisma: {}, encryptor: {}, log };
		await runNativeInventorySchedulerTick(app as never);
		expect(orchestration.schedule).toHaveBeenCalledOnce();
		expect(orchestration.runDue).toHaveBeenCalledOnce();
		expect(log.error).toHaveBeenCalledWith(
			{ category: "native-inventory-admission-failed" },
			"Native inventory periodic admission failed",
		);
		expect(log.info).toHaveBeenCalledWith(
			{
				category: "native-inventory-work",
				completed: 1,
				retryable: 2,
				superseded: 0,
				incomplete: 0,
			},
			"Native inventory work tick completed",
		);
		expect(
			JSON.stringify(log.info.mock.calls) + JSON.stringify(log.error.mock.calls),
		).not.toContain("private synthetic detail");
	});
});
