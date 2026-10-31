import { describe, expect, it, vi } from "vitest";
import {
	assertQuiTopologyGenerationCurrent,
	captureQuiTopologyGeneration,
} from "../topology-generation.js";

describe("qUI topology generation at hash publication", () => {
	it("accepts the same enabled instance set regardless of query order", async () => {
		const expected = captureQuiTopologyGeneration([
			{ id: "b", connectionGeneration: 2 },
			{ id: "a", connectionGeneration: 4 },
		]);
		const findMany = vi.fn().mockResolvedValue([
			{ id: "a", connectionGeneration: 4 },
			{ id: "b", connectionGeneration: 2 },
		]);
		await expect(
			assertQuiTopologyGenerationCurrent(
				{ serviceInstance: { findMany } } as never,
				"user-1",
				expected,
			),
		).resolves.toBeUndefined();
		expect(findMany).toHaveBeenCalledWith({
			where: { service: "QUI", userId: "user-1", enabled: true },
			select: { id: true, connectionGeneration: true },
		});
	});

	it.each([
		["repoint", [{ id: "a", connectionGeneration: 5 }]],
		["disable", []],
		[
			"new instance",
			[
				{ id: "a", connectionGeneration: 4 },
				{ id: "b", connectionGeneration: 0 },
			],
		],
	])("rejects a %s before persisting an old hash", async (_case, current) => {
		const expected = captureQuiTopologyGeneration([{ id: "a", connectionGeneration: 4 }]);
		await expect(
			assertQuiTopologyGenerationCurrent(
				{ serviceInstance: { findMany: vi.fn().mockResolvedValue(current) } } as never,
				"user-1",
				expected,
			),
		).rejects.toThrow("topology changed");
	});
});
