import { describe, expect, it, vi } from "vitest";
import { clearDurableHistoryObservationState } from "../history-observation-lifecycle.js";

describe("History observation lifecycle", () => {
	it("deletes observations before source status with exact owner-scoped predicates", async () => {
		const historyObservation = { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) };
		const historySourceStatus = { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) };
		const prisma = { historyObservation, historySourceStatus };

		await clearDurableHistoryObservationState(prisma, "instance-1", "owner-1");

		expect(historyObservation.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "instance-1", instance: { userId: "owner-1" } },
		});
		expect(historySourceStatus.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "instance-1", instance: { userId: "owner-1" } },
		});
		const observationOrder = historyObservation.deleteMany.mock.invocationCallOrder[0];
		const sourceStatusOrder = historySourceStatus.deleteMany.mock.invocationCallOrder[0];
		expect(observationOrder).toBeDefined();
		expect(sourceStatusOrder).toBeDefined();
		expect(observationOrder!).toBeLessThan(sourceStatusOrder!);
	});

	it("propagates a source-status deletion failure after deleting observations", async () => {
		const failure = new Error("status delete failed");
		const historyObservation = { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) };
		const historySourceStatus = { deleteMany: vi.fn().mockRejectedValue(failure) };

		await expect(
			clearDurableHistoryObservationState(
				{ historyObservation, historySourceStatus },
				"instance-1",
				"owner-1",
			),
		).rejects.toBe(failure);
	});
});
