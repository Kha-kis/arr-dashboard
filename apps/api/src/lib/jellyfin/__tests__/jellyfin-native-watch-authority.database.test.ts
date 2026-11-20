import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { verifyPreparedNativeWatchGeneration } from "../jellyfin-native-watch-repository.js";

const input = () => ({
	userId: "owner",
	instanceId: "instance",
	runId: "run",
	cacheGenerationId: "generation",
	preparationToken: "token",
	connectionGeneration: 1,
	identityGeneration: 2,
	observedAt: new Date(0),
	expectedScopeCount: 0,
	candidates: [],
	receipts: [],
});
type Input = ReturnType<typeof input>;
let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
const superseded = "Native watch preparation authority was superseded";
const leaseLost = "Native watch preparation lease is unavailable";

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "native-watch-authority-"));
	const path = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${path}` },
		stdio: "ignore",
	});
	prisma = createTestPrismaClient(path);
	for (const userId of ["owner", "other-owner"]) {
		await prisma.user.create({ data: { id: userId, username: userId } });
	}
	for (const [id, userId] of [
		["instance", "owner"],
		["peer", "owner"],
		["other", "other-owner"],
	] as const) {
		await prisma.serviceInstance.create({
			data: {
				id,
				userId,
				service: "JELLYFIN",
				label: "Synthetic",
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: "cipher",
				encryptionIv: "iv",
				expectedIdentity: "server",
				identityStatus: "VERIFIED",
				connectionGeneration: 1,
				identityGeneration: 2,
			},
		});
	}
	await prisma.jellyfinNativeWatchRow.createMany({
		data: ["instance", "peer", "other"].map((instanceId) => ({
			instanceId,
			runId: "old",
			userKeyDigest: "digest",
			libraryId: "library",
			jellyfinId: "episode",
			seriesId: "series",
			seasonNumber: 1,
			episodeNumber: 1,
			played: true,
			playCount: 1,
			observedAt: new Date(0),
			connectionGeneration: 1,
			identityGeneration: 2,
		})),
	});
}, 30_000);

afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
	await prisma.jellyfinEpisodePreparation.deleteMany();
	await prisma.providerObservationRun.deleteMany();
	await prisma.jellyfinNativeWatchPublication.deleteMany();
	await prisma.serviceInstance.update({
		where: { id: "instance" },
		data: {
			enabled: true,
			service: "JELLYFIN",
			identityStatus: "VERIFIED",
			expectedIdentity: "server",
			connectionGeneration: 1,
			identityGeneration: 2,
		},
	});
	await prisma.providerObservationRun.create({
		data: {
			id: "run",
			instanceId: "instance",
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			authorityKey: "authority",
			activeSlotKey: "slot",
			targetDigest: "digest",
			targetCount: 1,
			connectionGeneration: 1,
			identityGeneration: 2,
			state: "running",
			totalUnits: 2,
			completedUnits: 2,
			totalWork: 3,
			completedWork: 3,
		},
	});
	await prisma.jellyfinEpisodePreparation.create({
		data: {
			runId: "run",
			instanceId: "instance",
			generationId: "generation",
			token: "token",
			state: "verified",
			leaseExpiresAt: new Date(Date.now() + 60_000),
		},
	});
	await prisma.jellyfinNativeWatchPublication.create({
		data: {
			instanceId: "instance",
			activeRunId: "old",
			activeCacheGenerationId: "old-generation",
			activeObservedAt: new Date(0),
			activeExpectedScopeCount: 1,
			previousRunId: "older",
			connectionGeneration: 1,
			identityGeneration: 2,
		},
	});
});

describe("native watch atomic authority metadata", () => {
	it("admits legitimately matching SQL-looking owner, instance, run, generation and token values", async () => {
		const value = {
			...input(),
			userId: "owner' OR 1=1 --",
			instanceId: "instance' OR 1=1 --",
			runId: "run' OR 1=1 --",
			cacheGenerationId: "generation' OR 1=1 --",
			preparationToken: "token' OR 1=1 --",
		};
		await prisma.user.create({ data: { id: value.userId, username: "quoted-owner" } });
		const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "instance" } });
		await prisma.serviceInstance.create({
			data: { ...instance, id: value.instanceId, userId: value.userId },
		});
		const run = await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: "run" } });
		await prisma.providerObservationRun.create({
			data: { ...run, id: value.runId, instanceId: value.instanceId, activeSlotKey: "quoted-slot" },
		});
		await prisma.jellyfinEpisodePreparation.create({
			data: {
				runId: value.runId,
				instanceId: value.instanceId,
				generationId: value.cacheGenerationId,
				token: value.preparationToken,
				state: "verified",
				leaseExpiresAt: new Date(Date.now() + 60_000),
			},
		});
		await expect(verifyPreparedNativeWatchGeneration(prisma, value)).resolves.toBeUndefined();
	});

	it("allows an absent publication and a nonnull empty active slot", async () => {
		await prisma.jellyfinNativeWatchPublication.deleteMany();
		await prisma.providerObservationRun.update({
			where: { id: "run" },
			data: { activeSlotKey: "" },
		});
		await expect(verifyPreparedNativeWatchGeneration(prisma, input())).resolves.toBeUndefined();
	});

	it("requires a lease strictly after the parameterized current Date", async () => {
		const current = new Date("2026-10-17T00:00:00.000Z");
		await prisma.jellyfinEpisodePreparation.update({
			where: { runId: "run" },
			data: { leaseExpiresAt: current },
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(current);
		try {
			await expect(verifyPreparedNativeWatchGeneration(prisma, input())).rejects.toThrow(leaseLost);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses one real metadata statement per authority check", async () => {
		let counting = false;
		const checks: number[] = [];
		const observed = prisma.$extends({
			query: {
				$allOperations({ args, query }) {
					if (counting) checks[checks.length - 1]! += 1;
					return query(args);
				},
			},
		});
		await verifyPreparedNativeWatchGeneration(
			observed as never,
			input(),
			undefined,
			({ stage }) => {
				counting = stage === "authority-check";
				if (counting) checks.push(0);
			},
		);
		expect(checks).toEqual([1, 1]);
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"admits mapped verified %s authority and Unicode-trimmed identity",
		async (service) => {
			await prisma.serviceInstance.update({
				where: { id: "instance" },
				data: { service, expectedIdentity: "\u00a0server\u202f" },
			});
			await expect(verifyPreparedNativeWatchGeneration(prisma, input())).resolves.toBeUndefined();
		},
	);

	const cases: Array<[string, (value: Input) => unknown, string]> = [
		[
			"missing run input",
			(value) => {
				value.runId = "missing";
			},
			superseded,
		],
		[
			"SQL metacharacters in owner",
			(value) => {
				value.userId = "owner' OR 1=1 --";
			},
			superseded,
		],
		[
			"SQL metacharacters in token",
			(value) => {
				value.preparationToken = "token' OR 1=1 --";
			},
			leaseLost,
		],
		...["userId", "instanceId", "runId", "preparationToken"].map(
			(field): [string, (value: Input) => void, string] => [
				`empty ${field}`,
				(value) => {
					value[field as "userId"] = "";
				},
				"Native watch preparation authority is invalid",
			],
		),
		[
			"wrong owner",
			(value) => {
				value.userId = "other-owner";
			},
			superseded,
		],
		[
			"same-owner other instance",
			(value) => {
				value.instanceId = "peer";
			},
			superseded,
		],
		[
			"cross-owner instance",
			(value) => {
				value.instanceId = "other";
			},
			superseded,
		],
		[
			"missing instance",
			(value) => {
				value.instanceId = "missing";
			},
			superseded,
		],
		[
			"disabled instance",
			() => prisma.serviceInstance.update({ where: { id: "instance" }, data: { enabled: false } }),
			superseded,
		],
		[
			"wrong service",
			() => prisma.serviceInstance.update({ where: { id: "instance" }, data: { service: "PLEX" } }),
			superseded,
		],
		[
			"unverified identity",
			() =>
				prisma.serviceInstance.update({
					where: { id: "instance" },
					data: { identityStatus: "UNVERIFIED" },
				}),
			superseded,
		],
		[
			"mismatched identity",
			() =>
				prisma.serviceInstance.update({
					where: { id: "instance" },
					data: { identityStatus: "MISMATCH" },
				}),
			superseded,
		],
		[
			"missing identity",
			() =>
				prisma.serviceInstance.update({
					where: { id: "instance" },
					data: { expectedIdentity: null },
				}),
			superseded,
		],
		[
			"Unicode blank identity",
			() =>
				prisma.serviceInstance.update({
					where: { id: "instance" },
					data: { expectedIdentity: "\u00a0\u202f\ufeff" },
				}),
			superseded,
		],
		[
			"instance connection generation",
			() =>
				prisma.serviceInstance.update({
					where: { id: "instance" },
					data: { connectionGeneration: 3 },
				}),
			superseded,
		],
		[
			"instance identity generation",
			() =>
				prisma.serviceInstance.update({
					where: { id: "instance" },
					data: { identityGeneration: 3 },
				}),
			superseded,
		],
		["missing run", () => prisma.providerObservationRun.deleteMany(), superseded],
		...[
			"instanceId",
			"provider",
			"cacheType",
			"state",
			"activeSlotKey",
			"connectionGeneration",
			"identityGeneration",
			"completedUnits",
			"completedWork",
			"totalUnits",
			"totalWork",
		].map((field): [string, () => Promise<unknown>, string] => [
			`run ${field}`,
			() =>
				prisma.providerObservationRun.update({
					where: { id: "run" },
					data: {
						[field]:
							field === "instanceId"
								? "peer"
								: field === "activeSlotKey"
									? null
									: ["provider", "cacheType", "state"].includes(field)
										? "wrong"
										: 99,
					},
				}),
			superseded,
		]),
		["missing preparation", () => prisma.jellyfinEpisodePreparation.deleteMany(), leaseLost],
		...["instanceId", "generationId", "token", "state", "leaseExpiresAt"].map(
			(field): [string, () => Promise<unknown>, string] => [
				`preparation ${field}`,
				() =>
					prisma.jellyfinEpisodePreparation.update({
						where: { runId: "run" },
						data: {
							[field]:
								field === "instanceId"
									? "peer"
									: field === "leaseExpiresAt"
										? new Date(0)
										: "wrong",
						},
					}),
				leaseLost,
			],
		),
		[
			"wrong token",
			(value) => {
				value.preparationToken = "wrong";
			},
			leaseLost,
		],
		[
			"wrong generation",
			(value) => {
				value.cacheGenerationId = "wrong";
			},
			leaseLost,
		],
		[
			"active publication",
			() =>
				prisma.jellyfinNativeWatchPublication.update({
					where: { instanceId: "instance" },
					data: { activeRunId: "run" },
				}),
			superseded,
		],
		[
			"previous publication",
			() =>
				prisma.jellyfinNativeWatchPublication.update({
					where: { instanceId: "instance" },
					data: { previousRunId: "run" },
				}),
			superseded,
		],
		[
			"superseded before missing lease",
			async () => {
				await prisma.serviceInstance.update({
					where: { id: "instance" },
					data: { enabled: false },
				});
				await prisma.jellyfinEpisodePreparation.deleteMany();
			},
			superseded,
		],
	];
	it.each(cases)(
		"rejects %s without changing prior publication or unrelated rows",
		async (_name, alter, error) => {
			const value = input();
			await alter(value);
			const pointers = await prisma.jellyfinNativeWatchPublication.findMany();
			const rows = await prisma.jellyfinNativeWatchRow.findMany({ orderBy: { id: "asc" } });
			await expect(verifyPreparedNativeWatchGeneration(prisma, value)).rejects.toThrow(error);
			expect(await prisma.jellyfinNativeWatchPublication.findMany()).toEqual(pointers);
			expect(await prisma.jellyfinNativeWatchRow.findMany({ orderBy: { id: "asc" } })).toEqual(
				rows,
			);
		},
	);
});
