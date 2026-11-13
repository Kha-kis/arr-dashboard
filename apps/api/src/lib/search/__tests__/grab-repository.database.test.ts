import { randomUUID } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createArrServiceFingerprint } from "../../arr/service-fingerprint.js";
import { Encryptor } from "../../auth/encryption.js";
import { openRestoreRuntime, type RestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import type { SearchGrabTarget } from "../grab-selector.js";

const engine = process.env.GRAB_REPOSITORY_TEST_ENGINE ?? "sqlite";
if (engine !== "sqlite" && engine !== "postgresql")
	throw new Error("Owned Grab test engine required.");

describe(`durable Grab repository on owned native ${engine}`, () => {
	let runtime: RestoreRuntime;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	let url: string;
	let userId: string;
	let target: SearchGrabTarget;
	const encryptor = new Encryptor("3".repeat(64));
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	async function repository() {
		const { createSearchGrabRepository } = await import("../grab-repository.js");
		return createSearchGrabRepository(native.prisma, runtime, encryptor, userId);
	}
	async function restart() {
		await native.close();
		await runtime.close();
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination("synthetic-grab-repository-destination");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
	}
	beforeAll(async () => {
		if (engine === "postgresql") {
			const supplied = process.env.GRAB_REPOSITORY_TEST_URL;
			if (!supplied) throw new Error("Owned PostgreSQL Grab fixture required.");
			const parsed = new URL(supplied);
			if (
				parsed.protocol !== "postgresql:" ||
				parsed.hostname !== "127.0.0.1" ||
				!parsed.port ||
				!/^arr_grab_[a-f0-9]{32}_test$/.test(parsed.username) ||
				parsed.pathname !== `/${parsed.username}` ||
				!parsed.password ||
				parsed.search ||
				parsed.hash
			)
				throw new Error("Owned loopback PostgreSQL Grab fixture required.");
			url = supplied;
		} else {
			const directory = await mkdtemp(join(tmpdir(), "arr-grab-repository-"));
			await chmod(directory, 0o700);
			const file = join(directory, "owned.db");
			new Database(file).close();
			await chmod(file, 0o600);
			url = `file:${file}`;
		}
		await synchronizeRuntimeSchema(url);
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination("synthetic-grab-repository-destination");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
	}, 30_000);
	beforeEach(async () => {
		userId = randomUUID();
		await run(async () => {
			await native.prisma.user.create({ data: { id: userId, username: `synthetic-${userId}` } });
			const key = encryptor.encrypt("synthetic-provider-key");
			const instance = await native.prisma.serviceInstance.create({
				data: {
					userId,
					service: "PROWLARR",
					label: "Synthetic",
					baseUrl: "http://127.0.0.1:1",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
			target = {
				userId,
				serviceInstanceId: instance.id,
				connectionFingerprint: createArrServiceFingerprint(instance),
				guid: "synthetic:exact-release",
				indexerId: 7,
			};
		});
	});
	afterAll(async () => {
		await native?.close();
		await runtime?.close();
		// Retain this uniquely created synthetic DB; uncertain closure never deletes evidence.
	});

	it("persists one encrypted attempt and observes the same intent without recreating its hold", async () => {
		await run(async () => {
			const repo = await repository();
			const intentId = randomUUID();
			const first = await repo.admit({ intentId, target });
			const replay = await repo.admit({ intentId, target });
			expect(first.created).toBe(true);
			expect(replay.created).toBe(false);
			expect(replay.attempt.id).toBe(first.attempt.id);
			expect(first.attempt.state).toBe("prepared");
			expect(first.attempt.dispatchedAt).toBeNull();
			expect(JSON.stringify(first.attempt)).not.toContain(target.guid);
			expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(1);
		});
	});
	it("refuses a different target under the same intent", async () => {
		await run(async () => {
			const repo = await repository();
			const intentId = randomUUID();
			await repo.admit({ intentId, target });
			await expect(
				repo.admit({ intentId, target: { ...target, guid: "synthetic:other-release" } }),
			).rejects.toMatchObject({ statusCode: 409 });
			expect(await native.prisma.searchGrabAttempt.count({ where: { userId } })).toBe(1);
		});
	});
	it("admits only one of two competing intents for the same exact target", async () => {
		const repo = await repository();
		const outcomes = await Promise.allSettled([
			run(() => repo.admit({ intentId: randomUUID(), target })),
			run(() => repo.admit({ intentId: randomUUID(), target })),
		]);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		await run(async () => {
			expect(await native.prisma.searchGrabAttempt.count({ where: { userId } })).toBe(1);
			expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(1);
		});
	}, 20_000);
	it("observes one intent during competing admission without duplicate attempts", async () => {
		const repo = await repository();
		const intentId = randomUUID();
		const outcomes = await Promise.all([
			run(() => repo.admit({ intentId, target })),
			run(() => repo.admit({ intentId, target })),
		]);
		expect(outcomes.filter((result) => result.created)).toHaveLength(1);
		expect(outcomes[0].attempt.id).toBe(outcomes[1].attempt.id);
		await run(async () => {
			expect(await native.prisma.searchGrabAttempt.count({ where: { userId } })).toBe(1);
			expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(1);
		});
	});
	it("holds identical provider tuples independently across owned instances", async () => {
		await run(async () => {
			const key = encryptor.encrypt("synthetic-provider-key");
			const second = await native.prisma.serviceInstance.create({
				data: {
					userId,
					service: "PROWLARR",
					label: "Synthetic second",
					baseUrl: "http://127.0.0.1:2",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
			const repo = await repository();
			const first = await repo.admit({ intentId: randomUUID(), target });
			const other = await repo.admit({
				intentId: randomUUID(),
				target: {
					...target,
					serviceInstanceId: second.id,
					connectionFingerprint: createArrServiceFingerprint(second),
				},
			});
			expect(first.attempt.targetHash).not.toBe(other.attempt.targetHash);
			expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(2);
		});
	});
	it("rejects stale connection proof at admission and marker without losing its hold", async () => {
		await run(async () => {
			const repo = await repository();
			const { attempt } = await repo.admit({ intentId: randomUUID(), target });
			await native.prisma.serviceInstance.updateMany({
				where: { userId, id: target.serviceInstanceId },
				data: { baseUrl: "http://127.0.0.1:3" },
			});
			await expect(repo.admit({ intentId: randomUUID(), target })).rejects.toMatchObject({
				category: "connection-unavailable",
			});
			await expect(repo.claimDispatch(attempt.id)).rejects.toMatchObject({
				category: "connection-unavailable",
			});
			expect((await repo.findByIntent(attempt.intentId))?.dispatchedAt).toBeNull();
			expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(1);
		});
	});
	it("transfers an uncertain predecessor claim to exactly one competing confirmation", async () => {
		const repo = await repository();
		const old = await run(() => repo.admit({ intentId: randomUUID(), target }));
		await run(() => repo.claimDispatch(old.attempt.id));
		await run(() => repo.settle(old.attempt.id, "uncertain"));
		const outcomes = await Promise.allSettled(
			[0, 1].map(() =>
				run(() =>
					repo.admit({
						intentId: randomUUID(),
						target,
						retry: { predecessorId: old.attempt.id, duplicateRiskConfirmed: true },
					}),
				),
			),
		);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		await run(async () => {
			const held = await native.prisma.searchGrabClaim.findFirst({ where: { userId } });
			expect(held?.attemptId).not.toBe(old.attempt.id);
			expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(1);
			expect(await native.prisma.searchGrabAttempt.count({ where: { userId } })).toBe(2);
			expect((await repo.findByIntent(old.attempt.intentId))?.state).toBe("uncertain");
		});
	});
	it("sets the durable send marker exactly once and never treats a marker replay as dispatch permission", async () => {
		await run(async () => {
			const repo = await repository();
			const { attempt } = await repo.admit({ intentId: randomUUID(), target });
			const first = await repo.claimDispatch(attempt.id);
			const second = await repo.claimDispatch(attempt.id);
			expect(first.admitted).toBe(true);
			expect(first.attempt.state).toBe("submitting");
			expect(first.attempt.dispatchedAt).toBeInstanceOf(Date);
			expect(second.admitted).toBe(false);
			expect(second.attempt.dispatchedAt).toEqual(first.attempt.dispatchedAt);
		});
	});
	if (engine === "postgresql") {
		it.each([
			{ sqlState: "40001", calls: 3 },
			{ sqlState: "P0001", calls: 1 },
		])(
			"bounds admission rollback retries for PostgreSQL $sqlState to $calls attempts",
			async ({ sqlState, calls }) => {
				await run(async () => {
					await native.prisma.$executeRawUnsafe('CREATE SEQUENCE "SyntheticGrabAdmissionCalls"');
					await native.prisma.$executeRawUnsafe(
						`CREATE FUNCTION "SyntheticGrabAdmissionFailureFn"() RETURNS trigger AS $$ BEGIN PERFORM nextval('"SyntheticGrabAdmissionCalls"'); RAISE EXCEPTION 'synthetic admission failure' USING ERRCODE = '${sqlState}'; END; $$ LANGUAGE plpgsql`,
					);
					await native.prisma.$executeRawUnsafe(
						'CREATE TRIGGER "SyntheticGrabAdmissionFailure" BEFORE UPDATE ON "ServiceInstance" FOR EACH ROW EXECUTE FUNCTION "SyntheticGrabAdmissionFailureFn"()',
					);
					try {
						const repo = await repository();
						await expect(repo.admit({ intentId: randomUUID(), target })).rejects.toMatchObject({
							code: "P2010",
						});
						const observed = await native.prisma.$queryRawUnsafe<Array<{ last_value: bigint }>>(
							'SELECT last_value FROM "SyntheticGrabAdmissionCalls"',
						);
						expect(observed).toEqual([{ last_value: BigInt(calls) }]);
						expect(await native.prisma.searchGrabAttempt.count({ where: { userId } })).toBe(0);
						expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(0);
					} finally {
						await native.prisma.$executeRawUnsafe(
							'DROP TRIGGER "SyntheticGrabAdmissionFailure" ON "ServiceInstance"',
						);
						await native.prisma.$executeRawUnsafe(
							'DROP FUNCTION "SyntheticGrabAdmissionFailureFn"()',
						);
						await native.prisma.$executeRawUnsafe('DROP SEQUENCE "SyntheticGrabAdmissionCalls"');
					}
				});
			},
		);
	}
	it("keeps an uncertain target held regardless of age and restricts connection deletion", async () => {
		await run(async () => {
			const repo = await repository();
			const { attempt } = await repo.admit({ intentId: randomUUID(), target });
			await repo.claimDispatch(attempt.id);
			await repo.settle(attempt.id, "uncertain", "transport-unconfirmed");
			await native.prisma.searchGrabAttempt.updateMany({
				where: { userId, id: attempt.id },
				data: { requestedAt: new Date("2000-01-01T00:00:00Z") },
			});
			await expect(repo.admit({ intentId: randomUUID(), target })).rejects.toMatchObject({
				statusCode: 409,
			});
			await expect(
				native.prisma.serviceInstance.deleteMany({
					where: { userId, id: target.serviceInstanceId },
				}),
			).rejects.toThrow();
			expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(1);
		});
	});
	it.each(["acknowledged", "rejected"] as const)(
		"atomically persists %s before releasing only its exact claim",
		async (state) => {
			await run(async () => {
				const repo = await repository();
				const intentId = randomUUID();
				const { attempt } = await repo.admit({ intentId, target });
				await repo.claimDispatch(attempt.id);
				expect((await repo.settle(attempt.id, state)).state).toBe(state);
				expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(0);
				expect((await repo.admit({ intentId, target })).created).toBe(false);
			});
		},
	);
	it("requires explicit identical-target confirmation and preserves a successor claim on late completion", async () => {
		await run(async () => {
			const repo = await repository();
			const { attempt: old } = await repo.admit({ intentId: randomUUID(), target });
			await repo.claimDispatch(old.id);
			await repo.settle(old.id, "uncertain", "transport-unconfirmed");
			await expect(
				repo.admit({
					intentId: randomUUID(),
					target,
					retry: { predecessorId: old.id, duplicateRiskConfirmed: false },
				}),
			).rejects.toMatchObject({ statusCode: 409 });
			await expect(
				repo.admit({
					intentId: randomUUID(),
					target: { ...target, guid: "synthetic:wrong-target" },
					retry: { predecessorId: old.id, duplicateRiskConfirmed: true },
				}),
			).rejects.toMatchObject({ statusCode: 409 });
			const intentId = randomUUID();
			const next = await repo.admit({
				intentId,
				target,
				retry: { predecessorId: old.id, duplicateRiskConfirmed: true },
			});
			expect(
				(
					await repo.admit({
						intentId,
						target,
						retry: { predecessorId: old.id, duplicateRiskConfirmed: true },
					})
				).created,
			).toBe(false);
			await repo.claimDispatch(next.attempt.id);
			await repo.settle(old.id, "acknowledged");
			const held = await native.prisma.searchGrabClaim.findFirst({ where: { userId } });
			expect(held?.attemptId).toBe(next.attempt.id);
			expect((await repo.findByIntent(intentId))?.state).toBe("submitting");
		});
	});
	it("does not send a prepared successor once its predecessor acknowledgement becomes known", async () => {
		await run(async () => {
			const repo = await repository();
			const { attempt: old } = await repo.admit({ intentId: randomUUID(), target });
			await repo.claimDispatch(old.id);
			await repo.settle(old.id, "uncertain");
			const { attempt: next } = await repo.admit({
				intentId: randomUUID(),
				target,
				retry: { predecessorId: old.id, duplicateRiskConfirmed: true },
			});
			await repo.settle(old.id, "acknowledged");
			const decision = await repo.claimDispatch(next.id);
			expect(decision.admitted).toBe(false);
			expect(decision.attempt.state).toBe("rejected");
			expect(decision.attempt.dispatchedAt).toBeNull();
		});
	});
	it("checks current enabled connection binding before marking dispatch", async () => {
		await run(async () => {
			const repo = await repository();
			const { attempt } = await repo.admit({ intentId: randomUUID(), target });
			await native.prisma.serviceInstance.updateMany({
				where: { userId, id: target.serviceInstanceId },
				data: { enabled: false },
			});
			await expect(repo.claimDispatch(attempt.id)).rejects.toThrow();
			expect((await repo.findByIntent(attempt.intentId))?.dispatchedAt).toBeNull();
		});
	});
	it("scopes status and admission to the server-owned user", async () => {
		await run(async () => {
			const repo = await repository();
			const intentId = randomUUID();
			await repo.admit({ intentId, target });
			const { createSearchGrabRepository } = await import("../grab-repository.js");
			const other = createSearchGrabRepository(native.prisma, runtime, encryptor, randomUUID());
			expect(await other.findByIntent(intentId)).toBeNull();
			await expect(other.admit({ intentId: randomUUID(), target })).rejects.toThrow();
		});
	});

	it("rolls back acknowledgement and retains the send marker when claim-release persistence fails", async () => {
		await run(async () => {
			const repo = await repository();
			const intentId = randomUUID();
			const { attempt } = await repo.admit({ intentId, target });
			await repo.claimDispatch(attempt.id);
			if (engine === "postgresql") {
				await native.prisma.$executeRawUnsafe(
					"CREATE FUNCTION \"SyntheticGrabReleaseFailureFn\"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic claim release failure'; END; $$ LANGUAGE plpgsql",
				);
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "SyntheticGrabReleaseFailure" BEFORE DELETE ON "SearchGrabClaim" FOR EACH ROW EXECUTE FUNCTION "SyntheticGrabReleaseFailureFn"()',
				);
			} else {
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "SyntheticGrabReleaseFailure" BEFORE DELETE ON "SearchGrabClaim" BEGIN SELECT RAISE(ABORT, \'synthetic claim release failure\'); END',
				);
			}
			try {
				await expect(repo.settle(attempt.id, "acknowledged")).rejects.toThrow();
				expect((await repo.findByIntent(intentId))?.state).toBe("submitting");
				expect(
					await native.prisma.searchGrabClaim.count({ where: { userId, attemptId: attempt.id } }),
				).toBe(1);
			} finally {
				await native.prisma.$executeRawUnsafe(
					engine === "postgresql"
						? 'DROP TRIGGER "SyntheticGrabReleaseFailure" ON "SearchGrabClaim"'
						: 'DROP TRIGGER "SyntheticGrabReleaseFailure"',
				);
				if (engine === "postgresql")
					await native.prisma.$executeRawUnsafe('DROP FUNCTION "SyntheticGrabReleaseFailureFn"()');
			}
		});
	});
	it("keeps live-epoch work and recovers only old markers without granting replay", async () => {
		let unsentId: string;
		let sentId: string;
		await run(async () => {
			const repo = await repository();
			const unsent = await repo.admit({ intentId: randomUUID(), target });
			unsentId = unsent.attempt.id;
			const sent = await repo.admit({
				intentId: randomUUID(),
				target: { ...target, guid: "synthetic:second-release" },
			});
			sentId = sent.attempt.id;
			await repo.claimDispatch(sentId);
			expect(await repo.recoverPreviousRuntime()).toEqual({ unsentRejected: 0, uncertain: 0 });
		});
		await restart();
		await run(async () => {
			const repo = await repository();
			expect(await repo.recoverPreviousRuntime()).toEqual({ unsentRejected: 1, uncertain: 1 });
			expect(
				await native.prisma.searchGrabAttempt.findFirst({ where: { userId, id: unsentId! } }),
			).toMatchObject({ state: "rejected", dispatchedAt: null });
			expect(
				await native.prisma.searchGrabAttempt.findFirst({ where: { userId, id: sentId! } }),
			).toMatchObject({ state: "uncertain" });
			expect(await native.prisma.searchGrabClaim.findMany({ where: { userId } })).toHaveLength(1);
			expect((await repo.claimDispatch(sentId!)).admitted).toBe(false);
		});
	});

	it("recovers all prior unsent attempts beyond a bounded first batch", async () => {
		await run(async () => {
			const encrypted = encryptor.encrypt(
				JSON.stringify({
					purpose: "arr-dashboard:search-grab-target",
					version: 1,
					guid: "synthetic:batch",
					indexerId: 7,
				}),
			);
			const rows = Array.from({ length: 102 }, (_, i) => ({
				id: randomUUID(),
				userId,
				intentId: randomUUID(),
				serviceInstanceId: target.serviceInstanceId,
				connectionFingerprint: target.connectionFingerprint,
				targetHash: i.toString(16).padStart(64, "0"),
				encryptedTarget: encrypted.value,
				targetIv: encrypted.iv,
				workerEpoch: "synthetic-prior-runtime",
			}));
			await native.prisma.searchGrabAttempt.createMany({ data: rows });
			await native.prisma.searchGrabClaim.createMany({
				data: rows.map((row) => ({
					userId,
					serviceInstanceId: row.serviceInstanceId,
					targetHash: row.targetHash,
					attemptId: row.id,
				})),
			});
			const repo = await repository();
			expect(await repo.recoverPreviousRuntime()).toEqual({ unsentRejected: 102, uncertain: 0 });
			expect(
				await native.prisma.searchGrabAttempt.count({
					where: { userId, state: "rejected", dispatchedAt: null },
				}),
			).toBe(102);
			expect(await native.prisma.searchGrabClaim.count({ where: { userId } })).toBe(0);
		});
	}, 20_000);
});
