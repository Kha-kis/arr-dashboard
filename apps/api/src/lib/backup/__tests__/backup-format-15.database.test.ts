import { randomUUID } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupData } from "@arr/shared";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createArrServiceFingerprint } from "../../arr/service-fingerprint.js";
import { Encryptor } from "../../auth/encryption.js";
import { createSearchGrabRepository } from "../../search/grab-repository.js";
import type { SearchGrabTarget } from "../../search/grab-selector.js";
import { encryptBackupData } from "../backup-crypto.js";
import { exportDatabase, restoreDatabase, restorePreparedDatabase } from "../backup-database.js";
import { prepareRestoreData } from "../backup-restore-preparation.js";
import { openRestoreRuntime, type RestoreRuntime } from "../restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../runtime-schema-startup.js";

const engine = process.env.GRAB_REPOSITORY_TEST_ENGINE ?? "sqlite";
if (engine !== "sqlite" && engine !== "postgresql") throw new Error("Owned test engine required");
describe(`Grab backup on actual owned ${engine}`, () => {
	let runtime: RestoreRuntime;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	let owner: string;
	let target: SearchGrabTarget;
	let oldId: string;
	let successorId: string;
	let acknowledgedId: string;
	const source = new Encryptor("11".repeat(32)),
		destination = new Encryptor("22".repeat(32));
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	beforeAll(async () => {
		let url: string;
		if (engine === "postgresql") {
			const supplied = process.env.GRAB_REPOSITORY_TEST_URL;
			if (!supplied) throw new Error("Owned PostgreSQL fixture required");
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
				throw new Error("Owned loopback PostgreSQL fixture required");
			url = supplied;
		} else {
			const dir = await mkdtemp(join(tmpdir(), "arr-grab-backup-"));
			await chmod(dir, 0o700);
			const file = join(dir, "owned.db");
			new Database(file).close();
			await chmod(file, 0o600);
			url = `file:${file}`;
		}
		await synchronizeRuntimeSchema(url);
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination("synthetic-grab-backup");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
	}, 30000);
	beforeEach(async () =>
		run(async () => {
			// Freshly owned fixture only, never configured QA. Clear restrictive children first.
			await native.prisma.searchGrabClaim.deleteMany();
			await native.prisma.searchGrabAttempt.updateMany({ data: { predecessorId: null } });
			await native.prisma.searchGrabAttempt.deleteMany();
			await native.prisma.user.deleteMany();
			owner = randomUUID();
			await native.prisma.user.create({ data: { id: owner, username: `synthetic-${owner}` } });
			const key = source.encrypt("synthetic-provider-key"),
				instance = await native.prisma.serviceInstance.create({
					data: {
						userId: owner,
						service: "PROWLARR",
						label: "Synthetic",
						baseUrl: "http://127.0.0.1:1",
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				});
			target = {
				userId: owner,
				serviceInstanceId: instance.id,
				connectionFingerprint: createArrServiceFingerprint(instance),
				guid: "opaque:held-guid",
				indexerId: 7,
			};
			const repo = createSearchGrabRepository(native.prisma, runtime, source, owner),
				old = await repo.admit({ intentId: randomUUID(), target });
			oldId = old.attempt.id;
			await repo.claimDispatch(oldId);
			await repo.settle(oldId, "uncertain");
			const next = await repo.admit({
				intentId: randomUUID(),
				target,
				retry: { predecessorId: oldId, duplicateRiskConfirmed: true },
			});
			successorId = next.attempt.id;
			const acknowledged = await repo.admit({
				intentId: randomUUID(),
				target: { ...target, guid: "opaque:acknowledged-guid" },
			});
			acknowledgedId = acknowledged.attempt.id;
			await repo.claimDispatch(acknowledgedId);
			await repo.settle(acknowledgedId, "acknowledged");
		}),
	);
	afterAll(async () => {
		await native?.close();
		await runtime?.close();
	});
	async function snapshot() {
		// Supply real database rows as the Restore fixture independently of the
		// exporter under test. Its omission is asserted separately below.
		const data = await exportDatabase(native.prisma, {
			excludeOperationalHistory: true,
			historyRetentionLimit: 1,
		});
		return {
			...data,
			searchGrabAttempts: await native.prisma.searchGrabAttempt.findMany(),
			searchGrabClaims: await native.prisma.searchGrabClaim.findMany(),
		};
	}
	async function prepare(
		data: BackupData["data"],
		version = "1.5",
		key = "11".repeat(32),
		encryptor = destination,
	) {
		return prepareRestoreData({
			envelope: await encryptBackupData(
				JSON.stringify({
					version,
					appVersion: "2.24.2",
					timestamp: new Date().toISOString(),
					data,
					secrets: { encryptionKey: key, sessionCookieSecret: "synthetic-cookie" },
				}),
				"synthetic-password",
			),
			password: "synthetic-password",
			destination: { encryptor, installationId: "synthetic-grab-backup", stableForRestart: true },
		});
	}
	it("edge: refuses actual drift between root preflight and transaction", async () =>
		run(async () => {
			const prepared = await prepare(await snapshot()),
				repo = createSearchGrabRepository(native.prisma, runtime, source, owner);
			let injected = false;
			let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
			const barrier = new Proxy(native.prisma, {
				get(client, property) {
					if (property !== "$transaction") return Reflect.get(client, property, client);
					return async (...args: unknown[]) => {
						expect(injected).toBe(false);
						injected = true;
						await repo.admit({
							intentId: randomUUID(),
							target: { ...target, guid: "opaque:between-boundaries" },
						});
						expected = await snapshot();
						return Reflect.apply(client.$transaction, client, args);
					};
				},
			});
			await expect(
				restorePreparedDatabase(barrier, prepared, "synthetic-grab-backup"),
			).rejects.toThrow();
			expect(injected).toBe(true);
			expect(expected?.searchGrabAttempts).toHaveLength(4);
			expect(await snapshot()).toEqual(expected);
		}));
	it("edge: conserves the same original file after previous destination re-encryption", async () =>
		run(async () => {
			const original = await snapshot();
			await restorePreparedDatabase(
				native.prisma,
				await prepare(original),
				"synthetic-grab-backup",
			);
			await restorePreparedDatabase(
				native.prisma,
				await prepare(original),
				"synthetic-grab-backup",
			);
			const attempts = await native.prisma.searchGrabAttempt.findMany({ where: { userId: owner } }),
				claims = await native.prisma.searchGrabClaim.findMany({ where: { userId: owner } });
			expect(attempts).toHaveLength(3);
			expect(claims).toHaveLength(1);
			expect(claims[0]?.attemptId).toBe(successorId);
			expect(attempts.find((row) => row.id === oldId)).toMatchObject({
				state: "uncertain",
				workerEpoch: null,
			});
		}));
	it("edge: preserves stale held proof without promoting dispatch authority", async () =>
		run(async () => {
			await native.prisma.serviceInstance.updateMany({
				where: { id: target.serviceInstanceId, userId: owner },
				data: { baseUrl: "http://127.0.0.1:2" },
			});
			await restorePreparedDatabase(
				native.prisma,
				await prepare(await snapshot()),
				"synthetic-grab-backup",
			);
			const old = await native.prisma.searchGrabAttempt.findFirst({
					where: { id: oldId, userId: owner },
				}),
				claims = await native.prisma.searchGrabClaim.findMany({ where: { userId: owner } });
			expect(old).toMatchObject({
				connectionFingerprint: target.connectionFingerprint,
				state: "uncertain",
				workerEpoch: null,
			});
			expect(claims).toHaveLength(1);
			expect(claims[0]?.attemptId).toBe(successorId);
			const repo = createSearchGrabRepository(native.prisma, runtime, destination, owner);
			expect(await repo.claimDispatch(successorId)).toMatchObject({ admitted: false });
			await expect(repo.admit({ intentId: randomUUID(), target })).rejects.toMatchObject({
				category: "connection-unavailable",
			});
			expect(await native.prisma.searchGrabClaim.count({ where: { userId: owner } })).toBe(1);
		}));
	it("edge: cancelling a restored unsent retry preserves its uncertain predecessor hold", async () =>
		run(async () => {
			await restorePreparedDatabase(
				native.prisma,
				await prepare(await snapshot()),
				"synthetic-grab-backup",
			);
			const repo = createSearchGrabRepository(native.prisma, runtime, destination, owner);
			expect(await repo.recoverPreviousRuntime()).toEqual({ unsentRejected: 1, uncertain: 0 });
			const claims = await native.prisma.searchGrabClaim.findMany({ where: { userId: owner } });
			expect(claims).toHaveLength(1);
			expect(claims[0]?.attemptId).toBe(oldId);
			const instance = await native.prisma.serviceInstance.findFirst({
				where: { id: target.serviceInstanceId, userId: owner },
			});
			expect(instance).not.toBeNull();
			await expect(
				repo.admit({
					intentId: randomUUID(),
					target: { ...target, connectionFingerprint: createArrServiceFingerprint(instance!) },
				}),
			).rejects.toMatchObject({ category: "target-held" });
		}));
	it("edge: rejected retry retains predecessor uncertainty and admits one new explicit confirmation", async () =>
		run(async () => {
			const repo = createSearchGrabRepository(native.prisma, runtime, source, owner);
			await repo.claimDispatch(successorId);
			await repo.settle(successorId, "rejected", "provider-rejected");
			const rejected = await native.prisma.searchGrabAttempt.findFirst({
				where: { id: successorId, userId: owner },
			});
			expect(
				await repo.admit({
					intentId: rejected!.intentId,
					target,
					retry: { predecessorId: oldId, duplicateRiskConfirmed: true },
				}),
			).toMatchObject({ created: false, attempt: { state: "rejected" } });
			expect(await repo.claimDispatch(successorId)).toMatchObject({ admitted: false });
			const returned = await native.prisma.searchGrabClaim.findMany({ where: { userId: owner } });
			expect(returned).toHaveLength(1);
			expect(returned[0]?.attemptId).toBe(oldId);
			await expect(repo.admit({ intentId: randomUUID(), target })).rejects.toMatchObject({
				category: "target-held",
			});
			const confirmations = await Promise.allSettled(
				[0, 1].map(() =>
					repo.admit({
						intentId: randomUUID(),
						target,
						retry: { predecessorId: oldId, duplicateRiskConfirmed: true },
					}),
				),
			);
			expect(confirmations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const held = await native.prisma.searchGrabClaim.findMany({ where: { userId: owner } });
			expect(held).toHaveLength(1);
			expect(held[0]?.attemptId).not.toBe(oldId);
			const attempts = await native.prisma.searchGrabAttempt.findMany({ where: { userId: owner } });
			expect(attempts).toHaveLength(4);
			expect(attempts.filter((row) => row.predecessorId === oldId)).toHaveLength(2);
			await restorePreparedDatabase(
				native.prisma,
				await prepare(await snapshot()),
				"synthetic-grab-backup",
			);
			expect(await native.prisma.searchGrabClaim.findMany({ where: { userId: owner } })).toEqual(
				held.map((row) => ({ ...row, targetHash: expect.any(String) })),
			);
			expect(
				await native.prisma.searchGrabAttempt.findFirst({
					where: { id: successorId, userId: owner },
				}),
			).toMatchObject({ state: "rejected", predecessorId: oldId, workerEpoch: null });
		}));
	it("edge: rejected intermediate predecessor does not erase earlier uncertainty", async () =>
		run(async () => {
			const repo = createSearchGrabRepository(native.prisma, runtime, source, owner);
			await repo.claimDispatch(successorId);
			await repo.settle(successorId, "uncertain");
			const last = await repo.admit({
				intentId: randomUUID(),
				target,
				retry: { predecessorId: successorId, duplicateRiskConfirmed: true },
			});
			await repo.settle(successorId, "rejected", "provider-rejected");
			expect(
				await native.prisma.searchGrabClaim.findFirst({ where: { userId: owner } }),
			).toMatchObject({ attemptId: last.attempt.id });
			// The rejected intermediate still has an effective prepared descendant.
			await restorePreparedDatabase(
				native.prisma,
				await prepare(await snapshot()),
				"synthetic-grab-backup",
			);
			const restored = createSearchGrabRepository(native.prisma, runtime, destination, owner);
			expect(await restored.recoverPreviousRuntime()).toEqual({ unsentRejected: 1, uncertain: 0 });
			expect(await native.prisma.searchGrabClaim.findMany({ where: { userId: owner } })).toEqual([
				expect.objectContaining({ attemptId: oldId }),
			]);
			const exported = await snapshot();
			expect(exported.searchGrabAttempts).toHaveLength(4);
			await restorePreparedDatabase(
				native.prisma,
				await prepare(exported, "1.5", "22".repeat(32)),
				"synthetic-grab-backup",
			);
			expect(
				await native.prisma.searchGrabAttempt.findFirst({ where: { id: oldId, userId: owner } }),
			).toMatchObject({ state: "uncertain" });
		}));
	it("edge: malformed predecessor proof refuses cancellation without releasing the claim", async () =>
		run(async () => {
			await native.prisma.searchGrabAttempt.updateMany({
				where: { userId: owner, id: oldId },
				data: { connectionFingerprint: "f".repeat(64) },
			});
			await native.prisma.searchGrabAttempt.updateMany({
				where: { userId: owner, id: successorId },
				data: { workerEpoch: null },
			});
			const before = await snapshot(),
				repo = createSearchGrabRepository(native.prisma, runtime, source, owner);
			await expect(repo.recoverPreviousRuntime()).rejects.toMatchObject({
				category: "retry-invalid",
			});
			expect(await snapshot()).toEqual(before);
		}));
	it("edge: failed claim return rolls back cancellation and leaves the exact successor held", async () =>
		run(async () => {
			await native.prisma.searchGrabAttempt.updateMany({
				where: { userId: owner, id: successorId },
				data: { workerEpoch: null },
			});
			const before = await snapshot(),
				repo = createSearchGrabRepository(native.prisma, runtime, source, owner);
			if (engine === "postgresql") {
				await native.prisma.$executeRawUnsafe(
					"CREATE FUNCTION \"SyntheticGrabReturnFailureFn\"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic claim return failure'; END; $$ LANGUAGE plpgsql",
				);
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "SyntheticGrabReturnFailure" BEFORE UPDATE ON "SearchGrabClaim" FOR EACH ROW EXECUTE FUNCTION "SyntheticGrabReturnFailureFn"()',
				);
			} else
				await native.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "SyntheticGrabReturnFailure" BEFORE UPDATE ON "SearchGrabClaim" BEGIN SELECT RAISE(ABORT, \'synthetic claim return failure\'); END',
				);
			try {
				await expect(repo.recoverPreviousRuntime()).rejects.toThrow();
				expect(await snapshot()).toEqual(before);
			} finally {
				await native.prisma.$executeRawUnsafe(
					engine === "postgresql"
						? 'DROP TRIGGER "SyntheticGrabReturnFailure" ON "SearchGrabClaim"'
						: 'DROP TRIGGER "SyntheticGrabReturnFailure"',
				);
				if (engine === "postgresql")
					await native.prisma.$executeRawUnsafe('DROP FUNCTION "SyntheticGrabReturnFailureFn"()');
			}
		}));
	it("edge: a positive predecessor acknowledgement permits release on successor rejection", async () =>
		run(async () => {
			const repo = createSearchGrabRepository(native.prisma, runtime, source, owner);
			await repo.claimDispatch(successorId);
			await repo.settle(oldId, "acknowledged");
			await repo.settle(successorId, "rejected", "provider-rejected");
			expect(await native.prisma.searchGrabClaim.count({ where: { userId: owner } })).toBe(0);
			expect(
				await native.prisma.searchGrabAttempt.findFirst({ where: { userId: owner, id: oldId } }),
			).toMatchObject({ state: "acknowledged" });
			await restorePreparedDatabase(
				native.prisma,
				await prepare(await snapshot()),
				"synthetic-grab-backup",
			);
			expect(await native.prisma.searchGrabClaim.count({ where: { userId: owner } })).toBe(0);
		}));
	it("edge: backup refuses uncertainty without a hold after all successors rejected", async () =>
		run(async () => {
			const repo = createSearchGrabRepository(native.prisma, runtime, source, owner);
			await repo.claimDispatch(successorId);
			await repo.settle(successorId, "rejected", "provider-rejected");
			const before = await snapshot(),
				invalid = structuredClone(before);
			invalid.searchGrabClaims = [];
			await expect(prepare(invalid)).rejects.toThrow();
			expect(await snapshot()).toEqual(before);
		}));
	it("edge: backup refuses a second effective branch hidden behind rejected history", async () =>
		run(async () => {
			const repo = createSearchGrabRepository(native.prisma, runtime, source, owner);
			await repo.claimDispatch(successorId);
			await repo.settle(successorId, "uncertain");
			await repo.admit({
				intentId: randomUUID(),
				target,
				retry: { predecessorId: successorId, duplicateRiskConfirmed: true },
			});
			await repo.settle(successorId, "rejected", "provider-rejected");
			const old = await native.prisma.searchGrabAttempt.findFirst({
				where: { id: oldId, userId: owner },
			});
			expect(old).not.toBeNull();
			// Owned malformed fixture: an ACK sibling and a surviving descendant
			// cannot be two effective continuations of one predecessor.
			await native.prisma.searchGrabAttempt.create({
				data: {
					...old!,
					id: randomUUID(),
					intentId: randomUUID(),
					predecessorId: oldId,
					state: "acknowledged",
					outcomeCategory: null,
					completedAt: new Date(),
					updatedAt: new Date(),
				},
			});
			const before = await snapshot();
			await expect(prepare(before)).rejects.toThrow();
			expect(await snapshot()).toEqual(before);
		}));
	it("exports every attempt and hold despite the one-row history cap", async () =>
		run(async () => {
			const data = await exportDatabase(native.prisma, {
				excludeOperationalHistory: true,
				historyRetentionLimit: 1,
			});
			expect(data.searchGrabAttempts).toHaveLength(3);
			expect(data.searchGrabClaims).toHaveLength(1);
			expect(
				(data.searchGrabAttempts as Array<{ id: string }>).map((row) => row.id).sort(),
			).toEqual([oldId, successorId, acknowledgedId].sort());
		}));
	it("publishes translated records and predecessor links without dispatch authority", async () =>
		run(async () => {
			await restorePreparedDatabase(
				native.prisma,
				await prepare(await snapshot()),
				"synthetic-grab-backup",
			);
			const actual = await native.prisma.searchGrabAttempt.findMany({ where: { userId: owner } }),
				claims = await native.prisma.searchGrabClaim.findMany({ where: { userId: owner } });
			expect(actual).toHaveLength(3);
			expect(actual.every((row) => row.workerEpoch === null)).toBe(true);
			expect(actual.find((row) => row.id === successorId)?.predecessorId).toBe(oldId);
			expect(actual.find((row) => row.id === oldId)?.state).toBe("uncertain");
			expect(actual.find((row) => row.id === acknowledgedId)?.state).toBe("acknowledged");
			expect(claims).toHaveLength(1);
			expect(claims[0]?.attemptId).toBe(successorId);
			const repo = createSearchGrabRepository(native.prisma, runtime, destination, owner);
			expect(await repo.claimDispatch(successorId)).toMatchObject({ admitted: false });
		}));
	it("conserves translated evidence through a second representation migration", async () =>
		run(async () => {
			await restorePreparedDatabase(
				native.prisma,
				await prepare(await snapshot()),
				"synthetic-grab-backup",
			);
			const prepared = await prepare(
				await snapshot(),
				"1.5",
				"22".repeat(32),
				new Encryptor("44".repeat(32)),
			);
			await restorePreparedDatabase(native.prisma, prepared, "synthetic-grab-backup");
			expect(await native.prisma.searchGrabAttempt.count({ where: { userId: owner } })).toBe(3);
			expect(
				await native.prisma.searchGrabClaim.count({
					where: { userId: owner, attemptId: successorId },
				}),
			).toBe(1);
		}));
	it("refuses replacement omitting a current uncertain chain before deletion", async () =>
		run(async () => {
			const before = await snapshot(),
				incoming = structuredClone(before);
			Object.assign(incoming, { searchGrabAttempts: [], searchGrabClaims: [] });
			await expect(
				restorePreparedDatabase(native.prisma, await prepare(incoming), "synthetic-grab-backup"),
			).rejects.toThrow();
			expect(await snapshot()).toEqual(before);
		}));
	it("refuses loss of acknowledged history as well as active holds", async () =>
		run(async () => {
			const before = await snapshot(),
				incoming = structuredClone(before);
			incoming.searchGrabAttempts = incoming.searchGrabAttempts.filter(
				(row) => row.id !== acknowledgedId,
			);
			await expect(
				restorePreparedDatabase(native.prisma, await prepare(incoming), "synthetic-grab-backup"),
			).rejects.toThrow();
			expect(await snapshot()).toEqual(before);
		}));
	it("refuses a legacy replacement over current Grab evidence", async () =>
		run(async () => {
			const before = await snapshot(),
				incoming: BackupData["data"] = structuredClone(before);
			delete incoming.searchGrabAttempts;
			delete incoming.searchGrabClaims;
			await expect(
				restorePreparedDatabase(
					native.prisma,
					await prepare(incoming, "1.4"),
					"synthetic-grab-backup",
				),
			).rejects.toThrow();
			expect(await snapshot()).toEqual(before);
		}));
	it("refuses the unprepared helper when current Grab evidence exists", async () =>
		run(async () => {
			const before = await snapshot();
			await expect(restoreDatabase(native.prisma, before)).rejects.toThrow();
			expect(await snapshot()).toEqual(before);
		}));
	it("rolls back replacement when claim insertion fails", async () =>
		run(async () => {
			const before = await snapshot(),
				prepared = await prepare(before);
			if (engine === "sqlite")
				await native.prisma.$executeRawUnsafe(
					`CREATE TRIGGER grab_backup_fault BEFORE INSERT ON "SearchGrabClaim" BEGIN SELECT RAISE(ABORT, 'synthetic-insert-fault'); END`,
				);
			else {
				await native.prisma.$executeRawUnsafe(
					`CREATE FUNCTION grab_backup_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-insert-fault'; END $$`,
				);
				await native.prisma.$executeRawUnsafe(
					`CREATE TRIGGER grab_backup_fault BEFORE INSERT ON "SearchGrabClaim" FOR EACH ROW EXECUTE FUNCTION grab_backup_fault()`,
				);
			}
			try {
				await expect(
					restorePreparedDatabase(native.prisma, prepared, "synthetic-grab-backup"),
				).rejects.toThrow();
				expect(await snapshot()).toEqual(before);
			} finally {
				if (engine === "sqlite")
					await native.prisma.$executeRawUnsafe(`DROP TRIGGER grab_backup_fault`);
				else {
					await native.prisma.$executeRawUnsafe(
						`DROP TRIGGER grab_backup_fault ON "SearchGrabClaim"`,
					);
					await native.prisma.$executeRawUnsafe(`DROP FUNCTION grab_backup_fault()`);
				}
			}
		}));
	it("restores predecessor links independently of export row order", async () =>
		run(async () => {
			const incoming = await snapshot();
			incoming.searchGrabAttempts.reverse();
			await restorePreparedDatabase(
				native.prisma,
				await prepare(incoming),
				"synthetic-grab-backup",
			);
			expect(
				(
					await native.prisma.searchGrabAttempt.findFirst({
						where: { userId: owner, id: successorId },
					})
				)?.predecessorId,
			).toBe(oldId);
		}));
	it("rechecks newly admitted evidence after preparation", async () =>
		run(async () => {
			const prepared = await prepare(await snapshot()),
				repo = createSearchGrabRepository(native.prisma, runtime, source, owner);
			await repo.admit({
				intentId: randomUUID(),
				target: { ...target, guid: "opaque:newly-held-guid" },
			});
			const before = await snapshot();
			await expect(
				restorePreparedDatabase(native.prisma, prepared, "synthetic-grab-backup"),
			).rejects.toThrow();
			expect(await snapshot()).toEqual(before);
		}));
});
