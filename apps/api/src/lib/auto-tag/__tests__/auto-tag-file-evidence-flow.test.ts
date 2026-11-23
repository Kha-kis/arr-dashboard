import { createServer } from "node:http";
import { RadarrClient } from "arr-sdk";
import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoTagRule, ServiceInstance, User } from "../../prisma.js";
import type { AutoTagRuleInput } from "../execute-rule.js";
import { adaptLiveArrItemForAutoTag } from "../live-arr-evidence.js";

vi.mock("../../library-cleanup/cleanup-executor.js", () => ({
	buildEvalContextWithHealth: vi.fn(async () => ({
		ctx: { now: new Date() },
		failedSources: new Set(),
	})),
}));
vi.mock("../../label-sync/trigger-for-item.js", () => ({
	triggerLabelSyncForItem: vi.fn(async () => {}),
}));

import { executeAutoTagRule } from "../execute-rule.js";
import { processWebhook } from "../webhook-handler.js";

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as FastifyBaseLogger;
const instance = {
	id: "synthetic-radarr",
	userId: "owner",
	service: "RADARR",
	enabled: true,
	connectionGeneration: 1,
	identityGeneration: 1,
	baseUrl: "http://synthetic.invalid",
	encryptedApiKey: "synthetic",
	encryptionIv: "synthetic",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
} as ServiceInstance;
const rule: AutoTagRuleInput = {
	id: "rule",
	userId: "owner",
	name: "Codec rule",
	ruleType: "video_codec",
	parameters: { operator: "is", codecs: ["h265"] },
	operator: null,
	conditions: null,
	serviceFilter: null,
	instanceFilter: null,
	excludeTags: null,
	excludeTitles: null,
	plexLibraryFilter: null,
	tagName: "codec",
};
const movie = (over: Record<string, unknown> = {}) => ({
	id: 100,
	title: "Synthetic movie",
	monitored: true,
	hasFile: true,
	movieFileId: 77,
	movieFile: { id: 77, mediaInfo: null },
	tags: [],
	qualityProfileId: 2,
	path: "/synthetic/movie",
	minimumAvailability: "released",
	...over,
});
function setup() {
	const client = {
		movie: {
			getById: vi.fn(async (_id: number) => movie()),
			update: vi.fn(async (_id: number, _value: Record<string, unknown>) => ({})),
		},
		movieFile: {
			getById: vi.fn(async (_id: number) => ({
				id: 77,
				movieId: 100,
				mediaInfo: { videoCodec: "h265", width: 3840, height: 2160 },
			})),
		},
		tag: {
			getAll: vi.fn(async () => [{ id: 7, label: "codec" }]),
			create: vi.fn(async () => ({ id: 7, label: "codec" })),
		},
	};
	const cached = adaptLiveArrItemForAutoTag(
		movie({ movieFile: { id: 77, videoCodec: "h265", resolution: "3840x2160" } }),
		{ instanceId: instance.id, arrItemId: 100, itemType: "movie" },
	);
	const prisma = {
		serviceInstance: {
			findMany: vi.fn(async () => [instance]),
			findFirst: vi.fn(async () => ({ id: instance.id })),
		},
		libraryCache: { findMany: vi.fn(async () => [cached]) },
		autoTagRule: {
			findMany: vi.fn(async () => [
				{
					...rule,
					enabled: true,
					parameters: JSON.stringify(rule.parameters),
				} as unknown as AutoTagRule,
			]),
		},
	};
	const deps = {
		prisma: prisma as never,
		arrClientFactory: { create: () => client } as never,
		encryptor: {} as never,
		log,
	};
	return {
		client,
		prisma,
		deps,
		run: async (kind: "scheduled" | "webhook", r = rule) => {
			prisma.autoTagRule.findMany.mockResolvedValue([
				{
					...r,
					enabled: true,
					parameters: JSON.stringify(r.parameters),
					conditions: r.conditions ? JSON.stringify(r.conditions) : null,
				} as unknown as AutoTagRule,
			]);
			return kind === "scheduled"
				? executeAutoTagRule({ ...deps, rule: r })
				: processWebhook({
						deps,
						user: { id: "owner" } as User,
						instance,
						payload: { eventType: "Download", movie: { id: 100 } },
					});
		},
	};
}

