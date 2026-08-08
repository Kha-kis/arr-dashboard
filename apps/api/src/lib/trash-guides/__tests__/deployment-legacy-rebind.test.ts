import { describe, expect, it, vi } from "vitest";
import { rebindLegacyDeploymentConnectionState } from "../deployment-legacy-rebind.js";

describe("legacy deployment connection rebind", () => {
	it("compare-and-sets the mapping and preserves score overrides while binding them", async () => {
		const mappingUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const overrideUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
		const transaction = vi.fn(async (callback) =>
			callback({
				templateQualityProfileMapping: { updateMany: mappingUpdateMany },
				instanceQualityProfileOverride: { updateMany: overrideUpdateMany },
			}),
		);

		await rebindLegacyDeploymentConnectionState(
			{ $transaction: transaction } as never,
			"user-1",
			[{ id: "mapping-1", instanceId: "instance-1", qualityProfileId: 4 }],
			4,
			[
				{
					instanceId: "instance-1",
					connectionGeneration: 3,
					connectionStateToken: "current-connection",
				},
			],
		);

		expect(mappingUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "mapping-1",
				connectionGeneration: 0,
				connectionStateToken: null,
			},
			data: {
				connectionGeneration: 3,
				connectionStateToken: "current-connection",
				updatedAt: expect.any(Date),
			},
		});
		expect(overrideUpdateMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				instanceId: "instance-1",
				qualityProfileId: 4,
				connectionGeneration: 0,
				connectionStateToken: null,
			},
			data: {
				connectionGeneration: 3,
				connectionStateToken: "current-connection",
			},
		});
		expect(overrideUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("score");
	});

	it("fails the transaction when the reviewed legacy mapping changed", async () => {
		const overrideUpdateMany = vi.fn();
		const transaction = vi.fn(async (callback) =>
			callback({
				templateQualityProfileMapping: {
					updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				},
				instanceQualityProfileOverride: { updateMany: overrideUpdateMany },
			}),
		);

		await expect(
			rebindLegacyDeploymentConnectionState(
				{ $transaction: transaction } as never,
				"user-1",
				[{ id: "mapping-1", instanceId: "instance-1", qualityProfileId: 4 }],
				4,
				[
					{
						instanceId: "instance-1",
						connectionGeneration: 3,
						connectionStateToken: "current-connection",
					},
				],
			),
		).rejects.toThrow("changed after preview");
		expect(overrideUpdateMany).not.toHaveBeenCalled();
	});
});
