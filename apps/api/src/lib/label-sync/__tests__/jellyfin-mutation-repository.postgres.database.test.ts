import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	JellyfinMutationRepository,
	type MutationClaimInput,
} from "../jellyfin-mutation-repository.js";

const configuredUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
let parsedUrl: URL | undefined;
try {
	if (configuredUrl) parsedUrl = new URL(configuredUrl);
} catch {
	parsedUrl = undefined;
}
const loopbackDisposable =
	parsedUrl !== undefined &&
	["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname) &&
	parsedUrl.pathname.length > 1;
const pgDescribe = integrationEnabled && loopbackDisposable ? describe : describe.skip;

function postgresSchemaSource(source: string, schema: string): string {
	const lines = source
		.replace('provider = "sqlite"', `provider = "postgresql"\n  schemas = ["${schema}"]`)
		.replace('output   = "../src/generated/prisma"', 'output   = "./generated"')
		.split("\n");
	const output: string[] = [];
	let block: "model" | "enum" | null = null;
	let depth = 0;
	for (const line of lines) {
		const declaration = /^(model|enum)\s+\w+\s*\{/.exec(line);
		if (declaration) {
			block = declaration[1] as "model" | "enum";
			depth = 1;
			output.push(line);
			continue;
		}
		if (block && line.trim() === "}" && depth === 1) {
			output.push(`  @@schema("${schema}")`);
			output.push(line);
			block = null;
			continue;
		}
		if (block) depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		output.push(line);
	}
	return output.join("\n");
}

pgDescribe("JellyfinMutationRepository PostgreSQL serializable races", () => {
	let adminPool: Pool;
	let PrismaClientConstructor: any;
	const clientPools: Pool[] = [];
	const clients: Array<{ $disconnect: () => Promise<void> }> = [];
	let createClient: () => any;
	let schemaUrl: string;
	let schemaName: string;
	let schemaDirectory: string;

	const makeInput = (suffix: string, tmdbId: number): MutationClaimInput => ({
		userId: `pg-user-${suffix}`,
		ruleId: `pg-rule-${suffix}`,
		destinationInstanceId: `pg-destination-${suffix}`,
		provider: "jellyfin",
		mediaType: "movie",
		tmdbId,
		connectionGeneration: 0,
		identityGeneration: 0,
		targetItemId: "target",
		libraryId: "library",
		intentFingerprint: "intent",
		ruleFingerprint: "rule",
		destinationTag: "managed",
	});

	const seedFixture = async (client: any, input: MutationClaimInput) => {
		await client.user.create({ data: { id: input.userId, username: `pg-${input.userId}` } });
		await client.serviceInstance.create({
			data: {
				id: input.destinationInstanceId,
				userId: input.userId,
				service: "JELLYFIN",
				label: "pg",
				baseUrl: "http://127.0.0.1:8096",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
			},
		});
		await client.labelSyncRule.create({
			data: {
				id: input.ruleId,
				userId: input.userId,
				name: "pg",
				sourceService: "radarr",
				sourceTagName: "source",
				destService: "jellyfin",
				destInstanceId: input.destinationInstanceId,
				destTagName: input.destinationTag,
			},
		});
	};

	const stageClient = (
		client: any,
		options: {
			onTransactionStart?: () => void;
			onParentLock?: () => Promise<void>;
			onUnknownRead?: () => Promise<void>;
			onPhysicalCount?: () => Promise<void>;
		},
	) => {
		let parentLockUsed = false;
		let unknownReadUsed = false;
		let physicalCountUsed = false;
		return {
			$transaction: (
				work: (tx: any) => Promise<any>,
				transactionOptions?: Record<string, unknown>,
			) =>
				client.$transaction(async (tx: any) => {
					options.onTransactionStart?.();
					const wrapped = new Proxy(tx, {
						get(target, property, receiver) {
							if (property === "$queryRawUnsafe") {
								return async (...args: unknown[]) => {
									const result = await Reflect.apply(target.$queryRawUnsafe, target, args);
									if (!parentLockUsed && options.onParentLock) {
										parentLockUsed = true;
										await options.onParentLock();
									}
									return result;
								};
							}
							if (property !== "labelSyncMutationAttempt")
								return Reflect.get(target, property, receiver);
							const delegate = Reflect.get(target, property, receiver);
							return new Proxy(delegate, {
								get(delegateTarget, delegateProperty, delegateReceiver) {
									const method = Reflect.get(delegateTarget, delegateProperty, delegateReceiver);
									if (delegateProperty === "count" && typeof method === "function") {
										return async (...args: unknown[]) => {
											const result = await Reflect.apply(method, delegateTarget, args);
											if (!physicalCountUsed && options.onPhysicalCount) {
												physicalCountUsed = true;
												await options.onPhysicalCount();
											}
											return result;
										};
									}
									if (delegateProperty !== "findFirst" || typeof method !== "function")
										return method;
									return async (...args: unknown[]) => {
										const result = await Reflect.apply(method, delegateTarget, args);
										if (!unknownReadUsed && options.onUnknownRead) {
											unknownReadUsed = true;
											await options.onUnknownRead();
										}
										return result;
									};
								},
							});
						},
					});
					return await work(wrapped);
				}, transactionOptions),
		};
	};

	beforeAll(async () => {
		if (!configuredUrl || !parsedUrl) return;
		schemaName = `task7b_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
		adminPool = new Pool({ connectionString: configuredUrl });
		await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
		schemaUrl = new URL(configuredUrl).toString();
		const url = new URL(schemaUrl);
		url.searchParams.set("schema", schemaName);
		url.searchParams.set("options", `-c search_path=${schemaName}`);
		schemaUrl = url.toString();
		schemaDirectory = mkdtempSync(join(tmpdir(), "task7b-pg-schema-"));
		const schemaPath = join(schemaDirectory, "schema.prisma");
		writeFileSync(
			schemaPath,
			postgresSchemaSource(
				readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8"),
				schemaName,
			),
		);
		execFileSync("pnpm", ["exec", "prisma", "generate", "--schema", schemaPath], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: schemaUrl },
			stdio: "ignore",
		});
		execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schemaPath], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: schemaUrl },
			stdio: "pipe",
		});
		const generatedClient = await import(
			/* @vite-ignore */ pathToFileURL(join(schemaDirectory, "generated/client.js")).href
		);
		PrismaClientConstructor = generatedClient.PrismaClient;
		createClient = () => {
			const pool = new Pool({ connectionString: schemaUrl });
			clientPools.push(pool);
			const client = new PrismaClientConstructor({ adapter: new PrismaPg(pool) });
			clients.push(client);
			return client;
		};
	});

	afterAll(async () => {
		await Promise.allSettled(clients.map((client) => client.$disconnect()));
		await Promise.allSettled(clientPools.map((pool) => pool.end()));
		if (adminPool && schemaName) {
			await adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`).catch(() => undefined);
			await adminPool.end().catch(() => undefined);
		}
		if (schemaDirectory) rmSync(schemaDirectory, { recursive: true, force: true });
	});

	it("uses two independent clients and gives one identical claim the token", async () => {
		if (!schemaUrl) return;
		const first = createClient();
		const second = createClient();
		try {
			const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
			const userId = `pg-user-${suffix}`;
			const ruleId = `pg-rule-${suffix}`;
			const destinationId = `pg-destination-${suffix}`;
			await first.user.create({ data: { id: userId, username: `pg-${suffix}` } });
			await first.serviceInstance.create({
				data: {
					id: destinationId,
					userId,
					service: "JELLYFIN",
					label: "pg",
					baseUrl: "http://127.0.0.1:8096",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
				},
			});
			await first.labelSyncRule.create({
				data: {
					id: ruleId,
					userId,
					name: "pg",
					sourceService: "radarr",
					sourceTagName: "source",
					destService: "jellyfin",
					destInstanceId: destinationId,
					destTagName: "managed",
				},
			});
			const input: MutationClaimInput = {
				userId,
				ruleId,
				destinationInstanceId: destinationId,
				provider: "jellyfin",
				mediaType: "movie",
				tmdbId: 7,
				connectionGeneration: 0,
				identityGeneration: 0,
				targetItemId: "target",
				libraryId: "library",
				intentFingerprint: "intent",
				ruleFingerprint: "rule",
				destinationTag: "managed",
			};
			let releaseFirstLocks!: () => void;
			let firstLockReached!: () => void;
			let secondTransactionStarted!: () => void;
			const firstLocksHeld = new Promise<void>((resolve) => {
				releaseFirstLocks = resolve;
			});
			const firstLockReady = new Promise<void>((resolve) => {
				firstLockReached = resolve;
			});
			const secondStarted = new Promise<void>((resolve) => {
				secondTransactionStarted = resolve;
			});
			const left = new JellyfinMutationRepository(
				stageClient(first, {
					onParentLock: async () => {
						firstLockReached();
						await firstLocksHeld;
					},
				}),
				{ databaseProvider: "postgresql", tokenFactory: () => "first-token" },
			);
			const right = new JellyfinMutationRepository(
				stageClient(second, { onTransactionStart: secondTransactionStarted }),
				{ databaseProvider: "postgresql", tokenFactory: () => "second-token" },
			);
			const firstClaim = left.claim(input);
			await firstLockReady;
			const secondClaim = right.claim(input);
			await secondStarted;
			releaseFirstLocks();
			const [leftResult, rightResult] = await Promise.all([firstClaim, secondClaim]);
			expect([leftResult.kind, rightResult.kind].sort()).toEqual(["acquired", "already-active"]);
			const acquired = leftResult.kind === "acquired" ? leftResult : rightResult;
			if (acquired.kind !== "acquired") throw new Error("claim race did not acquire");
			expect(acquired.claimToken).toBe("first-token");
			await expect(first.labelSyncMutationAttempt.count({ where: { userId } })).resolves.toBe(1);
			await expect(
				first.labelSyncMutationAttempt.findMany({ where: { userId } }),
			).resolves.toHaveLength(1);
		} finally {
			await first.$disconnect();
			await second.$disconnect();
		}
	});

	it("serializes empty physical-target reads across owners and connection aliases", async () => {
		const first = createClient();
		const second = createClient();
		const suffix = `physical_${Date.now()}`;
		const leftInput = makeInput(`${suffix}_left`, 501);
		const rightInput = { ...makeInput(`${suffix}_right`, 502), destinationTag: "other" };
		await seedFixture(first, leftInput);
		await seedFixture(first, rightInput);
		const expectedIdentity = `physical-server-${suffix}`;
		await first.serviceInstance.updateMany({
			where: { id: { in: [leftInput.destinationInstanceId, rightInput.destinationInstanceId] } },
			data: { expectedIdentity, identityKind: "JELLYFIN_SERVER_ID", identityStatus: "VERIFIED" },
		});
		let arrived = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onPhysicalCount = async () => {
			if (++arrived === 2) release();
			await barrier;
		};
		const left = new JellyfinMutationRepository(stageClient(first, { onPhysicalCount }), {
			databaseProvider: "postgresql",
		});
		const right = new JellyfinMutationRepository(stageClient(second, { onPhysicalCount }), {
			databaseProvider: "postgresql",
		});
		const results = await Promise.all([
			left.claimPhysicalTarget(leftInput, expectedIdentity),
			right.claimPhysicalTarget(rightInput, expectedIdentity),
		]);
		expect(results.map((result) => result.kind).sort()).toEqual(["acquired", "target-busy"]);
		expect(results.find((result) => result.kind === "target-busy")).toEqual({
			kind: "target-busy",
		});
		expect(
			await first.labelSyncMutationAttempt.count({
				where: { userId: { in: [leftInput.userId, rightInput.userId] } },
			}),
		).toBe(1);
	}, 30_000);

	it("serializes delayed reconcilers and fences parent deletion", async () => {
		if (!schemaUrl) return;
		const first = createClient();
		const second = createClient();
		try {
			const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
			const input = makeInput(suffix, 8);
			await seedFixture(first, input);
			const leftRepo = new JellyfinMutationRepository(first, {
				databaseProvider: "postgresql",
				tokenFactory: () => "send-token",
			});
			const rightRepo = new JellyfinMutationRepository(second, {
				databaseProvider: "postgresql",
				tokenFactory: () => "reconcile-token",
			});
			const claim = await leftRepo.claim(input);
			expect(claim.kind).toBe("acquired");
			if (claim.kind !== "acquired") return;
			await leftRepo.markSending({
				id: claim.id,
				userId: input.userId,
				ruleId: input.ruleId,
				destinationInstanceId: input.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
				claimToken: claim.claimToken,
				sendAttemptCount: 0,
			});
			await leftRepo.completeSend({
				id: claim.id,
				userId: input.userId,
				ruleId: input.ruleId,
				destinationInstanceId: input.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
				claimToken: claim.claimToken,
				sendAttemptCount: 1,
				status: "unknown",
			});
			const handle = await leftRepo.claim(input);
			expect(handle.kind).toBe("existing-unknown");
			if (handle.kind !== "existing-unknown") return;
			let reads = 0;
			let releaseReads!: () => void;
			const bothRead = new Promise<void>((resolve) => {
				releaseReads = resolve;
			});
			const awaitBothReads = async () => {
				reads += 1;
				if (reads === 2) releaseReads();
				await bothRead;
			};
			const acquire = (client: any, token: string) => {
				const staged = new JellyfinMutationRepository(
					stageClient(client, { onUnknownRead: awaitBothReads }),
					{ databaseProvider: "postgresql", tokenFactory: () => token },
				);
				return staged.acquireReconciliation({
					id: handle.id,
					userId: input.userId,
					ruleId: input.ruleId,
					destinationInstanceId: input.destinationInstanceId,
					activeOperationKey: handle.activeOperationKey,
				});
			};
			const [one, two] = await Promise.all([
				acquire(first, "reconcile-token-1"),
				acquire(second, "reconcile-token-2"),
			]);
			expect([one.kind, two.kind].sort()).toEqual(["acquired", "already-owned"]);
			const winner = one.kind === "acquired" ? one : two;
			if (winner.kind !== "acquired") throw new Error("reconciliation race did not acquire");
			await expect(
				first.labelSyncMutationAttempt.findUnique({ where: { id: handle.id } }),
			).resolves.toMatchObject({
				status: "unknown",
				reconcileAttemptCount: 1,
				claimToken: winner.claimToken,
				activeOperationKey: handle.activeOperationKey,
			});
			await expect(
				(rightRepo as JellyfinMutationRepository).completeReconciliation({
					id: handle.id,
					userId: input.userId,
					ruleId: input.ruleId,
					destinationInstanceId: input.destinationInstanceId,
					activeOperationKey: handle.activeOperationKey,
					claimToken: winner.claimToken,
					reconcileAttemptCount: winner.reconcileAttemptCount,
					outcome: { status: "unknown", reasonCode: "reconciliation_unavailable" },
				}),
			).resolves.toEqual({ kind: "applied", status: "unknown" });
			await expect(
				first.labelSyncMutationAttempt.findUnique({ where: { id: handle.id } }),
			).resolves.toMatchObject({ status: "unknown", claimToken: null, reconcileAttemptCount: 1 });
			await expect(
				leftRepo.deleteRuleGuarded({ userId: input.userId, ruleId: input.ruleId }),
			).rejects.toMatchObject({ category: "conflict" });
			await expect(
				leftRepo.deleteDestinationGuarded({
					userId: input.userId,
					destinationInstanceId: input.destinationInstanceId,
				}),
			).rejects.toMatchObject({ category: "conflict" });
		} finally {
			await first.$disconnect();
			await second.$disconnect();
		}
	});

	it("holds canonical parent locks across a claim and rule deletion race", async () => {
		if (!schemaUrl) return;
		const first = createClient();
		const second = createClient();
		try {
			const input = makeInput(`${Date.now()}_${Math.floor(Math.random() * 100000)}`, 11);
			await seedFixture(first, input);
			let releaseClaimLocks!: () => void;
			let claimLockReached!: () => void;
			const claimLockReady = new Promise<void>((resolve) => {
				claimLockReached = resolve;
			});
			let deletionStarted!: () => void;
			const claimLocksHeld = new Promise<void>((resolve) => {
				releaseClaimLocks = resolve;
			});
			const deletionEntered = new Promise<void>((resolve) => {
				deletionStarted = resolve;
			});
			const claimant = new JellyfinMutationRepository(
				stageClient(first, {
					onParentLock: async () => {
						claimLockReached();
						await claimLocksHeld;
					},
				}),
				{ databaseProvider: "postgresql", tokenFactory: () => "race-token" },
			);
			const deleter = new JellyfinMutationRepository(
				stageClient(second, { onTransactionStart: deletionStarted }),
				{ databaseProvider: "postgresql" },
			);
			const claimPromise = claimant.claim(input);
			await claimLockReady;
			const deletionPromise = deleter.deleteRuleGuarded({
				userId: input.userId,
				ruleId: input.ruleId,
			});
			await deletionEntered;
			releaseClaimLocks();
			const [claimResult, deletionResult] = await Promise.allSettled([
				claimPromise,
				deletionPromise,
			]);
			expect(claimResult.status).toBe("fulfilled");
			expect(deletionResult.status).toBe("rejected");
			const remainingRule = await first.labelSyncRule.findUnique({ where: { id: input.ruleId } });
			const remainingRows = await first.labelSyncMutationAttempt.findMany({
				where: { userId: input.userId },
			});
			expect(remainingRule).not.toBeNull();
			expect(remainingRows).toHaveLength(1);
			expect(remainingRows[0]).toMatchObject({ status: "claimed", claimToken: "race-token" });
		} finally {
			await first.$disconnect();
			await second.$disconnect();
		}
	});

	it("fences account deletion against a concurrent send with a start barrier", async () => {
		if (!schemaUrl) return;
		const first = createClient();
		const second = createClient();
		try {
			const input = makeInput(`${Date.now()}_${Math.floor(Math.random() * 100000)}`, 9);
			await seedFixture(first, input);
			const repository = new JellyfinMutationRepository(first, { databaseProvider: "postgresql" });
			const claim = await repository.claim(input);
			expect(claim.kind).toBe("acquired");
			if (claim.kind !== "acquired") return;
			let releaseUserLock!: () => void;
			let userLockReached!: () => void;
			const userLockHeld = new Promise<void>((resolve) => {
				releaseUserLock = resolve;
			});
			const userLockReady = new Promise<void>((resolve) => {
				userLockReached = resolve;
			});
			let sendStarted!: () => void;
			const sendEntered = new Promise<void>((resolve) => {
				sendStarted = resolve;
			});
			const send = new JellyfinMutationRepository(
				stageClient(second, { onTransactionStart: sendStarted }),
				{ databaseProvider: "postgresql" },
			);
			const deletion = new JellyfinMutationRepository(
				stageClient(first, {
					onParentLock: async () => {
						userLockReached();
						await userLockHeld;
					},
				}),
				{ databaseProvider: "postgresql" },
			);
			const deletionPromise = deletion.deleteAccountGuarded({
				userId: input.userId,
				deleteParent: async (tx) => {
					await tx.user.delete({ where: { id: input.userId } });
				},
			});
			await userLockReady;
			const sendPromise = send.markSending({
				id: claim.id,
				userId: input.userId,
				ruleId: input.ruleId,
				destinationInstanceId: input.destinationInstanceId,
				activeOperationKey: claim.activeOperationKey,
				claimToken: claim.claimToken,
				sendAttemptCount: 0,
			});
			await sendEntered;
			const sendResult = await sendPromise;
			expect(sendResult).toEqual({ kind: "applied", status: "sending", sendAttemptCount: 1 });
			releaseUserLock();
			await expect(deletionPromise).rejects.toMatchObject({ category: "conflict" });
			await expect(first.user.findUnique({ where: { id: input.userId } })).resolves.not.toBeNull();
			await expect(
				first.labelSyncMutationAttempt.findUnique({ where: { id: claim.id } }),
			).resolves.toMatchObject({
				status: "sending",
				sendAttemptCount: 1,
				claimToken: claim.claimToken,
			});
		} finally {
			await first.$disconnect();
			await second.$disconnect();
		}
	});
});