describe.each(["scheduled", "webhook"] as const)("%s uses actual file evidence", (kind) => {
	beforeEach(() => vi.clearAllMocks());
	it("hydrates the reported missing embedded codec and preserves a complete raw PUT", async () => {
		const f = setup();
		await f.run(kind);
		expect(f.client.movie.update).toHaveBeenCalledWith(100, { ...movie(), tags: [7] });
		expect(f.client.movieFile.getById).toHaveBeenCalledWith(77);
		expect(f.client.movie.update).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ id: 78, movieId: 100 },
		{ id: 77, movieId: 999 },
		{ id: 77 },
		{ id: "77", movieId: 100 },
	])("does not use inconsistent external file identity %j", async (identity) => {
		const f = setup();
		f.client.movieFile.getById.mockResolvedValue({
			...identity,
			mediaInfo: { videoCodec: "h265" },
		} as never);
		await f.run(kind);
		expect(f.client.movie.update).not.toHaveBeenCalled();
		expect(f.client.tag.create).not.toHaveBeenCalled();
	});
	it("keeps a missing file endpoint unknown, then recovers without duplicating a tag", async () => {
		const f = setup();
		f.client.movieFile.getById.mockRejectedValueOnce(new Error("synthetic unavailable"));
		await f.run(kind);
		expect(f.client.movie.update).not.toHaveBeenCalled();
		await f.run(kind);
		expect(f.client.movie.update).toHaveBeenCalledTimes(1);
	});
	it("refuses a file replacement between the two movie reads", async () => {
		const f = setup();
		f.client.movie.getById
			.mockResolvedValueOnce(movie())
			.mockResolvedValue(movie({ movieFileId: 88, movieFile: { id: 88 } }));
		await f.run(kind);
		expect(f.client.movie.update).not.toHaveBeenCalled();
		expect(f.client.tag.create).not.toHaveBeenCalled();
	});
	it("rejects connection loss during the file request", async () => {
		const f = setup();
		f.client.movieFile.getById.mockImplementation(async () => {
			f.prisma.serviceInstance.findFirst.mockResolvedValue(null as never);
			return { id: 77, movieId: 100, mediaInfo: { videoCodec: "h265", width: 3840, height: 2160 } };
		});
		await f.run(kind);
		expect(f.client.movie.update).not.toHaveBeenCalled();
		expect(f.client.tag.create).not.toHaveBeenCalled();
		expect(f.prisma.serviceInstance.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: instance.id,
					userId: "owner",
					connectionGeneration: 1,
					identityGeneration: 1,
				}),
			}),
		);
	});
	it("checks connection again after tag listing and before creating a tag", async () => {
		const f = setup();
		f.client.tag.getAll.mockImplementation(async () => {
			f.prisma.serviceInstance.findFirst.mockResolvedValue(null as never);
			return [];
		});
		await f.run(kind);
		expect(f.client.tag.create).not.toHaveBeenCalled();
		expect(f.client.movie.update).not.toHaveBeenCalled();
	});
	it("merges concurrent tags and latest full resource fields after tag listing", async () => {
		const f = setup();
		let current = movie();
		f.client.movie.getById.mockImplementation(async () => current);
		f.client.tag.getAll.mockImplementation(async () => {
			current = movie({ tags: [3, 5], qualityProfileId: 9, minimumAvailability: "announced" });
			return [{ id: 7, label: "codec" }];
		});
		await f.run(kind);
		expect(f.client.movie.update).toHaveBeenCalledWith(100, { ...current, tags: [3, 5, 7] });
		expect(current.movieFile).toEqual({ id: 77, mediaInfo: null });
	});
	it("revalidates metadata after tag listing instead of sending an obsolete match", async () => {
		const f = setup();
		f.client.tag.getAll.mockImplementation(async () => {
			f.client.movieFile.getById.mockResolvedValue({
				id: 77,
				movieId: 100,
				mediaInfo: { videoCodec: "h264", width: 3840, height: 2160 },
			});
			return [{ id: 7, label: "codec" }];
		});
		await f.run(kind);
		expect(f.client.movie.update).not.toHaveBeenCalled();
	});
	it("keeps independent rules usable without invoking the file endpoint", async () => {
		const f = setup();
		f.client.movieFile.getById.mockRejectedValue(new Error("must not fetch"));
		await f.run(kind, { ...rule, ruleType: "monitored", parameters: {} });
		expect(f.client.movieFile.getById).not.toHaveBeenCalled();
		expect(f.client.movie.update).toHaveBeenCalledTimes(1);
	});
	it.each(["OR", "AND"] as const)(
		"preserves %s truth with missing file evidence",
		async (operator) => {
			const f = setup();
			f.client.movieFile.getById.mockRejectedValue(new Error("synthetic unavailable"));
			await f.run(kind, {
				...rule,
				ruleType: "composite",
				operator,
				conditions: [
					{ ruleType: "video_codec", parameters: rule.parameters },
					{ ruleType: "monitored", parameters: {} },
				],
			});
			expect(f.client.movie.update).toHaveBeenCalledTimes(operator === "OR" ? 1 : 0);
		},
	);
	it("keeps an unsuccessful write retryable and concurrent successful repeats idempotent", async () => {
		const f = setup();
		let current = movie();
		f.client.movie.getById.mockImplementation(async () => current);
		f.client.movie.update
			.mockRejectedValueOnce(new Error("synthetic write failed"))
			.mockImplementation(async (_id, value) => {
				current = value as ReturnType<typeof movie>;
				return {};
			});
		await f.run(kind);
		expect(f.client.movie.update).toHaveBeenCalledTimes(1);
		expect(current.tags).toEqual([]);
		await Promise.all([f.run(kind), f.run(kind)]);
		expect(f.client.movie.update).toHaveBeenCalledTimes(2);
		expect(current.tags).toEqual([7]);
	});
});

