import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { collectCleanupOpportunities } from "../collectors.js";

const mockLog = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeApp(
	config: {
		enabled: boolean;
		rules: Array<{ id: string }>;
		logs: Array<{
			itemsFlagged: number;
			itemsEvaluated: number;
			startedAt: Date;
		}>;
	},
	libraryCount = 0,
): FastifyInstance {
	return {
		prisma: {
			libraryCleanupConfig: {
				findFirst: vi.fn().mockResolvedValue(config),
			},
			libraryCache: {
				count: vi.fn().mockResolvedValue(libraryCount),
			},
		},
	} as unknown as FastifyInstance;
}

describe("collectCleanupOpportunities", () => {
	it.each([
		{
			name: "paused cleanup",
			config: { enabled: false, rules: [{ id: "rule-1" }], logs: [] },
			libraryCount: 0,
			signalId: "cleanup-disabled",
		},
		{
			name: "items matching cleanup rules",
			config: {
				enabled: true,
				rules: [{ id: "rule-1" }],
				logs: [
					{
						itemsFlagged: 3,
						itemsEvaluated: 100,
						startedAt: new Date("2026-07-28T12:00:00.000Z"),
					},
				],
			},
			libraryCount: 0,
			signalId: "cleanup-items-flagged",
		},
		{
			name: "no configured rules",
			config: { enabled: true, rules: [], logs: [] },
			libraryCount: 51,
			signalId: "cleanup-no-rules",
		},
	])("links $name to the library cleanup page", async ({ config, libraryCount, signalId }) => {
		const items = await collectCleanupOpportunities(
			makeApp(config, libraryCount),
			"user-1",
			mockLog,
		);

		expect(items.find((item) => item.id === signalId)?.actionUrl).toBe("/library-cleanup");
	});
});
