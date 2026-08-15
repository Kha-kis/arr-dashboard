import { beforeEach, describe, expect, it, vi } from "vitest";

const executorMocks = vi.hoisted(() => ({
	scanCrossDomainRule: vi.fn(),
	executeAutoTagRule: vi.fn(),
}));

vi.mock("../cross-domain-rules.js", () => ({
	scanCrossDomainRule: executorMocks.scanCrossDomainRule,
}));

vi.mock("../../auto-tag/execute-rule.js", () => ({
	executeAutoTagRule: executorMocks.executeAutoTagRule,
}));

import { executeCrossDomainRule } from "../cross-domain-executor.js";

const document = {
	version: 1,
	root: { kind: "age", params: { field: "arrAddedAt", operator: "older_than", days: 30 } },
};

describe("executeCrossDomainRule", () => {
	beforeEach(() => {
		executorMocks.scanCrossDomainRule.mockReset();
		executorMocks.executeAutoTagRule.mockReset();
		executorMocks.scanCrossDomainRule.mockResolvedValue({
			itemsEvaluated: 1,
			matches: [
				{
					cacheId: "cache-1",
					instanceId: "radarr-1",
					instanceName: "Radarr",
					arrItemId: 42,
					itemType: "movie",
					title: "Old Movie",
					year: 1999,
					reason: "Matched age condition",
				},
			],
		});
	});

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

	it("records a retryable context failure instead of claiming the item disappeared", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const prisma = {
			crossDomainRuleMatch: {
				findMany: vi.fn().mockResolvedValue([]),
				upsert,
			},
		};
		executorMocks.executeAutoTagRule.mockResolvedValue({
			status: "failed",
			message: "Evaluation context could not be built; no tags were changed.",
			totals: {
				instancesScanned: 0,
				itemsScanned: 0,
				itemsMatched: 0,
				tagsApplied: 0,
				failures: 0,
			},
			itemOutcomes: [],
		});
		const deps = {
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			notificationService: {} as never,
			log: {} as never,
		};
		const rule = {
			id: "rule-1",
			userId: "user-1",
			deployedName: "Archive workflow",
			deployedDocument: JSON.stringify(document),
			deployedScope: JSON.stringify({ serviceTypes: ["RADARR"], instanceIds: [] }),
			deployedActions: JSON.stringify([{ type: "apply_tag", tagName: "archive" }]),
			deploymentVersion: 1,
		};

		const result = await executeCrossDomainRule(deps, rule);

		expect(result.status).toBe("failed");
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					lastError: "Evaluation context could not be built; no tags were changed.",
				}),
			}),
		);
		expect(upsert).not.toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					lastError: "Matched item disappeared before tag action",
				}),
			}),
		);
	});
});
