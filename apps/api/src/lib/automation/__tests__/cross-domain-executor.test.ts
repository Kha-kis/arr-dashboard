import { describe, expect, it, vi } from "vitest";
import { executeCrossDomainRule } from "../cross-domain-executor.js";

const document = {
	version: 1,
	root: { kind: "age", params: { field: "arrAddedAt", operator: "older_than", days: 30 } },
};

describe("executeCrossDomainRule", () => {
	it("delivers a one-shot action only once per item and deployment", async () => {
		let ledgerRow: Record<string, unknown> | null = null;
		const notify = vi.fn(async () => undefined);
		const prisma = {
			serviceInstance: {
				findMany: vi.fn(async () => [{ id: "radarr-1", label: "Radarr", service: "RADARR" }]),
			},
			libraryCache: {
				findMany: vi.fn(async ({ cursor }: { cursor?: unknown }) =>
					cursor
						? []
						: [
								{
									id: "cache-1",
									instanceId: "radarr-1",
									arrItemId: 42,
									itemType: "movie",
									title: "Old Movie",
									year: 1999,
									monitored: true,
									hasFile: true,
									status: "released",
									qualityProfileId: 1,
									qualityProfileName: "HD",
									sizeOnDisk: 1n,
									arrAddedAt: new Date("2020-01-01T00:00:00Z"),
									data: JSON.stringify({ added: "2020-01-01T00:00:00Z" }),
								},
							],
				),
			},
			crossDomainRuleMatch: {
				findMany: vi.fn(async () => (ledgerRow ? [ledgerRow] : [])),
				upsert: vi.fn(
					async ({
						create,
						update,
					}: {
						create: Record<string, unknown>;
						update: Record<string, unknown>;
					}) => {
						ledgerRow = ledgerRow
							? { ...ledgerRow, ...update }
							: { ...create, processedAt: new Date() };
						return ledgerRow;
					},
				),
			},
		};
		const deps = {
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			notificationService: { notify } as never,
			log: {
				child: () => deps.log,
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			} as never,
		};
		const rule = {
			id: "rule-1",
			userId: "user-1",
			deployedName: "Archive workflow",
			deployedDocument: JSON.stringify(document),
			deployedScope: JSON.stringify({ serviceTypes: ["RADARR"], instanceIds: [] }),
			deployedActions: JSON.stringify([{ type: "send_notification" }, { type: "exempt_cleanup" }]),
			deploymentVersion: 1,
		};

		const first = await executeCrossDomainRule(deps, rule);
		const second = await executeCrossDomainRule(deps, rule);

		expect(first.status).toBe("success");
		expect(second.status).toBe("success");
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "AUTOMATION_RULE_MATCHED",
				title: expect.stringContaining("Old Movie"),
			}),
			{ userId: "user-1" },
		);
		expect(ledgerRow).toMatchObject({ completedActions: '["send_notification"]' });
	});
});