it("preview remains cache-only and never creates a mutation client", async () => {
	const f = setup();
	const factory = vi.fn(() => f.client);
	const result = await executeAutoTagRule({
		...f.deps,
		arrClientFactory: { create: factory } as never,
		rule,
		dryRun: true,
	});
	expect(result.preview?.items[0]?.state).toBe("true");
	expect(factory).not.toHaveBeenCalled();
	expect(f.client.movieFile.getById).not.toHaveBeenCalled();
	expect(f.client.movie.update).not.toHaveBeenCalled();
});

describe.each(["scheduled", "webhook"] as const)(
	"%s with the actual SDK and owned HTTP fixture",
	(kind) => {
		it("reads the exact movie file and writes the complete current movie once", async () => {
			const f = setup();
			const writes: unknown[] = [];
			const requests: string[] = [];
			let current = movie();
			const server = createServer(async (req, res) => {
				const route = (req.url ?? "").split("?")[0];
				requests.push(`${req.method} ${route}`);
				res.setHeader("content-type", "application/json");
				if (req.method === "GET" && route === "/api/v3/movie/100")
					return res.end(JSON.stringify(current));
				if (req.method === "GET" && route === "/api/v3/moviefile/77")
					return res.end(
						JSON.stringify({
							id: 77,
							movieId: 100,
							mediaInfo: { videoCodec: "h265", width: 3840, height: 2160 },
						}),
					);
				if (req.method === "GET" && route === "/api/v3/tag") {
					current = movie({ tags: [3, 5], qualityProfileId: 9 });
					return res.end(JSON.stringify([{ id: 7, label: "codec" }]));
				}
				if (req.method === "PUT" && route === "/api/v3/movie/100") {
					let body = "";
					for await (const chunk of req) {
						body += chunk.toString();
						if (body.length > 65536) {
							res.statusCode = 413;
							return res.end("{}");
						}
					}
					const value = JSON.parse(body);
					writes.push(value);
					return res.end(JSON.stringify(value));
				}
				res.statusCode = 404;
				res.end("{}");
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			try {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Fixture did not bind");
				const local = { ...instance, baseUrl: `http://127.0.0.1:${address.port}` };
				const client = new RadarrClient({
					baseUrl: local.baseUrl,
					apiKey: "synthetic-fixture-only",
					timeout: 3000,
				});
				const deps = { ...f.deps, arrClientFactory: { create: () => client } as never };
				f.prisma.serviceInstance.findMany.mockResolvedValue([local]);
				if (kind === "scheduled") await executeAutoTagRule({ ...deps, rule });
				else
					await processWebhook({
						deps,
						user: { id: "owner" } as User,
						instance: local,
						payload: { eventType: "Download", movie: { id: 100 } },
					});
				expect(writes).toEqual([{ ...current, tags: [3, 5, 7] }]);
				expect(requests).toContain("GET /api/v3/moviefile/77");
				expect(requests.filter((request) => request.startsWith("PUT "))).toEqual([
					"PUT /api/v3/movie/100",
				]);
				expect(
					requests.every(
						(request) =>
							/^GET \/api\/v3\/(movie\/100|moviefile\/77|tag)$/.test(request) ||
							request === "PUT /api/v3/movie/100",
					),
				).toBe(true);
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			}
			expect(server.listening).toBe(false);
		});
	},
);

describe.each(["scheduled", "webhook"] as const)("RG-01 %s file-criterion OR", (kind) => {
	it("does not turn known video OR missing audio into unknown on enrichment failure", async () => {
		const f = setup();
		f.client.movie.getById.mockResolvedValue(movie({ movieFile: { id: 77, videoCodec: "h265" } }));
		f.client.movieFile.getById.mockRejectedValue(new Error("synthetic unavailable"));
		await f.run(kind, {
			...rule,
			ruleType: "composite",
			operator: "OR",
			conditions: [
				{ ruleType: "video_codec", parameters: rule.parameters },
				{ ruleType: "audio_codec", parameters: { operator: "is", codecs: ["DTS"] } },
			],
		});
		expect(f.client.movie.update).toHaveBeenCalledTimes(1);
	});
});
it("RG-01 webhook independent audio rule does not poison current known video", async () => {
	const f = setup();
	f.client.movie.getById.mockResolvedValue(movie({ movieFile: { id: 77, videoCodec: "h265" } }));
	f.client.movieFile.getById.mockRejectedValue(new Error("synthetic unavailable"));
	f.prisma.autoTagRule.findMany.mockResolvedValue([
		{ ...rule, enabled: true, parameters: JSON.stringify(rule.parameters) },
		{
			...rule,
			id: "audio",
			tagName: "audio",
			enabled: true,
			ruleType: "audio_codec",
			parameters: JSON.stringify({ operator: "is", codecs: ["DTS"] }),
		},
	] as unknown as AutoTagRule[]);
	await processWebhook({
		deps: f.deps,
		user: { id: "owner" } as User,
		instance,
		payload: { eventType: "Download", movie: { id: 100 } },
	});
	expect(f.client.movie.update).toHaveBeenCalledWith(100, expect.objectContaining({ tags: [7] }));
	expect(f.client.tag.create).not.toHaveBeenCalled();
});

describe.each(["scheduled", "webhook"] as const)("RG-D01 %s independent agreed fields", (kind) => {
	it("preserves an agreed video OR branch when a different requested field conflicts", async () => {
		const f = setup();
		f.client.movie.getById.mockResolvedValue(
			movie({ movieFile: { id: 77, videoCodec: "h265", audioCodec: "DTS" } }),
		);
		f.client.movieFile.getById.mockResolvedValue({
			id: 77,
			movieId: 100,
			mediaInfo: { videoCodec: "h265", audioCodec: "AAC" },
		} as never);
		await f.run(kind, {
			...rule,
			ruleType: "composite",
			operator: "OR",
			conditions: [
				{ ruleType: "video_codec", parameters: rule.parameters },
				{ ruleType: "audio_codec", parameters: { operator: "is", codecs: ["DTS"] } },
				{ ruleType: "release_group", parameters: { operator: "is", groups: ["Synthetic"] } },
			],
		});
		expect(f.client.movie.update).toHaveBeenCalledTimes(1);
	});
});

describe.each(["scheduled", "webhook"] as const)("AT-HDR-01 %s missing dynamic range", (kind) => {
	const noHdrRule = { ...rule, ruleType: "hdr_type", parameters: { operator: "none" } };
	it("does not create a tag or PUT from an absent embedded file and mediaInfo:null", async () => {
		const f = setup();
		f.client.movie.getById.mockResolvedValue(movie({ movieFile: undefined }) as never);
		f.client.movieFile.getById.mockResolvedValue({
			id: 77,
			movieId: 100,
			mediaInfo: null,
		} as never);
		f.client.tag.getAll.mockResolvedValue([]);
		await f.run(kind, noHdrRule);
		expect(f.client.tag.create).not.toHaveBeenCalled();
		expect(f.client.movie.update).not.toHaveBeenCalled();
	});
	it("rechecks HDR availability after tag listing before any create or PUT", async () => {
		const f = setup();
		f.client.movie.getById.mockResolvedValue(movie({ movieFile: undefined }) as never);
		f.client.movieFile.getById.mockResolvedValue({
			id: 77,
			movieId: 100,
			videoDynamicRange: "",
		} as never);
		f.client.tag.getAll.mockImplementation(async () => {
			f.client.movieFile.getById.mockResolvedValue({
				id: 77,
				movieId: 100,
				mediaInfo: null,
			} as never);
			return [];
		});
		await f.run(kind, noHdrRule);
		expect(f.client.tag.create).not.toHaveBeenCalled();
		expect(f.client.movie.update).not.toHaveBeenCalled();
	});
	it("keeps an independently known codec OR branch usable when HDR is missing", async () => {
		const f = setup();
		f.client.movie.getById.mockResolvedValue(movie({ movieFile: undefined }) as never);
		await f.run(kind, {
			...rule,
			ruleType: "composite",
			operator: "OR",
			conditions: [
				{ ruleType: "hdr_type", parameters: { operator: "none" } },
				{ ruleType: "video_codec", parameters: rule.parameters },
			],
		});
		expect(f.client.movie.update).toHaveBeenCalledWith(100, {
			...movie({ movieFile: undefined }),
			tags: [7],
		});
	});
	it("retains an explicitly observed empty dynamic range as none", async () => {
		const f = setup();
		f.client.movie.getById.mockResolvedValue(movie({ movieFile: undefined }) as never);
		f.client.movieFile.getById.mockResolvedValue({
			id: 77,
			movieId: 100,
			mediaInfo: { videoDynamicRange: "" },
		} as never);
		await f.run(kind, noHdrRule);
		expect(f.client.movie.update).toHaveBeenCalledWith(100, {
			...movie({ movieFile: undefined }),
			tags: [7],
		});
	});
});
