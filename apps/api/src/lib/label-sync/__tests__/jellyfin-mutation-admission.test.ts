import { describe, expect, it, vi } from "vitest";

vi.mock("../strategy-registry.js", () => ({
	SOURCE_READERS: { sonarr: { prismaService: "SONARR" } },
	DEST_WRITERS: { jellyfin: { prismaService: "JELLYFIN" } },
}));

import { executeLabelSyncRule } from "../execute-rule.js";
import { registerLabelSyncMutationAdmission } from "../mutation-admission.js";
import { triggerLabelSyncForItem } from "../trigger-for-item.js";

describe("Jellyfin engine recovery admission", () => {
	it("reports pending recovery on item triggers without attempting source correlation", async () => {
		const findFirst = vi.fn().mockResolvedValue(null);
		const log = { child: vi.fn().mockReturnThis(), debug: vi.fn(), warn: vi.fn() };
		const result = await triggerLabelSyncForItem({
			userId: "owner",
			sourceService: "SONARR",
			sourceInstanceId: "source",
			arrItemId: 1,
			itemType: "series",
			tagName: "source-tag",
			prisma: {
				labelSyncRule: {
					findMany: async () => [
						{
							id: "rule",
							userId: "owner",
							name: "rule",
							sourceService: "sonarr",
							sourceInstanceId: "source",
							sourceTagName: "source-tag",
							destService: "jellyfin",
							destInstanceId: "destination",
							destTagName: "tag",
						},
					],
				},
				libraryCache: { findFirst },
			} as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: log as never,
		});
		expect(result.rulesFired).toBe(1);
		expect(result.results[0]?.outcome.message).toMatch(/recovery/);
		expect(findFirst).not.toHaveBeenCalled();
	});
	it("prevents all source and destination activity until recovery opens, and after closure", async () => {
		const findMany = vi.fn().mockResolvedValue([]);
		const prisma = { serviceInstance: { findMany } };
		const log = { child: vi.fn().mockReturnThis() };
		const execute = () =>
			executeLabelSyncRule({
				rule: {
					id: "rule",
					userId: "owner",
					sourceService: "sonarr",
					sourceInstanceId: null,
					sourceTagName: "source",
					destService: "jellyfin",
					destInstanceId: "destination",
					destTagName: "tag",
				},
				prisma: prisma as never,
				arrClientFactory: {} as never,
				encryptor: {} as never,
				log: log as never,
			});
		expect((await execute()).message).toMatch(/recovery/);
		expect(findMany).not.toHaveBeenCalled();
		expect(log.child).not.toHaveBeenCalled();
		let open = false;
		const unregister = registerLabelSyncMutationAdmission(prisma, { isOpen: () => open });
		try {
			expect((await execute()).message).toMatch(/recovery/);
			expect(findMany).not.toHaveBeenCalled();
			open = true;
			expect((await execute()).message).toMatch(/No enabled sonarr/);
			expect(findMany).toHaveBeenCalledOnce();
			open = false;
			expect((await execute()).message).toMatch(/recovery/);
			expect(findMany).toHaveBeenCalledOnce();
		} finally {
			unregister();
		}
	});
});
