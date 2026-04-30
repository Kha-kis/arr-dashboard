/**
 * Executor orchestration tests.
 *
 * The executor is pure orchestration over the strategy registry. We mock the
 * registry with fake readers + writers and verify the executor wires them up
 * correctly under each path: happy, same-service, missing instance, source
 * failures, partial results.
 *
 * Per-strategy reader/writer logic is covered in their own test files.
 */

import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";
import type {
	DestWriteResult,
	DestWriter,
	MatchCandidate,
	SourceReader,
	SourceReadResult,
} from "../strategy-types.js";

// Hoist-friendly mock holders — vi.mock factories run before imports, so we
// reach into these from tests via `mockState.*` to override per-test.
type Spy = ReturnType<typeof vi.fn<(arg: unknown) => void>>;

const mockState: {
	sonarrReadResult: SourceReadResult;
	plexReadResult: SourceReadResult;
	plexWriteResult: DestWriteResult;
	sonarrWriteResult: DestWriteResult;
	sourceReaderSpy: Spy;
	destWriterSpy: Spy;
} = {
	sonarrReadResult: { matches: [], failed: false },
	plexReadResult: { matches: [], failed: false },
	plexWriteResult: { matchesFound: 0, labelsApplied: 0, failures: 0 },
	sonarrWriteResult: { matchesFound: 0, labelsApplied: 0, failures: 0 },
	sourceReaderSpy: vi.fn<(arg: unknown) => void>(),
	destWriterSpy: vi.fn<(arg: unknown) => void>(),
};

vi.mock("../strategy-registry.js", () => {
	const sonarrReader: SourceReader = {
		prismaService: "SONARR",
		readTaggedItems: vi.fn(async (opts) => {
			mockState.sourceReaderSpy(opts);
			return mockState.sonarrReadResult;
		}),
	};
	const plexReader: SourceReader = {
		prismaService: "PLEX",
		readTaggedItems: vi.fn(async (opts) => {
			mockState.sourceReaderSpy(opts);
			return mockState.plexReadResult;
		}),
	};
	const plexWriter: DestWriter = {
		prismaService: "PLEX",
		applyLabels: vi.fn(async (opts) => {
			mockState.destWriterSpy(opts);
			return mockState.plexWriteResult;
		}),
	};
	const sonarrWriter: DestWriter = {
		prismaService: "SONARR",
		applyLabels: vi.fn(async (opts) => {
			mockState.destWriterSpy(opts);
			return mockState.sonarrWriteResult;
		}),
	};
	return {
		SOURCE_READERS: { sonarr: sonarrReader, plex: plexReader },
		DEST_WRITERS: { plex: plexWriter, sonarr: sonarrWriter },
	};
});

import { executeLabelSyncRule, type LabelSyncRuleInput } from "../execute-rule.js";

const fakeLogger = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeInstance(overrides: Partial<ServiceInstance> = {}): ServiceInstance {
	return {
		id: "inst-source",
		userId: "user-1",
		service: "SONARR",
		label: "Sonarr",
		baseUrl: "http://sonarr:8989",
		externalUrl: null,
		encryptedApiKey: "x",
		encryptionIv: "y",
		enabled: true,
		isDefault: true,
		storageGroupId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as ServiceInstance;
}

function makeRule(overrides: Partial<LabelSyncRuleInput> = {}): LabelSyncRuleInput {
	return {
		id: "rule-1",
		userId: "user-1",
		sourceService: "sonarr",
		sourceInstanceId: "inst-source",
		sourceTagName: "kids",
		destService: "plex",
		destInstanceId: "inst-dest",
		destTagName: "Kids",
		...overrides,
	};
}

function makeMatch(tmdbId: number, mediaType: "series" | "movie" = "series"): MatchCandidate {
	return { tmdbId, title: `Title ${tmdbId}`, mediaType };
}

describe("executeLabelSyncRule (orchestration)", () => {
	beforeEach(() => {
		mockState.sonarrReadResult = { matches: [], failed: false };
		mockState.plexReadResult = { matches: [], failed: false };
		mockState.plexWriteResult = { matchesFound: 0, labelsApplied: 0, failures: 0 };
		mockState.sonarrWriteResult = { matchesFound: 0, labelsApplied: 0, failures: 0 };
		mockState.sourceReaderSpy.mockClear();
		mockState.destWriterSpy.mockClear();
	});

	it("happy path: arr source → plex dest, all matches applied", async () => {
		mockState.sonarrReadResult = {
			matches: [makeMatch(123), makeMatch(456)],
			failed: false,
		};
		mockState.plexWriteResult = { matchesFound: 2, labelsApplied: 2, failures: 0 };

		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([makeInstance()]),
				findFirst: vi
					.fn()
					.mockResolvedValue(makeInstance({ id: "inst-dest", service: "PLEX", label: "Plex" })),
			},
		};

		const result = await executeLabelSyncRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});

		expect(result.status).toBe("success");
		expect(result.totals.taggedItemsFound).toBe(2);
		expect(result.totals.labelsApplied).toBe(2);
		expect(mockState.sourceReaderSpy).toHaveBeenCalledTimes(1);
		expect(mockState.destWriterSpy).toHaveBeenCalledTimes(1);
	});

	it("same-service rule (sonarr → sonarr) — same Prisma service is used for both lookups", async () => {
		mockState.sonarrReadResult = { matches: [makeMatch(789)], failed: false };
		mockState.sonarrWriteResult = { matchesFound: 1, labelsApplied: 1, failures: 0 };

		const findFirst = vi.fn().mockResolvedValue(makeInstance({ id: "inst-dest" }));
		const findMany = vi.fn().mockResolvedValue([makeInstance()]);
		const prisma = { serviceInstance: { findMany, findFirst } };

		const result = await executeLabelSyncRule({
			rule: makeRule({ destService: "sonarr" }),
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});

		expect(result.status).toBe("success");
		expect(findMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ service: "SONARR" }),
		});
		expect(findFirst).toHaveBeenCalledWith({
			where: expect.objectContaining({ service: "SONARR", id: "inst-dest" }),
		});
	});

	it("plex → sonarr (reverse direction) routes to the right reader/writer pair", async () => {
		mockState.plexReadResult = { matches: [makeMatch(100, "movie")], failed: false };
		mockState.sonarrWriteResult = { matchesFound: 1, labelsApplied: 1, failures: 0 };

		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([makeInstance({ service: "PLEX" })]),
				findFirst: vi.fn().mockResolvedValue(makeInstance({ id: "inst-dest" })),
			},
		};

		const result = await executeLabelSyncRule({
			rule: makeRule({ sourceService: "plex", destService: "sonarr" }),
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});

		expect(result.status).toBe("success");
		expect(prisma.serviceInstance.findMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ service: "PLEX" }),
		});
	});

	it("unsupported sourceService returns a failed result with structured message", async () => {
		const result = await executeLabelSyncRule({
			rule: makeRule({ sourceService: "lidarr" }),
			prisma: { serviceInstance: { findMany: vi.fn(), findFirst: vi.fn() } } as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});
		expect(result.status).toBe("failed");
		expect(result.message).toMatch(/Unsupported sourceService/i);
	});

	it("no enabled source instance → failed without invoking reader", async () => {
		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([]),
				findFirst: vi.fn(),
			},
		};

		const result = await executeLabelSyncRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});

		expect(result.status).toBe("failed");
		expect(mockState.sourceReaderSpy).not.toHaveBeenCalled();
	});

	it("missing dest instance → failed without invoking writer", async () => {
		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([makeInstance()]),
				findFirst: vi.fn().mockResolvedValue(null),
			},
		};

		const result = await executeLabelSyncRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});

		expect(result.status).toBe("failed");
		expect(mockState.destWriterSpy).not.toHaveBeenCalled();
	});

	it("source read failure with no candidates → failed", async () => {
		mockState.sonarrReadResult = { matches: [], failed: true };

		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([makeInstance()]),
				findFirst: vi.fn().mockResolvedValue(makeInstance({ id: "inst-dest" })),
			},
		};

		const result = await executeLabelSyncRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});

		expect(result.status).toBe("failed");
		expect(result.totals.failures).toBe(1);
		expect(mockState.destWriterSpy).not.toHaveBeenCalled();
	});

	it("partial result when writer reports some failures", async () => {
		mockState.sonarrReadResult = {
			matches: [makeMatch(1), makeMatch(2), makeMatch(3)],
			failed: false,
		};
		mockState.plexWriteResult = { matchesFound: 3, labelsApplied: 2, failures: 1 };

		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([makeInstance()]),
				findFirst: vi.fn().mockResolvedValue(makeInstance({ id: "inst-dest" })),
			},
		};

		const result = await executeLabelSyncRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});

		expect(result.status).toBe("partial");
		expect(result.totals.labelsApplied).toBe(2);
		expect(result.totals.failures).toBe(1);
	});

	it("zero candidates with no failures → success with 'no items' message", async () => {
		mockState.sonarrReadResult = { matches: [], failed: false };

		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([makeInstance()]),
				findFirst: vi.fn().mockResolvedValue(makeInstance({ id: "inst-dest" })),
			},
		};

		const result = await executeLabelSyncRule({
			rule: makeRule(),
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});

		expect(result.status).toBe("success");
		expect(result.message).toMatch(/No items/i);
		expect(result.totals.labelsApplied).toBe(0);
		expect(mockState.destWriterSpy).not.toHaveBeenCalled();
	});

	it("rule with sourceInstanceId=null scans all enabled instances of the source service", async () => {
		mockState.sonarrReadResult = { matches: [makeMatch(50)], failed: false };
		mockState.plexWriteResult = { matchesFound: 1, labelsApplied: 1, failures: 0 };

		const findMany = vi
			.fn()
			.mockResolvedValue([makeInstance({ id: "src-a" }), makeInstance({ id: "src-b" })]);
		const prisma = {
			serviceInstance: {
				findMany,
				findFirst: vi.fn().mockResolvedValue(makeInstance({ id: "inst-dest" })),
			},
		};

		await executeLabelSyncRule({
			rule: makeRule({ sourceInstanceId: null }),
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: fakeLogger,
		});

		// findMany filter should NOT include id (covers all instances of the service)
		expect(findMany).toHaveBeenCalledWith({
			where: expect.not.objectContaining({ id: expect.anything() }),
		});
		// reader called once per source instance
		expect(mockState.sourceReaderSpy).toHaveBeenCalledTimes(2);
	});
});
